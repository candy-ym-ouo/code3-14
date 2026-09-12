import { Alert, Button, Card, DatePicker, Form, Input, Select, Space, Typography, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ACTION_TYPES } from '@balcony/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { ActionLog, Balcony, Plant } from '../api/types';

type ActionForm = {
  balconyId: string;
  zoneId?: string;
  plantId?: string;
  actionType: string;
  title: string;
  startedAt: Dayjs;
  notes?: string;
};

const actionLabels: Record<string, string> = {
  SHADE: '遮阳',
  WATER: '浇水',
  REPOT: '换盆',
  MOVE: '搬动',
  FERTILIZE: '施肥',
  PRUNE: '修剪',
  CUSTOM: '自定义',
};

export function ActionPage() {
  const { workspaceId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ActionForm>();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const selectedBalconyId = Form.useWatch('balconyId', form);
  const selectedZoneId = Form.useWatch('zoneId', form);
  const selectedActionType = Form.useWatch('actionType', form);
  const balconies = useQuery({
    queryKey: ['balconies', workspaceId],
    queryFn: async () => (await api.get<Balcony[]>('/balconies', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const plants = useQuery({
    queryKey: ['plants', workspaceId],
    queryFn: async () => (await api.get<Plant[]>('/plants', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  useEffect(() => {
    form.resetFields();
  }, [workspaceId, form]);
  const selectedBalcony = balconies.data?.find((item) => item.id === selectedBalconyId);
  const availablePlants = plants.data?.filter((plant) => {
    const inSelectedBalcony = selectedBalcony?.zones.some((zone) => zone.id === plant.zoneId) ?? false;
    if (selectedActionType === 'MOVE') return true;
    return selectedZoneId ? plant.zoneId === selectedZoneId : inSelectedBalcony;
  }) ?? [];

  const submit = async (values: ActionForm) => {
    if (!workspaceId) return;
    setSubmitting(true);
    try {
      const action = await api.post<ActionLog>('/actions', {
        workspaceId,
        balconyId: values.balconyId,
        zoneId: values.zoneId ?? null,
        plantId: values.plantId ?? null,
        actionType: values.actionType,
        title: values.title,
        startedAt: values.startedAt.toISOString(),
        completedAt: values.startedAt.toISOString(),
        parameters: {},
        notes: values.notes ?? null,
        clientRequestId: crypto.randomUUID(),
      });
      const file = files[0]?.originFileObj;
      let photoError: string | null = null;
      if (file) {
        try {
          const data = new FormData();
          data.append('workspaceId', workspaceId);
          data.append('actionLogId', action.data.id);
          data.append('capturedAt', values.startedAt.toISOString());
          data.append('file', file);
          await api.post('/photos/upload', data);
        } catch (uploadError) {
          photoError = errorMessage(uploadError);
        }
      }
      if (photoError) {
        message.warning(`操作记录已保存，但照片上传失败：${photoError}`);
      } else {
        message.success('操作记录已保存');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['actions'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      navigate('/insights');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  return (
    <Card title="记录一次真实干预">
      <Typography.Paragraph type="secondary">记录遮阳、浇水或换盆时间，之后可在数据洞察中使用前后窗口比较。</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ startedAt: dayjs(), actionType: 'WATER' }}
        onFinish={submit}
        onValuesChange={(changed) => {
          if ('balconyId' in changed) {
            form.setFieldsValue({ zoneId: undefined, plantId: undefined });
          } else if ('zoneId' in changed && form.getFieldValue('actionType') !== 'MOVE') {
            form.setFieldValue('plantId', undefined);
          }
        }}
      >
        <Space size="large" wrap align="start">
          <Form.Item name="balconyId" label="阳台" rules={[{ required: true }]} style={{ minWidth: 220 }}>
            <Select options={balconies.data?.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item name="zoneId" label="位置（可选）" rules={selectedActionType === 'MOVE' ? [{ required: true, message: '搬动操作必须选择目标位置' }] : []} style={{ minWidth: 220 }}>
            <Select allowClear options={selectedBalcony?.zones.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item name="plantId" label="植物（可选）" rules={selectedActionType === 'MOVE' ? [{ required: true, message: '搬动操作必须选择植物' }] : []} style={{ minWidth: 220 }}>
            <Select allowClear options={availablePlants.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
        </Space>
        <Space size="large" wrap align="start">
          <Form.Item name="actionType" label="操作类型" rules={[{ required: true }]}>
            <Select style={{ width: 180 }} options={ACTION_TYPES.map((value) => ({ value, label: actionLabels[value] }))} />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input style={{ width: 300 }} placeholder="例如：给绿萝浇透水" />
          </Form.Item>
          <Form.Item name="startedAt" label="执行时间" rules={[{ required: true }]}>
            <DatePicker showTime />
          </Form.Item>
        </Space>
        <Form.Item name="notes" label="参数与备注">
          <Input.TextArea rows={3} maxLength={3000} showCount placeholder="可记录用水量、花盆尺寸、遮阳方式等" />
        </Form.Item>
        <Form.Item label="操作照片（可选）">
          <Upload
            accept="image/jpeg,image/png,image/webp,image/heic,image/avif"
            maxCount={1}
            beforeUpload={() => false}
            fileList={files}
            onChange={({ fileList }) => setFiles(fileList)}
          >
            <Button icon={<UploadOutlined />}>选择照片</Button>
          </Upload>
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>保存操作</Button>
      </Form>
    </Card>
  );
}
