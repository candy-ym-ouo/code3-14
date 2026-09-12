import { Alert, Card, Col, Descriptions, Empty, Row, Segmented, Select, Space, Statistic, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { ActionLog, Balcony, Plant } from '../api/types';
import { PhotoThumb } from '../components/PhotoThumb';

type SeriesResponse = {
  metric: string;
  points: Array<{ time: string; avg?: number; min?: number; max?: number; lux?: number; status?: string; direction?: string }>;
  distribution?: Record<string, number>;
  meta: { sampleCount: number; luxSampleCount?: number };
};

type Comparison = {
  comparable: boolean;
  reason: string | null;
  before: { sampleCount: number; temperature: { avg: number | null; min: number | null; max: number | null } };
  after: { sampleCount: number; temperature: { avg: number | null; min: number | null; max: number | null } };
  temperatureDelta: number | null;
  coverage: { before: number; after: number; reference: string };
  photos: { before: { id: string } | null; after: { id: string } | null };
  disclaimer: string;
};

export function InsightsPage() {
  const { workspaceId } = useAuth();
  const [metric, setMetric] = useState('temperature');
  const [scope, setScope] = useState('workspace');
  const [scopeId, setScopeId] = useState<string | undefined>();
  const [days, setDays] = useState(7);
  const [actionId, setActionId] = useState<string>();

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
  const actions = useQuery({
    queryKey: ['comparison-options', workspaceId],
    queryFn: async () => (await api.get<ActionLog[]>('/analytics/comparison-options', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const series = useQuery({
    queryKey: ['series', workspaceId, metric, scope, scopeId, days],
    queryFn: async () => (await api.get<SeriesResponse>('/analytics/series', {
      params: {
        workspaceId,
        metric,
        scope,
        scopeId,
        from: dayjs().subtract(days, 'day').toISOString(),
        to: dayjs().toISOString(),
        bucket: 'hour',
      },
    })).data,
    enabled: Boolean(workspaceId) && (scope === 'workspace' || Boolean(scopeId)),
  });
  const comparison = useQuery({
    queryKey: ['comparison', actionId],
    queryFn: async () => (await api.get<Comparison>('/analytics/compare', { params: { actionId, beforeDays: 7, afterDays: 7 } })).data,
    enabled: Boolean(actionId),
  });

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  const scopeOptions = scope === 'plant'
    ? plants.data?.map((item) => ({ value: item.id, label: item.name })) ?? []
    : scope === 'zone'
      ? balconies.data?.flatMap((balcony) => balcony.zones.map((zone) => ({ value: zone.id, label: `${balcony.name} · ${zone.name}` }))) ?? []
      : balconies.data?.map((item) => ({ value: item.id, label: item.name })) ?? [];

  return (
    <div className="page-stack">
      <div>
        <Typography.Title level={2} style={{ margin: 0 }}>数据洞察</Typography.Title>
        <Typography.Text type="secondary">曲线只使用真实观察记录；样本不足时不生成对比结论。</Typography.Text>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented value={metric} onChange={(value) => setMetric(String(value))} options={[
            { value: 'temperature', label: '温度' },
            { value: 'light', label: '光照' },
            { value: 'wind', label: '风向' },
            { value: 'plant_status', label: '植物状态' },
          ]} />
          <Select value={scope} onChange={(value) => { setScope(value); setScopeId(undefined); }} options={[
            { value: 'workspace', label: '整个空间' },
            { value: 'balcony', label: '按阳台' },
            { value: 'zone', label: '按位置' },
            { value: 'plant', label: '按植物' },
          ]} style={{ width: 130 }} />
          {scope !== 'workspace' ? <Select value={scopeId} onChange={setScopeId} placeholder="选择对象" options={scopeOptions} style={{ width: 240 }} /> : null}
          <Select value={days} onChange={setDays} options={[7, 30, 90].map((value) => ({ value, label: `最近 ${value} 天` }))} style={{ width: 140 }} />
        </Space>
        {series.isError ? <Alert type="error" showIcon message="曲线加载失败" /> : null}
        {series.data && series.data.meta.sampleCount === 0 ? <Empty description="当前范围没有真实记录" /> : null}
        {series.data && series.data.meta.sampleCount > 0 ? (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              {metric === 'temperature' ? (
                <LineChart data={series.data.points}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" minTickGap={30} />
                  <YAxis unit="°C" />
                  <Tooltip />
                  <Line type="monotone" dataKey="avg" name="平均" stroke="#2f6b4f" dot={false} />
                  <Line type="monotone" dataKey="min" name="最低" stroke="#8bb8a0" dot={false} />
                  <Line type="monotone" dataKey="max" name="最高" stroke="#d97706" dot={false} />
                </LineChart>
              ) : metric === 'light' && series.data.distribution ? (
                <BarChart data={Object.entries(series.data.distribution).map(([name, value]) => ({ name, value }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip />
                  <Bar dataKey="value" name="记录数" fill="#69a37d" />
                </BarChart>
              ) : metric === 'wind' && series.data.distribution ? (
                <BarChart data={Object.entries(series.data.distribution).map(([name, value]) => ({ name, value }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip />
                  <Bar dataKey="value" name="记录数" fill="#4d7c8a" />
                </BarChart>
              ) : (
                <LineChart data={series.data.points}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" minTickGap={30} /><YAxis hide /><Tooltip />
                  <Line type="stepAfter" dataKey={(item) => item.status === 'HEALTHY' ? 0 : item.status === 'WATCH' ? 1 : item.status === 'CONCERN' ? 2 : 3} name="状态等级" stroke="#b45309" />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : null}
      </Card>

      <Card title="干预前后对比" extra={<Select style={{ width: 320 }} placeholder="选择一次操作" value={actionId} onChange={setActionId} options={actions.data?.map((item) => ({ value: item.id, label: `${dayjs(item.startedAt).format('MM-DD HH:mm')} · ${item.title}` }))} />}>
        {!actionId ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择操作后按前后 7 天比较" /> : null}
        {comparison.data ? (
          <div className="page-stack">
            <Alert
              type={comparison.data.comparable ? 'success' : 'warning'}
              showIcon
              message={comparison.data.comparable ? '数据满足基础比较条件' : '样本不足，暂不生成改善或恶化结论'}
              description={comparison.data.comparable ? comparison.data.disclaimer : '前后任一窗口都需要至少 3 条有效记录，且覆盖度达到 50%。'}
            />
            <Row gutter={[16, 16]}>
              <Col xs={24} md={8}><Card><Statistic title="前窗口样本" value={comparison.data.before.sampleCount} suffix="条" /></Card></Col>
              <Col xs={24} md={8}><Card><Statistic title="后窗口样本" value={comparison.data.after.sampleCount} suffix="条" /></Card></Col>
              <Col xs={24} md={8}><Card><Statistic title="温度均值变化" value={comparison.data.temperatureDelta ?? 0} precision={2} suffix="°C" /></Card></Col>
            </Row>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="操作前均值">{comparison.data.before.temperature.avg ?? '-'}°C</Descriptions.Item>
              <Descriptions.Item label="操作后均值">{comparison.data.after.temperature.avg ?? '-'}°C</Descriptions.Item>
              <Descriptions.Item label="覆盖度">前 {(comparison.data.coverage.before * 100).toFixed(0)}% / 后 {(comparison.data.coverage.after * 100).toFixed(0)}% · {comparison.data.coverage.reference}</Descriptions.Item>
            </Descriptions>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card title={<Space>操作前照片 <Tag>最近</Tag></Space>}>
                  {comparison.data.photos.before ? <PhotoThumb photoId={comparison.data.photos.before.id} alt="操作前照片" /> : <Empty description="没有关联照片" />}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card title={<Space>操作后照片 <Tag color="green">最早</Tag></Space>}>
                  {comparison.data.photos.after ? <PhotoThumb photoId={comparison.data.photos.after.id} alt="操作后照片" /> : <Empty description="没有关联照片" />}
                </Card>
              </Col>
            </Row>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
