import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { catalogLinksWithManual, hostname } from './link-catalog.mjs';

const { Title, Text } = Typography;
let lastSnapshot = null;

async function api(path, signal, options = {}) {
  const response = await fetch(path, { credentials: 'include', signal, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'http_' + response.status);
  return payload;
}

async function allSites(accountId, signal) {
  const sites = [], seen = new Set();
  let pageToken = '';
  do {
    if (seen.has(pageToken)) throw new Error('GAM 站点分页重复');
    seen.add(pageToken);
    const query = pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : '';
    const result = await api('/api/admin/gam-accounts/' + accountId + '/sites' + query, signal);
    sites.push(...(result.items || []));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return sites;
}

function monitors(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  }
  catch { return []; }
}

function buildRows(accounts, sitesByAccount, metadata, assignments) {
  const byKey = new Map(metadata.map(item => [item.networkCode + ':' + item.domain, item]));
  const assigned = new Map(assignments.map(item => [item.domain, item]));
  return accounts.flatMap(account => {
    const local = metadata.filter(item => item.networkCode === account.networkCode && Number(item.isManual) === 1);
    return catalogLinksWithManual(account, sitesByAccount[account.id] || [], local.map(item => item.domain)).map(row => {
      const meta = byKey.get(row.networkCode + ':' + row.domain), fallback = assigned.get(row.domain);
      return { ...row, monitorDomains: monitors(meta?.monitorDomainsJson),
        channelId: meta ? meta.channelId : fallback?.channelId ?? null,
        channelName: meta ? meta.channelName : fallback?.channelName || '', notes: meta?.notes || '' };
    });
  }).sort((a, b) => a.domain.localeCompare(b.domain) || a.accountId - b.accountId);
}

const errors = {
  invalid_link_domain: '请输入有效域名', invalid_monitor_domain: '广告监测域名格式不正确（最多 20 个）',
  invalid_gam_account_status: '请选择已连接的 Ad Manager 账号', invalid_channel_id: '请选择有效渠道',
  invalid_link_metadata: '备注不能超过 2000 字', link_already_exists: '此账号下的域名已存在',
  invalid_gam_site_move: 'GAM 站点的域名和账号不能在本地转移',
  invalid_gam_site_domain: 'GAM 站点已变化，请刷新列表后重试'
};

export default function LinkManager() {
  const [accounts, setAccounts] = useState(lastSnapshot?.accounts || []);
  const [rows, setRows] = useState(lastSnapshot?.rows || []);
  const [channels, setChannels] = useState(lastSnapshot?.channels || []);
  const [issues, setIssues] = useState(lastSnapshot?.issues || []);
  const [lastLoaded, setLastLoaded] = useState(lastSnapshot?.lastLoaded || '');
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState([0, 0]);
  const [keyword, setKeyword] = useState('');
  const [types, setTypes] = useState(['main', 'sub']), [accountId, setAccountId] = useState(null);
  const [channelId, setChannelId] = useState(null);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const controller = useRef(null);

  const load = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setIssues([]);
    try {
      const [result, meta] = await Promise.all([
        api('/api/admin/gam-accounts', current.signal), api('/api/admin/link-metadata', current.signal)
      ]);
      const allAccounts = result.items || [], metadata = meta.items || [], assignments = meta.assignments || [];
      const channelOptions = meta.channels || [];
      setAccounts(allAccounts);
      setChannels(channelOptions);
      setProgress([0, allAccounts.length]);
      const sitesByAccount = {}, failures = [];
      let next = 0, done = 0;
      const publish = () => {
        if (current.signal.aborted) return;
        setProgress([done, allAccounts.length]);
        setRows(buildRows(allAccounts, sitesByAccount, metadata, assignments));
        setIssues([...failures]);
      };
      publish();
      const worker = async () => {
        while (next < allAccounts.length && !current.signal.aborted) {
          const account = allAccounts[next++];
          if (account.status !== 'active') failures.push(account.name + '：账号未连接，无法读取 GAM Sites');
          else {
            try { sitesByAccount[account.id] = await allSites(account.id, current.signal); }
            catch (error) {
              if (!current.signal.aborted)
                failures.push(account.name + '：GAM Sites 读取失败（' + String(error?.message || error) + '）');
            }
          }
          done += 1;
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, allAccounts.length) }, worker));
      if (!current.signal.aborted) {
        const stamp = new Date().toLocaleString('zh-CN');
        lastSnapshot = { accounts: allAccounts, rows: buildRows(allAccounts, sitesByAccount, metadata, assignments),
          channels: channelOptions, issues: [...failures], lastLoaded: stamp };
        setLastLoaded(stamp);
      }
    } catch (error) {
      if (!current.signal.aborted) setIssues([error.message]);
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => { load(); return () => controller.current?.abort(); }, []);

  const filtered = useMemo(() => rows.filter(row =>
    types.includes(row.type) && (accountId == null || row.accountId === accountId) &&
    (channelId == null || row.channelId === channelId) &&
    (!keyword.trim() || [row.domain, row.parentDomain, row.accountName, row.networkCode,
      row.channelName, row.notes, ...row.monitorDomains]
      .some(value => String(value || '').toLowerCase().includes(keyword.trim().toLowerCase())))),
  [rows, types, accountId, channelId, keyword]);
  useEffect(() => { setPage(1); }, [keyword, types, accountId, channelId]);
  const childCount = rows.filter(row => row.type === 'sub').length;

  const openCreate = () => {
    setEditing({ mode: 'create' });
    form.resetFields();
    form.setFieldsValue({ gamAccountId: accountId || undefined, monitorDomains: [] });
  };
  const openEdit = row => {
    setEditing({ mode: 'edit', row });
    form.setFieldsValue({ domain: row.domain, gamAccountId: row.accountId,
      monitorDomains: row.monitorDomains, channelId: row.channelId ?? undefined, notes: row.notes });
  };
  const save = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    const domain = hostname(values.domain);
    const monitorDomains = (values.monitorDomains || []).map(hostname);
    if (!domain) { form.setFields([{ name: 'domain', errors: ['请输入有效域名'] }]); return; }
    if (monitorDomains.some(value => !value)) {
      form.setFields([{ name: 'monitorDomains', errors: ['请输入有效的广告监测域名'] }]); return;
    }
    const body = { gamAccountId: values.gamAccountId, domain, monitorDomains,
      channelId: values.channelId || null, notes: values.notes || '' };
    if (editing.mode === 'edit') Object.assign(body, {
      originalNetworkCode: editing.row.networkCode, originalDomain: editing.row.domain,
      siteName: editing.row.siteName
    });
    setSaving(true);
    try {
      await api('/api/admin/link-metadata', undefined, { method: editing.mode === 'create' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      message.success(editing.mode === 'create' ? '链接已新增到本站目录' : '链接信息已保存');
      setEditing(null);
      await load();
    } catch (error) { message.error(errors[error.message] || error.message); }
    finally { setSaving(false); }
  };
  const columns = [
    { title: '域名', dataIndex: 'domain', width: 245, render: value => <Space><LinkOutlined style={{ color: '#1677ff' }}/><a href={'https://' + value} target="_blank" rel="noopener noreferrer">{value}</a></Space> },
    { title: '类型', dataIndex: 'type', width: 90, render: value => <Tag color={value === 'main' ? 'blue' : 'cyan'}>{value === 'main' ? '主域名' : '子域名'}</Tag> },
    { title: '所属账号', dataIndex: 'accountName', width: 190, render: (_, row) => <div className="link-account"><strong>{row.accountName}</strong><small>{row.networkCode}</small></div> },
    { title: '广告监测域名', dataIndex: 'monitorDomains', width: 210, render: values => values.length ? values.join('、') : '—' },
    { title: '渠道', dataIndex: 'channelName', width: 120, render: value => value || '—' },
    { title: '备注', dataIndex: 'notes', width: 210, ellipsis: true, render: value => value || '—' },
    { title: '来源', dataIndex: 'source', width: 100 },
    { title: '操作', key: 'actions', width: 90, fixed: 'right', render: (_, row) => <Button type="link" icon={<EditOutlined/>} onClick={() => openEdit(row)}>编辑</Button> }
  ];

  return <Space direction="vertical" size={16} className="page-stack link-manager">
    <div className="page-heading"><div><Title level={2}>链接管理</Title><Text type="secondary">统一管理 Ad Manager 账号的主域名、子域名及链接信息</Text></div>
      <Space><Button icon={<ReloadOutlined/>} loading={busy} onClick={load}>刷新 GAM 链接</Button>
        <Button type="primary" icon={<PlusOutlined/>} onClick={openCreate}>新增链接</Button></Space></div>
    <Alert type="info" showIcon message="GAM Sites 与本站链接目录"
      description="真实 GAM 网站直接读取；新增链接只记录到本站目录，不会自动提交到 Google Ad Manager。"/>
    {issues.length > 0 && <Alert type="warning" showIcon message="部分账号网站读取不完整" description={issues.join('；')} />}
    <Row gutter={[12, 12]}>
      <Col xs={12} md={6}><Card><Statistic title="已发现链接" value={rows.length}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="主域名" value={rows.length - childCount}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="子域名" value={childCount}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="已设监测域名" value={rows.filter(row => row.monitorDomains.length).length}/></Card></Col>
    </Row>
    <Card className="link-filters"><Row gutter={[12, 12]} align="middle">
      <Col xs={24} md={7}><Input allowClear prefix={<SearchOutlined/>} placeholder="域名、账号、渠道或备注" value={keyword} onChange={event => setKeyword(event.target.value)}/></Col>
      <Col xs={12} md={4}><Select mode="multiple" style={{ width: '100%' }} value={types} onChange={setTypes} options={[{value:'main',label:'主域名'},{value:'sub',label:'子域名'}]} placeholder="域名类型"/></Col>
      <Col xs={12} md={6}><Select allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={accountId} onChange={setAccountId} placeholder="全部账号" options={accounts.map(account => ({value:account.id,label:account.name + '（' + account.networkCode + '）'}))}/></Col>
      <Col xs={12} md={5}><Select allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={channelId} onChange={setChannelId} placeholder="全部渠道" options={channels.map(channel => ({value:channel.id,label:channel.name}))}/></Col>
      <Col xs={12} md={2}><Button onClick={() => { setKeyword(''); setTypes(['main','sub']); setAccountId(null); setChannelId(null); }}>重置</Button></Col>
    </Row></Card>
    <Card className="link-results" title={'链接列表（' + filtered.length + '）'} extra={<Text type="secondary">{busy ? '读取中 ' + progress[0] + '/' + progress[1] : lastLoaded ? '上次刷新 ' + lastLoaded : '尚未刷新'}</Text>}>
      <Table rowKey="key" size="middle" loading={busy && !rows.length} dataSource={filtered} columns={columns} pagination={{ current: page, pageSize, onChange: (next, size) => { setPage(next); setPageSize(size); }, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }} scroll={{ x: 1350 }} locale={{ emptyText: <Empty description={busy ? '正在读取 GAM Sites' : '没有符合条件的链接'} /> }}/>
    </Card>
    <Modal title={editing?.mode === 'create' ? '新增链接' : '编辑链接'} open={!!editing} onCancel={() => setEditing(null)} onOk={save}
      okText={editing?.mode === 'create' ? '创建链接' : '保存修改'} confirmLoading={saving} forceRender width={560}>
      {editing?.mode === 'edit' && editing.row.source === 'GAM Sites' && <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="GAM 站点的账号和域名由 Google 管理；这里只能修改本站的监测域名、渠道和备注。"/>}
      <Form form={form} layout="vertical">
        <Form.Item name="domain" label="域名" rules={[{ required: true, message: '请输入域名' }]} extra="可粘贴完整网址，系统会识别域名。">
          <Input placeholder="例如 example.com 或 news.example.com" disabled={editing?.row?.source === 'GAM Sites'}/>
        </Form.Item>
        <Form.Item name="gamAccountId" label="所属账号" rules={[{ required: true, message: '请选择账号' }]}>
          <Select showSearch optionFilterProp="label" placeholder="选择 Ad Manager 账号" disabled={editing?.row?.source === 'GAM Sites'}
            options={accounts.filter(account => account.status === 'active').map(account => ({ value: account.id, label: account.name + '（' + account.networkCode + '）' }))}/>
        </Form.Item>
        <Form.Item name="monitorDomains" label="广告监测域名" extra="可输入域名后回车；最多 20 个。">
          <Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入或选择网站域名"
            options={[...new Set(rows.map(row => row.domain))].map(domain => ({ value: domain, label: domain }))}/>
        </Form.Item>
        <Form.Item name="channelId" label="渠道"><Select allowClear showSearch optionFilterProp="label" placeholder="选择渠道"
          options={channels.map(channel => ({ value: channel.id, label: channel.name }))}/></Form.Item>
        <Form.Item name="notes" label="备注" rules={[{ max: 2000, message: '最多 2000 字' }]}><Input.TextArea rows={3} maxLength={2000}/></Form.Item>
      </Form>
    </Modal>
  </Space>;
}
