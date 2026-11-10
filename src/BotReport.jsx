import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Input, Row, Space, Statistic, Switch, Tag, Typography, message } from 'antd';
import { ReloadOutlined, SendOutlined } from '@ant-design/icons';
import NumericSortableTable from './NumericSortableTable.jsx';

const { Title, Text } = Typography;
const money = value => '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'include', ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  return data;
}

export default function BotReport() {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try {
      const data = await api('/api/admin/bot-report/settings');
      setSettings(data.settings); setPreview(data.preview);
      form.setFieldsValue({ enabled:Boolean(data.settings.enabled), webhook:'', clearWebhook:false });
    } catch (cause) { setError(cause.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const save = async values => {
    setSaving(true);
    try {
      await api('/api/admin/bot-report/settings', { method:'PUT', body:JSON.stringify(values) });
      message.success('汇报机器人设置已保存');
      await load();
    } catch (cause) { message.error('保存失败：' + cause.message); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      await api('/api/admin/bot-report/test', { method:'POST' });
      message.success('测试汇报已发送到飞书');
    } catch (cause) { message.error('发送失败：' + cause.message); }
    finally { setTesting(false); }
  };
  const last = settings?.lastDelivery;
  return <Space direction="vertical" size={16} className="page-stack" style={{width:'100%'}}>
    <div className="page-heading"><div><Title level={2}>机器人汇报</Title><Text type="secondary">每天向飞书推送当天已同步的流水和利润</Text></div>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    <Alert type="info" showIcon message="每日 23:45（北京时间）自动汇报一次"
      description="仅统计真实 GAM REST 已同步数据；流水为原始收入，利润沿用数据报告口径：上游分成后收入 × 85% − 渠道结算。当天数值是截至发送时的快照，服务器短时重启可在次日 06:00 前补发。"/>
    {error && <Alert type="error" showIcon message="机器人汇报读取失败" description={error}/>}
    <Row gutter={[16,16]}>
      <Col xs={24} lg={12}><Card title="飞书机器人设置" loading={loading && !settings}>
        <Form form={form} layout="vertical" onFinish={save} initialValues={{enabled:false,webhook:'',clearWebhook:false}}>
          <Form.Item name="enabled" label="每日自动推送" valuePropName="checked"><Switch checkedChildren="开启" unCheckedChildren="关闭"/></Form.Item>
          <Form.Item name="webhook" label={settings?.webhookConfigured ? '机器人 Webhook（已配置；留空保持原值）' : '机器人 Webhook'}>
            <Input.Password autoComplete="off" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."/>
          </Form.Item>
          <Form.Item name="clearWebhook" label="移除已有 Webhook" valuePropName="checked"><Switch/></Form.Item>
          <Space wrap><Button type="primary" htmlType="submit" loading={saving}>保存设置</Button>
            <Button icon={<SendOutlined/>} loading={testing} disabled={!settings?.webhookConfigured} onClick={test}>发送测试汇报</Button></Space>
        </Form>
        <Text type="secondary">机器人地址仅加密保存在服务器，页面不回显。</Text>
      </Card></Col>
      <Col xs={24} lg={12}><Card title={'今日数据预览 · ' + (preview?.date || '—')} loading={loading && !preview}>
        {preview?.rows > 0 ? <Row gutter={[16,16]}><Col span={12}><Statistic title="流水（USD）" value={money(preview.revenue)}/></Col>
          <Col span={12}><Statistic title="利润（USD）" value={money(preview.profit)}/></Col></Row>
          : <Text type="secondary">今天暂无已同步的 GAM REST 明细，暂不把空白误报为 0。</Text>}
        <div style={{marginTop:16}}><Text type="secondary">已同步明细：{preview?.rows ?? '—'} 条；最近入库（UTC）：{preview?.lastImport || '—'}</Text></div>
        <div style={{marginTop:16}}><Text strong>各 GAM 账号当地日期</Text>
          <NumericSortableTable size="small" rowKey="networkCode" style={{marginTop:8}}
            dataSource={preview?.accounts || []} numericKeys={['rows','revenue','profit']}
            columns={[{title:'账号',dataIndex:'name'},{title:'当地日期',dataIndex:'date'},
              {title:'时区',dataIndex:'timeZone'},{title:'明细',dataIndex:'rows',align:'right'},
              {title:'流水',dataIndex:'revenue',align:'right',render:money},
              {title:'利润',dataIndex:'profit',align:'right',render:money}]}
            scroll={{x:650}} pagination={false}/>
        </div>
      </Card></Col>
    </Row>
    <Card title="最近一次自动汇报"><Space wrap>
      <Tag color={last?.status === 'sent' ? 'green' : last?.status === 'failed' ? 'red' : 'default'}>
        {last?.status === 'sent' ? '已送达' : last?.status === 'failed' ? '发送失败' : last?.status === 'sending' ? '发送中' : '尚无记录'}</Tag>
      <Text>数据日期：{last?.reportDate || '—'}</Text><Text>发送时间（UTC）：{last?.sentAt || '—'}</Text>
      {last?.error && <Text type="danger">错误：{last.error}</Text>}
    </Space></Card>
  </Space>;
}
