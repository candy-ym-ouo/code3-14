import { Alert, Button, Card, Form, Input, InputNumber, Select, Steps, Typography, message } from 'antd';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LIGHT_LEVELS } from '@balcony/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony } from '../api/types';

export function OnboardingPage() {
  const { workspaceId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [balcony, setBalcony] = useState<Balcony | null>(null);
  const [step, setStep] = useState(0);

  if (!workspaceId) return <Alert type="warning" showIcon message="尚未创建记录空间" />;

  return (
    <Card title="首次配置" style={{ maxWidth: 760, margin: '0 auto' }}>
      <Steps current={step} items={[{ title: '创建阳台' }, { title: '添加位置' }, { title: '完成' }]} style={{ marginBottom: 28 }} />
      {step === 0 ? (
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              const response = await api.post<Balcony>('/balconies', { workspaceId, ...values });
              setBalcony(response.data);
              setStep(1);
              await queryClient.invalidateQueries({ queryKey: ['balconies'] });
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Typography.Paragraph type="secondary">请填写真实阳台名称。系统不会自动创建虚构位置。</Typography.Paragraph>
          <Form.Item name="name" label="阳台名称" rules={[{ required: true }]}><Input placeholder="例如：家中南阳台" /></Form.Item>
          <Form.Item name="orientation" label="朝向"><Input placeholder="例如：南、东南" /></Form.Item>
          <Form.Item name="floor" label="楼层"><InputNumber min={-10} max={200} style={{ width: '100%' }} /></Form.Item>
          <Button type="primary" htmlType="submit">创建并继续</Button>
        </Form>
      ) : null}
      {step === 1 && balcony ? (
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              await api.post(`/balconies/${balcony.id}/zones`, { ...values, sortOrder: 0 });
              setStep(2);
              await queryClient.invalidateQueries({ queryKey: ['balconies'] });
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Typography.Paragraph type="secondary">位置后续可以继续添加，例如东侧、西侧、栏杆内侧。</Typography.Paragraph>
          <Form.Item name="name" label="第一个位置" rules={[{ required: true }]}><Input placeholder="例如：东侧栏杆" /></Form.Item>
          <Form.Item name="description" label="位置说明"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="sunExposure" label="通常光照">
            <Select allowClear options={LIGHT_LEVELS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Button type="primary" htmlType="submit">完成配置</Button>
        </Form>
      ) : null}
      {step === 2 ? (
        <div className="page-stack">
          <Alert type="success" showIcon message="真实空间已创建" description="现在可以记录第一条环境观察或添加植物。" />
          <div>
            <Button type="primary" onClick={() => navigate('/record/new')}>记录环境</Button>
            <Button style={{ marginLeft: 12 }} onClick={() => navigate('/plants')}>添加植物</Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
