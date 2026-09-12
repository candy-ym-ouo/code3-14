import {
  AppstoreOutlined,
  BellOutlined,
  CameraOutlined,
  DashboardOutlined,
  LineChartOutlined,
  MenuOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Alert, Badge, Button, Drawer, Layout, Menu, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Notification } from '../api/types';

const { Header, Sider, Content } = Layout;

export function AppLayout() {
  const { user, workspaces, workspaceId, setWorkspaceId, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const notifications = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: async () => (await api.get<Notification[]>('/notifications', { params: { unreadOnly: true, limit: 20 } })).data,
    refetchInterval: 60_000,
  });

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">概览</Link> },
    { key: '/journal', icon: <AppstoreOutlined />, label: <Link to="/journal">记录时间轴</Link> },
    { key: '/record/new', icon: <PlusOutlined />, label: <Link to="/record/new">记录环境</Link> },
    { key: '/actions/new', icon: <PlusOutlined />, label: <Link to="/actions/new">记录操作</Link> },
    { key: '/balconies', icon: <TeamOutlined />, label: <Link to="/balconies">阳台与位置</Link> },
    { key: '/plants', icon: <ExperimentOutlined />, label: <Link to="/plants">植物</Link> },
    { key: '/insights', icon: <LineChartOutlined />, label: <Link to="/insights">数据洞察</Link> },
    { key: '/photos/compare', icon: <CameraOutlined />, label: <Link to="/photos/compare">照片对照</Link> },
    {
      key: '/reminders',
      icon: <BellOutlined />,
      label: (
        <Link to="/reminders">
          提醒
          {notifications.data?.length ? <Badge count={notifications.data.length} size="small" style={{ marginLeft: 8 }} /> : null}
        </Link>
      ),
    },
    { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">设置</Link> },
  ];

  const selectedKey = menuItems
    .map((item) => item.key)
    .filter((key) => key === '/' ? location.pathname === '/' : location.pathname.startsWith(key))
    .sort((left, right) => right.length - left.length)[0] ?? '/';

  const navigation = (
    <Menu
      mode="inline"
      selectedKeys={[selectedKey]}
      items={menuItems}
      onClick={() => setMobileOpen(false)}
      style={{ border: 0, background: 'transparent' }}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" style={{ background: '#fff' }}>
        <div style={{ padding: '22px 20px 14px', fontWeight: 700, fontSize: 18, color: '#285b42' }}>
          阳台微气候
        </div>
        {navigation}
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            borderBottom: '1px solid #e5ebe5',
          }}
        >
          <Space>
            <Button className="mobile-menu-button" icon={<MenuOutlined />} onClick={() => setMobileOpen(true)} />
            <Typography.Text strong>{user?.displayName}</Typography.Text>
          </Space>
          <Space>
            <Select
              value={workspaceId ?? undefined}
              placeholder="选择空间"
              options={workspaces.map((workspace) => ({ value: workspace.id, label: `${workspace.name} · ${workspace.role}` }))}
              onChange={setWorkspaceId}
              style={{ minWidth: 180 }}
            />
            <Button
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              退出
            </Button>
          </Space>
        </Header>
        {user?.status === 'DELETING' ? (
          <Alert
            banner
            type="warning"
            showIcon
            message="账号处于删除冷静期"
            description="请在设置页撤销删除申请，否则到期后会永久删除数据和照片。"
          />
        ) : null}
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} placement="left" width={280} title="阳台微气候">
        {navigation}
      </Drawer>
    </Layout>
  );
}
