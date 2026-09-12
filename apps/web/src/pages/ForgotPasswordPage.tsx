import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';

export function ForgotPasswordPage() {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="auth-shell">
      <Card className="auth-card" title="找回密码">
        {accepted ? (
          <Alert
            type="success"
            showIcon
            message="请求已受理"
            description="如果邮箱已注册且 SMTP 已配置，你会收到一封有效期为 1 小时的重置邮件。"
          />
        ) : (
          <>
            <Typography.Paragraph type="secondary">请输入注册邮箱。出于隐私考虑，系统不会透露邮箱是否存在。</Typography.Paragraph>
            <Form
              layout="vertical"
              onFinish={async ({ email }) => {
                try {
                  await api.post('/auth/password/forgot', { email });
                  setAccepted(true);
                } catch (error) {
                  message.error(errorMessage(error));
                }
              }}
            >
              <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}><Input /></Form.Item>
              <Button type="primary" htmlType="submit" block>发送重置链接</Button>
            </Form>
          </>
        )}
        <Typography.Paragraph style={{ marginTop: 16 }}><Link to="/login">返回登录</Link></Typography.Paragraph>
      </Card>
    </div>
  );
}
