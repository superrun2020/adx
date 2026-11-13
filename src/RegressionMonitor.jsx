import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import ReportDateFilter from './ReportDateFilter.jsx';
import NumericSortHeader from './NumericSortHeader.jsx';

const { Title, Text } = Typography;
const cadenceNames = { day: '单日 · 同日上次快照', three_days: '每 3 天 · 前 3 天', week: '每 7 天 · 前 7 天', month: '近 30 天 · 前 30 天' };
const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedMoney = value => (Number(value) > 0 ? '+' : Number(value) < 0 ? '-' : '') + money(Math.abs(Number(value || 0)));
const signed = (value, suffix = '') => (Number(value) > 0 ? '+' : '') + Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: suffix ? 2 : 0 }) + suffix;
const stamp = (value, zone) => value ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString('zh-CN', { hour12: false, timeZone: zone || undefined }) : '—';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  return data;
}

export default function RegressionMonitor() {
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [runs, setRuns] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(false);
  const [range, setRange] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [cadence, setCadence] = useState(null);
  const [domain, setDomain] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const [form] = Form.useForm();
  const requestId = useRef(0);

  const loadEvents = async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(page) });
      if (range?.[0] && range?.[1]) { q.set('start', range[0].format('YYYY-MM-DD')); q.set('end', range[1].format('YYYY-MM-DD')); }
      if (accountId) q.set('accountId', String(accountId));
      if (cadence) q.set('cadence', cadence);
      if (domain.trim()) q.set('domain', domain.trim());
      if (alertsOnly) q.set('alertsOnly', '1');
      if (sort) { q.set('sortBy', sort.key); q.set('sortDir', sort.direction); }
      const result = await api('/api/admin/regression/events?' + q);
      if (id === requestId.current) { setRows(result.items || []); setTotal(result.total || 0); }
    } catch (error) { if (id === requestId.current) message.error('监测记录读取失败：' + error.message); }
    finally { if (id === requestId.current) setLoading(false); }
  };
  const loadMeta = async () => {
    const results = await Promise.allSettled([
      api('/api/admin/regression/settings'), api('/api/admin/gam-accounts'), api('/api/admin/regression/runs')
    ]);
    if (results[0].status === 'fulfilled') setSettings(results[0].value.settings);
    if (results[1].status === 'fulfilled') setAccounts(results[1].value.items || []);
    if (results[2].status === 'fulfilled') setRuns(results[2].value.items || []);
    if (results.some(result => result.status === 'rejected')) message.error('部分监测信息读取失败，请刷新重试');
  };
  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { const timer = window.setTimeout(loadEvents, domain ? 250 : 0); return () => { window.clearTimeout(timer); requestId.current += 1; }; }, [page, range?.[0]?.valueOf(), range?.[1]?.valueOf(), accountId, cadence, domain, alertsOnly, sort]);
  const updateFilter = setter => value => { setPage(1); setter(value); };
  const openSettings = () => {
    form.setFieldsValue({ feishuEnabled: Boolean(settings?.feishuEnabled), minRevenue: settings?.minRevenue ?? 50,
      minDropPercent: settings?.minDropPercent ?? 2, webhook: '', signingSecret: '', clearWebhook: false, clearSigningSecret: false });
    setModal(true);
  };
  const saveSettings = async values => {
    setSaving(true);
    try {
      const result = await api('/api/admin/regression/settings', { method: 'PUT', body: JSON.stringify(values) });
      setSettings(result.settings);
      setModal(false);
      message.success('通知条件已保存');
    } catch (error) { message.error('保存失败：' + error.message); }
    finally { setSaving(false); }
  };

  const numericTitle = (label, key) => <NumericSortHeader label={label}
    direction={sort?.key === key ? sort.direction : ''}
    onSort={direction => { setPage(1); setSort({ key, direction }); }}/>;
  const columns = [
    { title: '监测时间', dataIndex: 'createdAt', width: 190, render: (value, row) => <Tooltip title={row.timeZone || '浏览器时区'}>{stamp(value, row.timeZone)}{row.timeZone ? ' (' + row.timeZone + ')' : ''}</Tooltip> },
    { title: '数据及对比区间', width: 265, render: (_, row) => <Space direction="vertical" size={0}><Text strong>{row.periodStart === row.periodEnd ? row.periodEnd : row.periodStart + ' ~ ' + row.periodEnd}</Text><Text type="secondary" style={{fontSize:11}}>{row.baselineStart && row.baselineEnd ? '对比 ' + row.baselineStart + ' ~ ' + row.baselineEnd : '对比同日上次快照'}</Text><Text type="secondary" style={{fontSize:11}}>{cadenceNames[row.cadence]}</Text></Space> },
    { title: '最早已确认下修数据日', dataIndex: 'dropStartDate', width: 175, render: (value, row) => value ? <Tooltip title="现有同日快照可证实的最早下修日；如历史快照不完整，实际起始日可能更早。"><strong>{value}</strong></Tooltip> : row.alertStatus !== 'not_triggered' ? <Tooltip title="本次多日监测比较的是相邻时段的区间总额；缺少可证实同日下修的历史快照，不能据此确定具体数据日。"><Text type="secondary">区间内未定位</Text></Tooltip> : '—' },
    { title: '账号', dataIndex: 'accountName', width: 160, ellipsis: true },
    { title: '域名', dataIndex: 'domain', width: 230, ellipsis: true },
    { title: numericTitle('原收入','oldRevenue'), dataIndex: 'oldRevenue', width: 105, align: 'right', render: money },
    { title: numericTitle('新收入','newRevenue'), dataIndex: 'newRevenue', width: 105, align: 'right', render: money },
    { title: numericTitle('收入变化','revenueDelta'), dataIndex: 'revenueDelta', width: 110, align: 'right', render: value => <span style={{color: value < 0 ? '#cf1322' : '#389e0d'}}>{signedMoney(value)}</span> },
    { title: numericTitle('差异率','differencePercent'), dataIndex: 'differencePercent', width: 100, align: 'right', render: value => <strong style={{color: value < 0 ? '#cf1322' : '#389e0d'}}>{signed(value, '%')}</strong> },
    { title: numericTitle('请求数变化','requestsDelta'), dataIndex: 'requestsDelta', width: 120, align: 'right', render: value => signed(value) },
    { title: numericTitle('展示数变化','impressionsDelta'), dataIndex: 'impressionsDelta', width: 120, align: 'right', render: value => signed(value) },
    { title: numericTitle('点击数变化','clicksDelta'), dataIndex: 'clicksDelta', width: 110, align: 'right', render: value => signed(value) },
    { title: '来源', width: 90, render: () => <Tag color="purple">GAM REST</Tag> },
    { title: '飞书通知', dataIndex: 'alertStatus', width: 145, render: (value, row) => <Tag title={row.alertError || ''} color={value === 'sent' ? 'green' : value === 'failed' ? 'red' : value === 'pending' ? 'blue' : 'default'}>{({sent:'已发送',failed:'发送失败',pending:'待发送',disabled:'未启用',duplicate:'已去重',paused_suppressed:'停投影响，未推送',not_triggered:'未触发'})[value] || value}</Tag> }
  ];
  const latest = runs.find(run => run.status === 'success');
  return <Space direction="vertical" size={16} className="page-stack regression-monitor">
    <div className="page-heading"><div><Title level={2}>数据回退监测</Title><Text type="secondary">比较真实 GAM REST 报表，按账号时区计算日期；登录可直接查看最近监测结果</Text></div>
      <Space><Button icon={<ReloadOutlined/>} loading={loading} onClick={() => { loadMeta(); loadEvents(); }}>刷新记录</Button><Button type="primary" icon={<SettingOutlined/>} onClick={openSettings}>通知条件设置</Button></Space></div>
    <Alert showIcon type="info" message={
      '飞书条件：原收入 > ' + money(settings?.minRevenue ?? 50) + ' 且收入下降 ≥ ' + Number(settings?.minDropPercent ?? 2).toFixed(2) + '%；' + (settings?.feishuEnabled ? '通知已启用' : '通知未启用')
    } description="今天和昨天有数据时，分别每 15 分钟与各自的同日上次快照比较；3 天和 7 天仅在完整区间结束后各比较一次，下一完整区间再与刚结束的区间比较。近 30 天每 7 天重新拉取。已记录的广告单元停投影响会从区间收入中扣除；扣除后仍达到下降阈值，继续推送。"/>
    {latest && <Text type="secondary">最近完成：{latest.accountName} · {cadenceNames[latest.cadence]} · {stamp(latest.finishedAt, latest.timeZone)}（{latest.timeZone}）</Text>}
    {runs[0]?.status === 'failed' && <Alert type="warning" showIcon message={'最近一次监测失败：' + runs[0].accountName + ' · ' + cadenceNames[runs[0].cadence]} description={runs[0].detail || '请检查 GAM 账号同步状态'} />}
    {runs[0]?.status === 'skipped' && <Alert type="info" showIcon message={'最近一次监测暂未比较：' + runs[0].accountName + ' · ' + cadenceNames[runs[0].cadence]} description={runs[0].detail || '等待 GAM 返回可比较的完整数据'} />}
    <Card className="regression-filters"><Space wrap size={12}>
      <ReportDateFilter value={range} onChange={updateFilter(setRange)} allowAll />
      <Select allowClear showSearch optionFilterProp="label" placeholder="全部账号" style={{width:210}} value={accountId} onChange={updateFilter(setAccountId)} options={accounts.map(account => ({value:account.id,label:account.name + ' (' + account.networkCode + ')'}))}/>
      <Select allowClear placeholder="全部时间段" style={{width:190}} value={cadence} onChange={updateFilter(setCadence)} options={Object.entries(cadenceNames).map(([value,label]) => ({value,label}))}/>
      <Input allowClear placeholder="域名筛选" style={{width:205}} value={domain} onChange={event => {setPage(1); setDomain(event.target.value);}} onPressEnter={loadEvents}/>
      <Button onClick={() => {setPage(1); loadEvents();}}>搜索</Button>
      <Space><Switch checked={alertsOnly} onChange={updateFilter(setAlertsOnly)}/><Tooltip title="达到收入回退阈值，包含已发送、待发送、发送失败及通知未启用的记录"><Text>仅看已触发</Text></Tooltip></Space>
      <Button onClick={() => {setRange(null);setAccountId(null);setCadence(null);setDomain('');setAlertsOnly(false);setSort(null);setPage(1);}}>重置</Button>
    </Space></Card>
    <Card className="regression-table" title={'监测记录（' + total + '）'}><Table rowKey="id" loading={loading} dataSource={rows} columns={columns} size="middle" scroll={{x:1850}}
      pagination={{current:page,pageSize:100,total,showSizeChanger:false,onChange:setPage}} locale={{emptyText:'暂无可比较的变化记录；首次同步会先建立基准快照'}}/></Card>
    <Modal title="数据回退通知条件" open={modal} onCancel={() => setModal(false)} onOk={() => form.submit()} confirmLoading={saving} okText="保存条件" destroyOnHidden>
      <Alert showIcon type="info" style={{marginBottom:16}} message="两项阈值须同时满足才发飞书通知；同一域名在同一监测时段成功发送后会去重。"/>
      <Form form={form} layout="vertical" onFinish={saveSettings}>
        <Form.Item name="feishuEnabled" label="飞书通知" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item>
        <Space align="start" style={{display:'flex'}}><Form.Item name="minRevenue" label="原收入大于（美元）" rules={[{required:true}]}><InputNumber min={0} precision={2} style={{width:180}} prefix="$"/></Form.Item>
          <Form.Item name="minDropPercent" label="收入下降幅度不低于（%）" rules={[{required:true}]}><InputNumber min={0.01} max={100} precision={2} style={{width:180}} suffix="%"/></Form.Item></Space>
        <Form.Item name="webhook" label={'飞书机器人 Webhook' + (settings?.webhookConfigured ? '（已配置；留空保持原值）' : '')}><Input.Password placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." autoComplete="off"/></Form.Item>
        <Form.Item name="signingSecret" label="签名密钥（可选，留空保持原值）"><Input.Password autoComplete="off"/></Form.Item>
        <Form.Item name="clearSigningSecret" label="清除现有签名密钥" valuePropName="checked"><Switch/></Form.Item>
        <Form.Item name="clearWebhook" label="移除现有 Webhook" valuePropName="checked"><Switch/></Form.Item>
      </Form>
    </Modal>
  </Space>;
}
