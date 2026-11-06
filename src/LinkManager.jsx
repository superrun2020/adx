import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import { LinkOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { catalogLinksForAccount } from './link-catalog.mjs';

const { Title, Text } = Typography;
let lastSnapshot = null;

async function api(path, signal) {
  const response = await fetch(path, { credentials: 'include', signal });
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

export default function LinkManager() {
  const [accounts, setAccounts] = useState(lastSnapshot?.accounts || []);
  const [rows, setRows] = useState(lastSnapshot?.rows || []);
  const [issues, setIssues] = useState(lastSnapshot?.issues || []);
  const [lastLoaded, setLastLoaded] = useState(lastSnapshot?.lastLoaded || '');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState([0, 0]);
  const [keyword, setKeyword] = useState('');
  const [types, setTypes] = useState(['main', 'sub']), [accountId, setAccountId] = useState(null);
  const [approvalFilter, setApprovalFilter] = useState('all');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const controller = useRef(null);

  const load = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setIssues([]);
    try {
      const result = await api('/api/admin/gam-accounts', current.signal);
      const allAccounts = result.items || [];
      setAccounts(allAccounts);
      setProgress([0, allAccounts.length]);
      const found = [], failures = [];
      let next = 0, done = 0;
      const worker = async () => {
        while (next < allAccounts.length && !current.signal.aborted) {
          const account = allAccounts[next++];
          if (account.status !== 'active') {
            failures.push(account.name + '：账号未连接，无法读取 GAM Sites');
          } else {
            try {
              const sites = await allSites(account.id, current.signal);
              found.push(...catalogLinksForAccount(account, sites));
            } catch (error) {
              if (!current.signal.aborted)
                failures.push(account.name + '：GAM Sites 读取失败（' + String(error?.message || error) + '）');
            }
          }
          done += 1;
          if (!current.signal.aborted) {
            setProgress([done, allAccounts.length]);
            setRows([...found].sort((a, b) => a.domain.localeCompare(b.domain) || a.accountId - b.accountId));
            setIssues([...failures]);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, allAccounts.length) }, worker));
      if (!current.signal.aborted) {
        const stamp = new Date().toLocaleString('zh-CN');
        setLastLoaded(stamp);
        lastSnapshot = { accounts: allAccounts, rows: [...found], issues: [...failures], lastLoaded: stamp };
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
    (approvalFilter === 'all' || (approvalFilter === 'approved' ? row.approval === 'APPROVED'
      : approvalFilter === 'draft' ? row.approval === 'DRAFT'
        : !['APPROVED','DRAFT'].includes(row.approval))) &&
    (!keyword.trim() || [row.domain, row.parentDomain, row.accountName, row.networkCode]
      .some(value => String(value || '').toLowerCase().includes(keyword.trim().toLowerCase())))),
  [rows, types, accountId, approvalFilter, keyword]);
  useEffect(() => { setPage(1); }, [keyword, types, accountId, approvalFilter]);
  const approvedCount = rows.filter(row => row.approval === 'APPROVED').length;
  const childCount = rows.filter(row => row.type === 'sub').length;
  const columns = [
    { title: '域名', dataIndex: 'domain', width: 270, render: value => <Space><LinkOutlined style={{ color: '#1677ff' }}/><a href={'https://' + value} target="_blank" rel="noopener noreferrer">{value}</a></Space> },
    { title: '类型', dataIndex: 'type', width: 100, render: value => <Tag color={value === 'main' ? 'blue' : 'cyan'}>{value === 'main' ? '主域名' : '子域名'}</Tag> },
    { title: '所属账号', dataIndex: 'accountName', width: 210, render: (_, row) => <div className="link-account"><strong>{row.accountName}</strong><small>{row.networkCode}</small></div> },
    { title: '审核状态', dataIndex: 'approval', width: 230, render: value => value === 'APPROVED'
      ? <Tag color="green">GAM Sites 已过审</Tag> : value === 'DRAFT'
        ? <Tag>GAM Sites 草稿</Tag> : <Tag color="red">{value}</Tag> },
    { title: '关联主站', dataIndex: 'parentDomain', width: 200, render: value => value || '—' },
    { title: '来源', dataIndex: 'source', width: 150 }
  ];

  return <Space direction="vertical" size={16} className="page-stack link-manager">
    <div className="page-heading"><div><Title level={2}>链接管理</Title><Text type="secondary">统一查看所有 Ad Manager 账号的主域名、子域名与审核状态</Text></div>
      <Button icon={<ReloadOutlined/>} loading={busy} onClick={load}>刷新 GAM 链接</Button></div>
    <Alert type="info" showIcon message="仅展示 GAM Sites 中已登记的网站"
      description="默认显示所有已登记的主域名和子域名，并标明真实审核状态；需要时可筛选“已过审”。"/>
    {issues.length > 0 && <Alert type="warning" showIcon message="部分账号网站读取不完整" description={issues.join('；')} />}
    {!busy && lastLoaded && approvedCount === 0 && <Alert type="warning" showIcon message="当前 GAM Sites 未返回已过审站点" description="可切换为“全部审核状态”查看已登记但未过审的网站。"/>}
    <Row gutter={[12, 12]}>
      <Col xs={12} md={6}><Card><Statistic title="已发现链接" value={rows.length}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="GAM 直接过审" value={approvedCount}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="子域名" value={childCount}/></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="已查询账号" value={progress[0]} suffix={'/ ' + progress[1]}/></Card></Col>
    </Row>
    <Card className="link-filters"><Row gutter={[12, 12]} align="middle">
      <Col xs={24} md={7}><Input allowClear prefix={<SearchOutlined/>} placeholder="输入域名或账号，列表实时筛选" value={keyword} onChange={event => setKeyword(event.target.value)}/></Col>
      <Col xs={12} md={4}><Select mode="multiple" style={{ width: '100%' }} value={types} onChange={setTypes} options={[{value:'main',label:'主域名'},{value:'sub',label:'子域名'}]} placeholder="域名类型"/></Col>
      <Col xs={12} md={5}><Select style={{ width: '100%' }} value={approvalFilter} onChange={setApprovalFilter} options={[{value:'approved',label:'已过审'},{value:'all',label:'全部审核状态'},{value:'draft',label:'草稿/待审'},{value:'other',label:'其他状态'}]}/></Col>
      <Col xs={12} md={6}><Select allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={accountId} onChange={setAccountId} placeholder="全部账号" options={accounts.map(account => ({value:account.id,label:account.name + '（' + account.networkCode + '）'}))}/></Col>
      <Col xs={24} md={2}><Button onClick={() => { setKeyword(''); setTypes(['main','sub']); setApprovalFilter('all'); setAccountId(null); }}>重置</Button></Col>
    </Row></Card>
    <Card className="link-results" title={'链接列表（' + filtered.length + '）'} extra={<Text type="secondary">{busy ? '读取中 ' + progress[0] + '/' + progress[1] : lastLoaded ? '上次刷新 ' + lastLoaded : '尚未刷新'}</Text>}>
      <Table rowKey="key" size="middle" loading={busy && !rows.length} dataSource={filtered} columns={columns} pagination={{ current: page, pageSize, onChange: (next, size) => { setPage(next); setPageSize(size); }, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }} scroll={{ x: 1180 }} locale={{ emptyText: <Empty description={busy ? '正在读取 GAM Sites' : '没有符合条件的链接'} /> }}/>
    </Card>
  </Space>;
}
