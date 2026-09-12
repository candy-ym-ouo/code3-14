import { Alert, Card, Empty, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Photo } from '../api/types';
import { PhotoThumb } from '../components/PhotoThumb';

export function PhotoComparePage() {
  const { workspaceId } = useAuth();
  const [beforeId, setBeforeId] = useState<string>();
  const [afterId, setAfterId] = useState<string>();
  const query = useQuery({
    queryKey: ['photos', workspaceId],
    queryFn: async () => (await api.get<{ items: Photo[] }>('/photos', { params: { workspaceId, limit: 100 } })).data.items,
    enabled: Boolean(workspaceId),
  });

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  const options = query.data?.map((photo) => ({
    value: photo.id,
    label: `${photo.capturedAt ? new Date(photo.capturedAt).toLocaleString('zh-CN') : new Date(photo.uploadedAt).toLocaleString('zh-CN')} · ${photo.originalFilename}`,
  }));

  return (
    <div className="page-stack">
      <div>
        <Typography.Title level={2} style={{ margin: 0 }}>照片对照</Typography.Title>
        <Typography.Text type="secondary">选择任意两张已授权照片；原图和缩略图都由对象存储真实提供。</Typography.Text>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select style={{ width: 360 }} placeholder="选择对照前照片" value={beforeId} onChange={setBeforeId} options={options} />
          <Select style={{ width: 360 }} placeholder="选择对照后照片" value={afterId} onChange={setAfterId} options={options} />
        </Space>
        {!query.data?.length ? <Empty description="还没有照片。请从观察或操作记录中上传。" /> : null}
        {beforeId || afterId ? (
          <div className="photo-compare">
            <Card title="对照 A">{beforeId ? <PhotoThumb photoId={beforeId} alt="对照 A" variant="original" /> : <Empty description="未选择" />}</Card>
            <Card title="对照 B">{afterId ? <PhotoThumb photoId={afterId} alt="对照 B" variant="original" /> : <Empty description="未选择" />}</Card>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
