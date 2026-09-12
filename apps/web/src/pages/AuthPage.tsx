import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Tabs, Typography } from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../api/client';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: Record<string, string>) => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'register') {
        await auth.register({
          email: values.email!,
          password: values.password!,
          displayName: values.displayName!,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        });
      } else {
        await auth.login(values.email!, values.password!);
      }
      navigate('/');
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Typography.Title level={2} style={{ color: '#285b42', marginBottom: 4 }}>阳台微气候记录</Typography.Title>
        <Typography.Paragraph type="secondary">
          记录真实环境与植物变化，比较遮阳、浇水和换盆后的差异。
        </Typography.Paragraph>
        <Tabs
          activeKey={mode}
          items={[
            { key: 'login', label: <Link to="/login">登录</Link> },
            { key: 'register', label: <Link to="/register">注册</Link> },
          ]}
        />
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          {mode === 'register' ? (
            <Form.Item name="displayName" label="称呼" rules={[{ required: true, message: '请输入称呼' }]}>
              <Input prefix={<UserOutlined />} autoComplete="name" />
            </Form.Item>
          ) : null}
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input prefix={<MailOutlined />} autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, min: mode === 'register' ? 10 : 1, message: mode === 'register' ? '密码至少 10 位' : '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            {mode === 'register' ? '创建真实记录空间' : '登录'}
          </Button>
          {mode === 'login' ? <div style={{ marginTop: 12, textAlign: 'right' }}><Link to="/forgot-password">忘记密码？</Link></div> : null}
        </Form>
      </div>
      <div className="auth-art">
        <div>
          让阳台上的每一次<br />调整都有真实依据
        </div>
      </div>
    </div>
  );
}
