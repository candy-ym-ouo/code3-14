import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony, Plant } from '../api/types';

export function PlantsPage() {
  const { workspaceId } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const plants = useQuery({
    queryKey: ['plants', workspaceId],
    queryFn: async () => (await api.get<Plant[]>('/plants', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const balconies = useQuery({
    queryKey: ['balconies', workspaceId],
    queryFn: async () => (await api.get<Balcony[]>('/balconies', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const zones = balconies.data?.flatMap((balcony) => balcony.zones.map((zone) => ({ ...zone, balconyName: balcony.name }))) ?? [];

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;

  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <div><Typography.Title level={2} style={{ margin: 0 }}>植物</Typography.Title><Typography.Text type="secondary">观察记录会同步更新植物的最新状态。</Typography.Text></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)} disabled={zones.length === 0}>添加植物</Button>
      </Space>
      <Card>
        <Table
          rowKey="id"
          loading={plants.isLoading}
          dataSource={plants.data ?? []}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '品种', render: (_, plant) => [plant.species, plant.variety].filter(Boolean).join(' · ') || '-' },
            { title: '当前位置', render: (_, plant) => plant.zone?.name ?? '-' },
            { title: '状态', dataIndex: 'status', render: (status) => <Tag color={status === 'HEALTHY' ? 'green' : status === 'CRITICAL' ? 'red' : 'orange'}>{status}</Tag> },
          ]}
          pagination={false}
        />
      </Card>
      <Modal title="添加植物" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnClose>
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            try {
              await api.post('/plants', { workspaceId, ...values, acquiredAt: new Date().toISOString() });
              setOpen(false);
              form.resetFields();
              await queryClient.invalidateQueries({ queryKey: ['plants'] });
              message.success('植物已添加');
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Form.Item name="zoneId" label="当前位置" rules={[{ required: true }]}>
            <Select options={zones.map((zone) => ({ value: zone.id, label: `${zone.balconyName} · ${zone.name}` }))} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="例如：绿萝" /></Form.Item>
          <Form.Item name="species" label="物种"><Input /></Form.Item>
          <Form.Item name="variety" label="品种"><Input /></Form.Item>
          <Form.Item name="potSizeCm" label="花盆直径 cm"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
