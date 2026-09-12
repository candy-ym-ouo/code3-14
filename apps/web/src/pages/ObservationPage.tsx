import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Select, Space, Typography, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LIGHT_LEVELS, PLANT_STATUSES, WIND_DIRECTIONS } from '@balcony/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony, Observation, Plant } from '../api/types';

type ObservationForm = {
  balconyId: string;
  zoneId: string;
  plantId?: string;
  observedAt: Dayjs;
  temperatureC: number;
  lightLevel: string;
  lux?: number;
  windDirection: string;
  windDegrees?: number;
  windSpeedMps?: number;
  plantStatus: string;
  plantTags?: string[];
  soilMoisturePct?: number;
  soilMoistureSource?: string;
  notes?: string;
};

export function ObservationPage() {
  const { workspaceId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ObservationForm>();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const selectedBalconyId = Form.useWatch('balconyId', form);
  const selectedZoneId = Form.useWatch('zoneId', form);

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
  const zonePlants = plants.data?.filter((plant) => plant.zoneId === selectedZoneId) ?? [];

  const submit = async (values: ObservationForm) => {
    if (!workspaceId) return;
    setSubmitting(true);
    try {
      const observation = await api.post<Observation>('/observations', {
        workspaceId,
        balconyId: values.balconyId,
        zoneId: values.zoneId,
        plantId: values.plantId ?? null,
        observedAt: values.observedAt.toISOString(),
        temperatureC: values.temperatureC,
        lightLevel: values.lightLevel,
        lux: values.lux ?? null,
        windDirection: values.windDirection,
        windDegrees: values.windDegrees ?? null,
        windSpeedMps: values.windSpeedMps ?? null,
        plantStatus: values.plantStatus,
        plantTags: values.plantTags ?? [],
        soilMoisturePct: values.soilMoisturePct ?? null,
        soilMoistureSource: values.soilMoistureSource ?? null,
        notes: values.notes ?? null,
        clientRequestId: crypto.randomUUID(),
      });
      const file = files[0]?.originFileObj;
      let photoError: string | null = null;
      if (file) {
        try {
          const data = new FormData();
          data.append('workspaceId', workspaceId);
          data.append('observationId', observation.data.id);
          data.append('capturedAt', values.observedAt.toISOString());
          data.append('file', file);
          await api.post('/photos/upload', data);
        } catch (uploadError) {
          photoError = errorMessage(uploadError);
        }
      }
      if (photoError) {
        message.warning(`观察记录已保存，但照片上传失败：${photoError}`);
      } else {
        message.success('观察记录已保存');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['observations'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      ]);
      navigate('/journal');
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  if (!balconies.isLoading && balconies.data?.length === 0) {
    return <Alert type="warning" showIcon message="还没有阳台" action={<Button onClick={() => navigate('/onboarding')}>先去配置</Button>} />;
  }

  return (
    <Card title="记录一次真实观察">
      <Typography.Paragraph type="secondary">
        选择具体位置。没有仪表时，光照和风向使用等级/方位记录即可。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        initialValues={{ observedAt: dayjs(), lightLevel: 'INDIRECT', windDirection: 'N', plantStatus: 'HEALTHY' }}
        onValuesChange={(changed) => {
          if ('balconyId' in changed) {
            form.setFieldsValue({ zoneId: undefined, plantId: undefined });
          } else if ('zoneId' in changed) {
            form.setFieldValue('plantId', undefined);
          }
        }}
      >
        <Space size="large" wrap align="start">
          <Form.Item name="balconyId" label="阳台" rules={[{ required: true }]} style={{ minWidth: 220 }}>
            <Select options={balconies.data?.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item name="zoneId" label="位置" rules={[{ required: true }]} style={{ minWidth: 220 }}>
            <Select options={selectedBalcony?.zones.map((item) => ({ value: item.id, label: item.name }))} disabled={!selectedBalconyId} />
          </Form.Item>
          <Form.Item name="plantId" label="关联植物（可选）" style={{ minWidth: 220 }}>
            <Select allowClear options={zonePlants.map((item) => ({ value: item.id, label: item.name }))} disabled={!selectedZoneId} />
          </Form.Item>
          <Form.Item name="observedAt" label="观察时间" rules={[{ required: true }]}>
            <DatePicker showTime disabledDate={(date) => date.isAfter(dayjs().add(1, 'day'))} />
          </Form.Item>
        </Space>

        <Space size="large" wrap align="start">
          <Form.Item name="temperatureC" label="温度 °C" rules={[{ required: true }]}>
            <InputNumber min={-50} max={70} precision={1} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="lightLevel" label="光照等级" rules={[{ required: true }]}>
            <Select style={{ width: 170 }} options={LIGHT_LEVELS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="lux" label="光照 lux（可选）">
            <InputNumber min={0} max={200000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="windDirection" label="风向" rules={[{ required: true }]}>
            <Select style={{ width: 140 }} options={WIND_DIRECTIONS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="windDegrees" label="风向角（可选）">
            <InputNumber min={0} max={359} style={{ width: 160 }} addonAfter="°" />
          </Form.Item>
          <Form.Item name="windSpeedMps" label="风速 m/s（可选）">
            <InputNumber min={0} max={100} precision={1} style={{ width: 160 }} />
          </Form.Item>
        </Space>

        <Space size="large" wrap align="start">
          <Form.Item name="plantStatus" label="植物状态" rules={[{ required: true }]}>
            <Select style={{ width: 170 }} options={PLANT_STATUSES.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="plantTags" label="状态标签">
            <Select mode="tags" style={{ minWidth: 280 }} placeholder="例如 黄叶、萎蔫、开花" />
          </Form.Item>
          <Form.Item name="soilMoisturePct" label="土壤湿度 %（可选）">
            <InputNumber min={0} max={100} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="soilMoistureSource" label="湿度来源">
            <Select allowClear style={{ width: 160 }} options={[{ value: 'ESTIMATED', label: '估算' }, { value: 'MEASURED', label: '仪器' }]} />
          </Form.Item>
        </Space>

        <Form.Item name="notes" label="备注">
          <Input.TextArea rows={3} maxLength={3000} showCount />
        </Form.Item>
        <Form.Item label="照片（可选）" extra="支持 JPEG、PNG、WebP、HEIC、AVIF，单张不超过 15 MB。">
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
        <Button type="primary" htmlType="submit" loading={submitting}>保存观察</Button>
      </Form>
    </Card>
  );
}
