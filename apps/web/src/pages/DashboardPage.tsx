import { Alert, Button, Card, Col, Empty, List, Row, Space, Statistic, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { ActionLog, Observation, Plant, Reminder } from '../api/types';

type Dashboard = {
  latestObservation: (Observation & { zone: { name: string }; plant?: { name: string } | null }) | null;
  last7Days: { observationCount: number; actionCount: number };
  upcomingReminders: Reminder[];
  attentionPlants: Plant[];
  recentAction: ActionLog | null;
  dataFreshnessHours: number | null;
};

export function DashboardPage() {
  const { workspaceId } = useAuth();
  const query = useQuery({
    queryKey: ['dashboard', workspaceId],
    queryFn: async () => (await api.get<Dashboard>('/analytics/summary', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });

  if (!workspaceId) return <Alert type="warning" showIcon message="尚未创建记录空间" />;
  if (query.isError) return <Alert type="error" showIcon message="概览加载失败" description={(query.error as Error).message} />;

  const data = query.data;
  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>阳台概览</Typography.Title>
          <Typography.Text type="secondary">所有数据来自真实记录。</Typography.Text>
        </div>
        <Space wrap>
          <Link to="/record/new"><Button type="primary" icon={<PlusOutlined />}>记录环境</Button></Link>
          <Link to="/actions/new"><Button icon={<PlusOutlined />}>记录操作</Button></Link>
        </Space>
      </Space>

      {!data?.latestObservation ? (
        <Card>
          <Empty
            description={(
              <span>
                还没有观察记录。请先创建阳台和位置，再记录第一条真实数据。
              </span>
            )}
          >
            <Space>
              <Link to="/onboarding"><Button>首次配置</Button></Link>
              <Link to="/record/new"><Button type="primary">开始记录</Button></Link>
            </Space>
          </Empty>
        </Card>
      ) : (
        <>
          <div className="metric-grid">
            <Card><Statistic title="近 7 天观察" value={data.last7Days.observationCount} /></Card>
            <Card><Statistic title="近 7 天操作" value={data.last7Days.actionCount} /></Card>
            <Card>
              <Statistic
                title="数据新鲜度"
                value={data.dataFreshnessHours ?? 0}
                suffix="小时前"
                valueStyle={{ color: (data.dataFreshnessHours ?? 0) > 48 ? '#b45309' : '#2f6b4f' }}
              />
            </Card>
            <Card><Statistic title="待关注植物" value={data.attentionPlants.length} /></Card>
          </div>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title="最近观察" extra={<Link to="/journal">查看时间轴</Link>}>
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <div>
                    <Typography.Title level={4} style={{ marginBottom: 4 }}>
                      {Number(data.latestObservation.temperatureC).toFixed(1)}°C · {data.latestObservation.lightLevel}
                    </Typography.Title>
                    <Typography.Text type="secondary">
                      {data.latestObservation.zone.name}
                      {data.latestObservation.plant ? ` · ${data.latestObservation.plant.name}` : ''}
                      {' · '}
                      {new Date(data.latestObservation.observedAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                  </div>
                  <Space wrap>
                    <Tag color="blue">风向 {data.latestObservation.windDirection}</Tag>
                    <Tag color={data.latestObservation.plantStatus === 'HEALTHY' ? 'green' : 'orange'}>
                      植物 {data.latestObservation.plantStatus}
                    </Tag>
                  </Space>
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title="即将到期提醒" extra={<Link to="/reminders">提醒中心</Link>}>
                {data.upcomingReminders.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待处理提醒" />
                ) : (
                  <List
                    dataSource={data.upcomingReminders}
                    renderItem={(item) => (
                      <List.Item>
                        <List.Item.Meta title={item.title} description={item.nextRunAt ? new Date(item.nextRunAt).toLocaleString('zh-CN') : '等待触发'} />
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </Col>
          </Row>

          {data.attentionPlants.length > 0 ? (
            <Card title="需要关注">
              <List
                dataSource={data.attentionPlants}
                renderItem={(plant) => (
                  <List.Item extra={<Link to="/plants">{plant.name}</Link>}>
                    <List.Item.Meta title={plant.name} description={`${plant.zone?.name ?? ''} · 状态 ${plant.status}`} />
                  </List.Item>
                )}
              />
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
