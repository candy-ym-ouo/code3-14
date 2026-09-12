import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  const token = params.get('token') ?? '';

  if (!token) return <div className="auth-shell"><Alert className="auth-card" type="error" showIcon message="重置链接缺少令牌" /></div>;
  return (
    <div className="auth-shell">
      <Card className="auth-card" title="设置新密码">
        {done ? (
          <>
            <Alert type="success" showIcon message="密码已更新" description="该链接已失效，请使用新密码重新登录。" />
            <Button type="primary" block style={{ marginTop: 16 }} onClick={() => navigate('/login')}>返回登录</Button>
          </>
        ) : (
          <Form
            layout="vertical"
            onFinish={async ({ password }) => {
              try {
                await api.post('/auth/password/reset', { token, password });
                setDone(true);
              } catch (error) {
                message.error(errorMessage(error));
              }
            }}
          >
            <Typography.Paragraph type="secondary">新密码至少 10 位，更新后所有旧会话都会失效。</Typography.Paragraph>
            <Form.Item name="password" label="新密码" rules={[{ required: true, min: 10, message: '密码至少 10 位' }]}><Input.Password /></Form.Item>
            <Button type="primary" htmlType="submit" block>更新密码</Button>
          </Form>
        )}
        <Typography.Paragraph style={{ marginTop: 16 }}><Link to="/login">返回登录</Link></Typography.Paragraph>
      </Card>
    </div>
  );
}
