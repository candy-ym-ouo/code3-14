import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, List, Modal, Select, Space, Tabs, Tag, Typography, message } from 'antd';
import { BellOutlined, CheckOutlined, ClockCircleOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { PLANT_STATUSES } from '@balcony/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony, Notification, Plant, Reminder, ReminderOccurrence } from '../api/types';

type ReminderForm = {
  title: string;
  reminderType: string;
  targetType: string;
  targetId?: string;
  triggerMode: string;
  intervalValue?: number;
  intervalUnit?: string;
  timeOfDay?: string;
  runAt?: Dayjs;
  thresholdMetric?: string;
  thresholdOperator?: string;
  thresholdValue?: number | string;
  channels: string[];
};

export function RemindersPage() {
  const { workspaceId, user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ReminderForm>();
  const triggerMode = Form.useWatch('triggerMode', form);
  const targetType = Form.useWatch('targetType', form);
  const thresholdMetric = Form.useWatch('thresholdMetric', form);
  const intervalUnit = Form.useWatch('intervalUnit', form);
  useEffect(() => {
    setOpen(false);
    form.resetFields();
  }, [workspaceId, form]);
  const reminders = useQuery({
    queryKey: ['reminders', workspaceId],
    queryFn: async () => (await api.get<Reminder[]>('/reminders', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const occurrences = useQuery({
    queryKey: ['occurrences', workspaceId],
    queryFn: async () => (await api.get<ReminderOccurrence[]>('/reminder-occurrences', { params: { workspaceId, limit: 100 } })).data,
    enabled: Boolean(workspaceId),
  });
  const notifications = useQuery({
    queryKey: ['notifications', 'all'],
    queryFn: async () => (await api.get<Notification[]>('/notifications', { params: { limit: 50 } })).data,
  });
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

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;

  const createReminder = async (values: ReminderForm) => {
    const targetFields =
      values.targetType === 'BALCONY'
        ? { balconyId: values.targetId }
        : values.targetType === 'ZONE'
          ? { zoneId: values.targetId }
          : values.targetType === 'PLANT'
            ? { plantId: values.targetId }
            : {};
    try {
      await api.post('/reminders', {
        workspaceId,
        title: values.title,
        reminderType: values.reminderType,
        targetType: values.targetType,
        ...targetFields,
        triggerMode: values.triggerMode,
        runAt: values.runAt?.toISOString() ?? null,
        timezone: user?.timezone ?? 'Asia/Shanghai',
        intervalValue: values.intervalValue ?? null,
        intervalUnit: values.intervalUnit ?? null,
        timeOfDay: values.timeOfDay ?? null,
        weekdays: [],
        threshold: values.triggerMode === 'THRESHOLD' ? {
          metric: values.thresholdMetric,
          operator: values.thresholdOperator,
          value: values.thresholdValue,
          consecutive: 1,
        } : null,
        channels: values.channels,
        fixedSchedule: false,
        cooldownSeconds: 43200,
      });
      setOpen(false);
      form.resetFields();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reminders'] }),
        queryClient.invalidateQueries({ queryKey: ['occurrences'] }),
      ]);
      message.success('提醒已创建');
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const handleOccurrence = async (id: string, action: 'complete' | 'snooze' | 'dismiss') => {
    try {
      await api.post(`/reminder-occurrences/${id}/${action === 'snooze' ? 'snooze' : action}`, action === 'complete' ? { createAction: undefined } : {});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['occurrences'] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      message.success(action === 'complete' ? '已完成' : action === 'snooze' ? '稍后将再次提醒' : '已跳过本次');
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const targetOptions = targetType === 'BALCONY'
    ? balconies.data?.map((item) => ({ value: item.id, label: item.name }))
    : targetType === 'ZONE'
      ? balconies.data?.flatMap((balcony) => balcony.zones.map((zone) => ({ value: zone.id, label: `${balcony.name} · ${zone.name}` })))
      : plants.data?.map((item) => ({ value: item.id, label: item.name }));

  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <div><Typography.Title level={2} style={{ margin: 0 }}>提醒中心</Typography.Title><Typography.Text type="secondary">由后台 Worker 实际扫描和触发，不依赖页面保持打开。</Typography.Text></div>
        <Button type="primary" icon={<BellOutlined />} onClick={() => setOpen(true)}>新建提醒</Button>
      </Space>
      <Tabs
        items={[
          {
            key: 'rules',
            label: '提醒规则',
            children: reminders.data?.length ? (
              <List
                grid={{ gutter: 16, xs: 1, md: 2 }}
                dataSource={reminders.data}
                renderItem={(item) => (
                  <List.Item>
                    <Card title={item.title} extra={<Tag color={item.isActive ? 'green' : 'default'}>{item.isActive ? '启用' : '停用'}</Tag>}>
                      <Space direction="vertical">
                        <span>类型：{item.reminderType} / {item.triggerMode}</span>
                        <span>下次：{item.nextRunAt ? dayjs(item.nextRunAt).format('YYYY-MM-DD HH:mm') : '等待事件'}</span>
                        <span>范围：{item.plant?.name ?? item.zone?.name ?? item.targetType}</span>
                        <Button danger size="small" onClick={async () => {
                          try {
                            await api.delete(`/reminders/${item.id}`);
                            await queryClient.invalidateQueries({ queryKey: ['reminders'] });
                            message.success('提醒已停用');
                          } catch (error) {
                            message.error(errorMessage(error));
                          }
                        }}>停用</Button>
                      </Space>
                    </Card>
                  </List.Item>
                )}
              />
            ) : <Card><Alert type="info" showIcon message="尚未设置提醒" /></Card>,
          },
          {
            key: 'events',
            label: '到期事件',
            children: occurrences.data?.length ? (
              <List
                dataSource={occurrences.data}
                renderItem={(item) => (
                  <List.Item
                    actions={item.status === 'SENT' || item.status === 'SNOOZED' ? [
                      <Button key="done" type="link" icon={<CheckOutlined />} onClick={() => handleOccurrence(item.id, 'complete')}>完成</Button>,
                      <Button key="later" type="link" icon={<ClockCircleOutlined />} onClick={() => handleOccurrence(item.id, 'snooze')}>稍后</Button>,
                      <Button key="skip" type="link" onClick={() => handleOccurrence(item.id, 'dismiss')}>跳过</Button>,
                    ] : []}
                  >
                    <List.Item.Meta
                      title={item.reminder.title}
                      description={`${dayjs(item.dueAt).format('YYYY-MM-DD HH:mm')} · ${item.status}`}
                    />
                  </List.Item>
                )}
              />
            ) : <Card><Alert type="info" showIcon message="没有提醒事件" /></Card>,
          },
          {
            key: 'notifications',
            label: '站内通知',
            children: notifications.data?.length ? (
              <List
                dataSource={notifications.data}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta title={item.title} description={`${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')} · ${item.body}`} />
                  </List.Item>
                )}
              />
            ) : <Card><Alert type="info" showIcon message="没有站内通知" /></Card>,
          },
        ]}
      />
      <Modal title="新建提醒" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} width={680} destroyOnClose>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ reminderType: 'WATERING', targetType: 'WORKSPACE', triggerMode: 'INTERVAL', intervalValue: 3, intervalUnit: 'DAY', channels: ['IN_APP'], thresholdMetric: 'TEMPERATURE', thresholdOperator: 'GT' }}
          onFinish={createReminder}
          onValuesChange={(changed) => {
            if ('targetType' in changed) form.setFieldValue('targetId', undefined);
            if ('intervalUnit' in changed && changed.intervalUnit === 'MINUTE') form.setFieldValue('timeOfDay', undefined);
            if ('triggerMode' in changed) {
              form.setFieldsValue({
                intervalValue: undefined,
                intervalUnit: undefined,
                timeOfDay: undefined,
                runAt: undefined,
                thresholdValue: undefined,
              });
            }
            if ('thresholdMetric' in changed) form.setFieldsValue({ thresholdValue: undefined, thresholdOperator: changed.thresholdMetric === 'PLANT_STATUS' ? 'EQ' : 'GT' });
          }}
        >
          <Space size="large" wrap align="start">
            <Form.Item name="title" label="提醒标题" rules={[{ required: true }]}><Input style={{ width: 300 }} /></Form.Item>
            <Form.Item name="targetType" label="作用范围" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={[
                { value: 'WORKSPACE', label: '整个空间' },
                { value: 'BALCONY', label: '阳台' },
                { value: 'ZONE', label: '位置' },
                { value: 'PLANT', label: '植物' },
              ]} />
            </Form.Item>
            {targetType !== 'WORKSPACE' ? <Form.Item name="targetId" label="对象" rules={[{ required: true }]}><Select style={{ width: 220 }} options={targetOptions} /></Form.Item> : null}
          </Space>
          <Space size="large" wrap align="start">
            <Form.Item name="reminderType" label="提醒类型" rules={[{ required: true }]}><Select style={{ width: 160 }} options={[
              { value: 'WATERING', label: '浇水' },
              { value: 'REPOTTING', label: '换盆' },
              { value: 'OBSERVATION', label: '观察' },
              { value: 'TEMPERATURE', label: '温度' },
              { value: 'LIGHT', label: '光照' },
              { value: 'CUSTOM', label: '自定义' },
            ]} /></Form.Item>
            <Form.Item name="triggerMode" label="触发方式" rules={[{ required: true }]}><Select style={{ width: 150 }} options={[
              { value: 'INTERVAL', label: '周期' },
              { value: 'ONCE', label: '单次' },
              { value: 'THRESHOLD', label: '环境阈值' },
            ]} /></Form.Item>
          </Space>
          {triggerMode === 'INTERVAL' ? (
            <Space size="large" wrap>
              <Form.Item name="intervalValue" label="每 N" rules={[{ required: true }]}><InputNumber min={1} /></Form.Item>
              <Form.Item name="intervalUnit" label="单位" rules={[{ required: true }]}><Select style={{ width: 130 }} options={[
                { value: 'MINUTE', label: '分钟' },
                { value: 'DAY', label: '天' },
                { value: 'WEEK', label: '周' },
                { value: 'MONTH', label: '月' },
              ]} /></Form.Item>
              {intervalUnit !== 'MINUTE' ? <Form.Item name="timeOfDay" label="提醒时间（可选）"><Input placeholder="08:00" /></Form.Item> : null}
            </Space>
          ) : null}
          {triggerMode === 'ONCE' ? <Form.Item name="runAt" label="执行时间" rules={[{ required: true }]}><DatePicker showTime /></Form.Item> : null}
          {triggerMode === 'THRESHOLD' ? (
            <Space size="large" wrap>
              <Form.Item name="thresholdMetric" label="指标" rules={[{ required: true }]}><Select style={{ width: 140 }} options={[{ value: 'TEMPERATURE', label: '温度' }, { value: 'PLANT_STATUS', label: '植物状态' }]} /></Form.Item>
              <Form.Item name="thresholdOperator" label="条件" rules={[{ required: true }]}><Select style={{ width: 120 }} options={thresholdMetric === 'PLANT_STATUS' ? [{ value: 'EQ', label: '等于' }, { value: 'GTE', label: '不低于' }, { value: 'LTE', label: '不高于' }] : [{ value: 'GT', label: '高于' }, { value: 'GTE', label: '大于等于' }, { value: 'LT', label: '低于' }, { value: 'LTE', label: '小于等于' }]} /></Form.Item>
              <Form.Item name="thresholdValue" label="阈值" rules={[{ required: true }]}>
                {thresholdMetric === 'PLANT_STATUS'
                  ? <Select style={{ width: 150 }} options={PLANT_STATUSES.map((value) => ({ value, label: value }))} />
                  : <InputNumber style={{ width: 120 }} />}
              </Form.Item>
            </Space>
          ) : null}
          <Form.Item name="channels" label="通知渠道" rules={[{ required: true }]}>
            <Select mode="multiple" options={[{ value: 'IN_APP', label: '站内通知' }, { value: 'EMAIL', label: '邮件（需配置 SMTP）' }]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
