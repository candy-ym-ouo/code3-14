import { Alert, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Tag, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIGHT_LEVELS } from '@balcony/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony } from '../api/types';

export function BalconiesPage() {
  const { workspaceId } = useAuth();
  const queryClient = useQueryClient();
  const [balconyOpen, setBalconyOpen] = useState(false);
  const [zoneBalcony, setZoneBalcony] = useState<Balcony | null>(null);
  const [balconyForm] = Form.useForm();
  const [zoneForm] = Form.useForm();
  const query = useQuery({
    queryKey: ['balconies', workspaceId],
    queryFn: async () => (await api.get<Balcony[]>('/balconies', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;

  const saveBalcony = async (values: Record<string, unknown>) => {
    try {
      await api.post('/balconies', { workspaceId, ...values });
      setBalconyOpen(false);
      balconyForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['balconies'] });
      message.success('阳台已创建');
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const saveZone = async (values: Record<string, unknown>) => {
    if (!zoneBalcony) return;
    try {
      await api.post(`/balconies/${zoneBalcony.id}/zones`, { ...values, sortOrder: zoneBalcony.zones.length });
      setZoneBalcony(null);
      zoneForm.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['balconies'] });
      message.success('位置已创建');
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <div><Typography.Title level={2} style={{ margin: 0 }}>阳台与位置</Typography.Title><Typography.Text type="secondary">位置是曲线和比较的真实维度。</Typography.Text></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setBalconyOpen(true)}>新建阳台</Button>
      </Space>
      {query.data?.length ? (
        <Row gutter={[16, 16]}>
          {query.data.map((balcony) => (
            <Col xs={24} lg={12} key={balcony.id}>
              <Card
                title={balcony.name}
                extra={<Button onClick={() => setZoneBalcony(balcony)} icon={<PlusOutlined />}>添加位置</Button>}
              >
                <Space wrap style={{ marginBottom: 16 }}>
                  {balcony.orientation ? <Tag>朝向 {balcony.orientation}</Tag> : null}
                  {balcony.floor !== null && balcony.floor !== undefined ? <Tag>{balcony.floor} 层</Tag> : null}
                </Space>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {balcony.zones.map((zone) => (
                    <Card key={zone.id} size="small">
                      <Typography.Text strong>{zone.name}</Typography.Text>
                      {zone.description ? <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>{zone.description}</Typography.Paragraph> : null}
                    </Card>
                  ))}
                  {balcony.zones.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有位置" /> : null}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      ) : <Card><Empty description="尚无阳台" /></Card>}

      <Modal title="新建阳台" open={balconyOpen} onCancel={() => setBalconyOpen(false)} onOk={() => balconyForm.submit()} destroyOnClose>
        <Form form={balconyForm} layout="vertical" onFinish={saveBalcony}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="orientation" label="朝向"><Input /></Form.Item>
          <Form.Item name="floor" label="楼层"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal title={`添加位置 · ${zoneBalcony?.name ?? ''}`} open={Boolean(zoneBalcony)} onCancel={() => setZoneBalcony(null)} onOk={() => zoneForm.submit()} destroyOnClose>
        <Form form={zoneForm} layout="vertical" onFinish={saveZone}>
          <Form.Item name="name" label="位置名称" rules={[{ required: true }]}><Input placeholder="东侧栏杆" /></Form.Item>
          <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="sunExposure" label="通常光照"><Select allowClear options={LIGHT_LEVELS.map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="heightCm" label="高度 cm"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="azimuthDegrees" label="方位角"><InputNumber min={0} max={359} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
