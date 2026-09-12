import { Skeleton } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function PhotoThumb({
  photoId,
  alt,
  variant = 'thumbnail',
  className = 'photo-thumb',
}: {
  photoId: string;
  alt: string;
  variant?: 'thumbnail' | 'original';
  className?: string;
}) {
  const query = useQuery({
    queryKey: ['photo-url', photoId, variant],
    queryFn: async () => (await api.get<{ url: string }>(`/photos/${photoId}/url`, { params: { variant } })).data.url,
    staleTime: 8 * 60 * 1000,
    retry: 1,
  });

  if (query.isLoading) return <Skeleton.Image active style={{ width: '100%', height: 240 }} />;
  if (!query.data) return <div className={className}>照片暂时无法加载</div>;
  return <img className={className} src={query.data} alt={alt} loading="lazy" />;
}
