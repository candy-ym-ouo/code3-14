import { Alert, Card, Empty, List, Space, Tabs, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { ActionLog, Observation } from '../api/types';

export function JournalPage() {
  const { workspaceId } = useAuth();
  const observations = useQuery({
    queryKey: ['observations', workspaceId],
    queryFn: async () => (await api.get<{ items: Observation[] }>('/observations', { params: { workspaceId, limit: 100 } })).data.items,
    enabled: Boolean(workspaceId),
  });
  const actions = useQuery({
    queryKey: ['actions', workspaceId],
    queryFn: async () => (await api.get<{ items: ActionLog[] }>('/actions', { params: { workspaceId, limit: 100 } })).data.items,
    enabled: Boolean(workspaceId),
  });

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  return (
    <Card
      title="记录时间轴"
      extra={<Typography.Text type="secondary">按真实时间倒序</Typography.Text>}
    >
      <Tabs
        items={[
          {
            key: 'observations',
            label: `环境观察 ${observations.data?.length ?? 0}`,
            children: observations.data?.length ? (
              <List
                dataSource={observations.data}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={`${Number(item.temperatureC).toFixed(1)}°C · ${item.lightLevel} · ${item.windDirection}`}
                      description={`${new Date(item.observedAt).toLocaleString('zh-CN')} · ${item.zone.name}${item.plant ? ` · ${item.plant.name}` : ''}`}
                    />
                    <Space wrap>
                      <Tag>{item.plantStatus}</Tag>
                      {item.plantTags?.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                    </Space>
                  </List.Item>
                )}
              />
            ) : <Empty description="尚无观察记录" />,
          },
          {
            key: 'actions',
            label: `干预操作 ${actions.data?.length ?? 0}`,
            children: actions.data?.length ? (
              <List
                dataSource={actions.data}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={<Space><Tag color="green">{item.actionType}</Tag>{item.title}</Space>}
                      description={`${new Date(item.startedAt).toLocaleString('zh-CN')}${item.plant ? ` · ${item.plant.name}` : ''}`}
                    />
                  </List.Item>
                )}
              />
            ) : <Empty description="尚无操作记录" />,
          },
        ]}
      />
    </Card>
  );
}
