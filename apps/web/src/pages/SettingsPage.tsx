import { Alert, Button, Card, Form, Input, List, Modal, Space, Typography, message } from 'antd';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

type ExportJob = {
  id: string;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
};

export function SettingsPage() {
  const { user, refresh, logout } = useAuth();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteForm] = Form.useForm();
  const exports = useQuery({
    queryKey: ['exports'],
    queryFn: async () => (await api.get<ExportJob[]>('/users/me/exports')).data,
  });

  return (
    <div className="page-stack">
      <Typography.Title level={2} style={{ margin: 0 }}>设置</Typography.Title>
      <Card title="个人资料">
        <Form
          layout="vertical"
          initialValues={{ displayName: user?.displayName, timezone: user?.timezone }}
          onFinish={async (values) => {
            try {
              await api.patch('/users/me', values);
              await refresh();
              message.success('设置已保存');
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Form.Item name="displayName" label="称呼" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="timezone" label="时区" rules={[{ required: true }]}><Input placeholder="Asia/Shanghai" /></Form.Item>
          <Button type="primary" htmlType="submit">保存设置</Button>
        </Form>
      </Card>
      <Card title="数据导出">
        <Alert type="info" showIcon message="导出为真实 JSON 与 CSV 压缩包，下载链接有效期 10 分钟。" style={{ marginBottom: 16 }} />
        <Button
          onClick={async () => {
            try {
              await api.post('/users/me/export');
              await queryClient.invalidateQueries({ queryKey: ['exports'] });
              message.success('导出任务已创建');
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          创建导出任务
        </Button>
        <List
          style={{ marginTop: 16 }}
          dataSource={exports.data ?? []}
          renderItem={(item) => (
            <List.Item
              actions={item.status === 'READY' ? [
                <Button key="download" type="link" onClick={async () => {
                  try {
                    const response = await api.get<{ url: string }>(`/users/me/exports/${item.id}/download`);
                    window.location.href = response.data.url;
                  } catch (error) {
                    message.error(errorMessage(error));
                  }
                }}>下载</Button>,
              ] : []}
            >
              <List.Item.Meta title={`导出任务 ${item.id.slice(-8)}`} description={`${new Date(item.createdAt).toLocaleString('zh-CN')} · ${item.status}`} />
            </List.Item>
          )}
        />
      </Card>
      <Card title="账号删除">
        <Alert type="warning" showIcon message="删除后有 7 天冷静期；到期将删除业务数据和对象存储照片。" style={{ marginBottom: 16 }} />
        <Space>
          {user?.status === 'DELETING' ? (
            <Button onClick={async () => {
              try {
                await api.post('/users/me/delete/cancel');
                await refresh();
                message.success('删除申请已撤销');
              } catch (error) {
                message.error(errorMessage(error));
              }
            }}>撤销删除申请</Button>
          ) : (
            <Button danger onClick={() => setDeleteOpen(true)}>申请删除账号</Button>
          )}
        </Space>
      </Card>
      <Modal
        title="确认删除账号"
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onOk={() => deleteForm.submit()}
      >
        <Form
          form={deleteForm}
          layout="vertical"
          onFinish={async ({ confirm, password }) => {
            try {
              await api.delete('/users/me', { data: { confirm, password } });
              setDeleteOpen(false);
              message.success('已进入 7 天删除冷静期');
              await logout();
              window.location.href = '/login';
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Typography.Paragraph>请输入 DELETE 确认。冷静期内可以重新登录并撤销。</Typography.Paragraph>
          <Form.Item name="confirm" label="确认文字" rules={[{ required: true, pattern: /^DELETE$/ }]}><Input /></Form.Item>
          <Form.Item name="password" label="当前密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
