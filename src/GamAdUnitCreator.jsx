import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Collapse, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tabs, Tag, Typography, message } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { batchUnitTemplates, belongsToSite, prepareGamUnitItems, siteDomain } from './gam-unit-plan.mjs';

const { Text, Title } = Typography;
const bannerSizes = ['320x50', '336x280', '250x250', '300x250'];
const interstitialSizes = ['fluid', 'out-of-page', 'native', '1x1', '480x320', '768x1024', '1024x768', '320x480'];
const sizeLabels = { fluid: '自适应尺寸 (FLUID)', 'out-of-page': '页外 (INTERSTITIAL)', native: '自定义呈现/原生 (NATIVE)' };
const unitTypes = [
  { value: 'banner', label: '横幅广告 (Banner)', sizes: bannerSizes },
  { value: 'interstitial', label: '插页式广告 (INT)', sizes: interstitialSizes },
  { value: 'anchor', label: '锚定广告 (ANC)', sizes: ['320x50'] }
];
const typeFor = value => unitTypes.find(item => item.value === value) || unitTypes[0];
const sizeOptions = values => values.map(value => ({ value, label: sizeLabels[value] || value }));
const newRow = (type = 'banner', bannerNo = 1) => ({
  id: Math.random().toString(36).slice(2), type, bannerNo, sizes: [...typeFor(type).sizes], name: '', code: ''
});
const initialBatch = () => batchUnitTemplates.map(template => newRow(template.type, template.bannerNo));

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'http_' + response.status);
  return payload;
}

function SiteDomainPicker({ site, knownDomains, selected, search, single, onSearch, onSelect }) {
  const base = siteDomain(site.url);
  const children = [...new Set(knownDomains.filter(domain => domain !== base && belongsToSite(domain, base)))];
  const query = search.trim();
  const inputDomain = siteDomain(query);
  const validChild = inputDomain !== base && belongsToSite(inputDomain, base);
  const matched = children.includes(inputDomain);
  const searchPart = query.replace(/^https?:\/\//i, '').toLowerCase();
  const shown = children.filter(domain => domain.includes(searchPart));
  const choose = domain => onSelect(single ? [domain] : [...new Set([...selected, domain])]);
  return <Card size="small" title={<Space><span>{base || site.url}</span><Tag>{children.length} 个已知子网站</Tag></Space>} style={{ marginTop: 12 }} bodyStyle={{ padding: 12 }}>
    <Text type="secondary">来自此 GAM 账号的已同步报表及本站创建记录。{single ? '创建单个时选择一个。' : '可多选，按子网站分别创建。'}不选时使用主网站。</Text>
    {children.length > 0 ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
      {shown.map(domain => <Checkbox key={domain} checked={selected.includes(domain)} onChange={event => onSelect(event.target.checked ? (single ? [domain] : [...new Set([...selected, domain])]) : selected.filter(value => value !== domain))}>{domain}</Checkbox>)}
      {!shown.length && <Text type="secondary">没有匹配的已知子网站</Text>}
    </div> : <div style={{ marginTop: 8 }}><Text type="secondary">暂无已同步的子网站，可在下方输入。</Text></div>}
    <Input.Search style={{ marginTop: 12 }} value={search} onChange={event => onSearch(event.target.value)}
      placeholder={'输入子网站或完整网址，例如 news.' + base} enterButton="选择此网站"
      onSearch={() => { if (validChild) choose(inputDomain); }}
      disabled={!base} />
    {query && <div style={{ marginTop: 8 }}>
      {validChild ? <Text type={matched ? 'success' : 'warning'}>{matched ? '匹配成功：该账号已有子网站记录' : '域名属于所选主网站，但尚无同步记录；可手动使用'}：{inputDomain}</Text>
        : <Text type="danger">{inputDomain === base ? '输入的是主网站，无需添加；不选子网站即可使用' : '未匹配：请输入属于 ' + base + ' 的子网站'}</Text>}
    </div>}
    {selected.length > 0 && <div style={{ marginTop: 10 }}><Text type="secondary">本次使用：</Text>{selected.map(domain => <Tag closable key={domain} onClose={() => onSelect(selected.filter(value => value !== domain))}>{domain}{children.includes(domain) ? '' : ' · 手动输入'}</Tag>)}</div>}
  </Card>;
}
function remoteSizes(values) {
  return (values || []).map(item => {
    const size = item.size || {};
    if (size.sizeType === 'PIXEL') return size.width + 'x' + size.height;
    return sizeLabels[{ FLUID: 'fluid', INTERSTITIAL: 'out-of-page', NATIVE: 'native' }[size.sizeType]] || size.sizeType || '';
  }).filter(Boolean).join('、');
}

function UnitFields({ row, index, onChange, fixedSuffix }) {
  const template = typeFor(row.type);
  return <Card size="small" title={fixedSuffix || '广告单元 ' + (index + 1)} extra={fixedSuffix && <Tag>{template.label}</Tag>} style={{ marginBottom: 12 }}>
    <Row gutter={[16, 12]}>
      {!fixedSuffix && <Col xs={24} sm={row.type === 'banner' ? 12 : 24}><Text>广告类型</Text><Select style={{ width: '100%', marginTop: 6 }} value={row.type} options={unitTypes.map(item => ({ value: item.value, label: item.label }))} onChange={type => onChange({ type, bannerNo: 1, sizes: [...typeFor(type).sizes], name: '', code: '' })}/></Col>}
      {!fixedSuffix && row.type === 'banner' && <Col xs={24} sm={12}><Text>Banner 序号</Text><InputNumber min={1} max={999} precision={0} style={{ width: '100%', marginTop: 6 }} value={row.bannerNo} onChange={bannerNo => onChange({ bannerNo })}/></Col>}
      <Col span={24}><Text type="secondary">尺寸模板：{template.sizes.map(size => sizeLabels[size] || size).join('、')}</Text><Select mode="tags" tokenSeparators={[',', '，']} style={{ width: '100%', marginTop: 6 }} value={row.sizes} options={sizeOptions(template.sizes)} placeholder="选择尺寸，或输入宽x高" onChange={sizes => onChange({ sizes })}/></Col>
      {!fixedSuffix && <Col xs={24} sm={12}><Text>广告单元名称（可选）</Text><Input style={{ marginTop: 6 }} value={row.name} maxLength={255} placeholder="默认：年月日-域名-广告类型" onChange={event => onChange({ name: event.target.value })}/></Col>}
      {!fixedSuffix && <Col xs={24} sm={12}><Text>广告单元代码（可选）</Text><Input style={{ marginTop: 6 }} value={row.code} maxLength={100} placeholder="默认：年月日-域名-广告类型" onChange={event => onChange({ code: event.target.value })}/></Col>}
    </Row>
  </Card>;
}

export default function GamAdUnitCreator({ accounts = [] }) {
  const activeAccounts = accounts.filter(item => item.status === 'active');
  const [filterAccountId, setFilterAccountId] = useState(null), [filterName, setFilterName] = useState('');
  const [filterStatuses, setFilterStatuses] = useState(['ACTIVE', 'INACTIVE']);
  const [queried, setQueried] = useState(false), [remoteUnits, setRemoteUnits] = useState([]);
  const [nextUnits, setNextUnits] = useState(''), [lastQuery, setLastQuery] = useState(null), [listBusy, setListBusy] = useState(false);
  const [open, setOpen] = useState(false), [mode, setMode] = useState('batch');
  const [accountId, setAccountId] = useState(null), [siteNames, setSiteNames] = useState([]);
  const [sites, setSites] = useState([]), [knownDomains, setKnownDomains] = useState([]);
  const [domainChoices, setDomainChoices] = useState({}), [domainSearch, setDomainSearch] = useState({});
  const [nextSites, setNextSites] = useState('');
  const [inventoryBusy, setInventoryBusy] = useState(false), [inventoryError, setInventoryError] = useState('');
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [single, setSingle] = useState(newRow()), [batchRows, setBatchRows] = useState(initialBatch);
  const [creationDate, setCreationDate] = useState(() => dayjs());
  const [description, setDescription] = useState(''), [adsenseEnabled, setAdsenseEnabled] = useState(false);
  const [targetWindow, setTargetWindow] = useState('TOP');
  const [creations, setCreations] = useState([]), [results, setResults] = useState([]);
  const [publishing, setPublishing] = useState(false), [retrying, setRetrying] = useState(null);

  const loadCreations = () => api('/api/admin/gam-ad-units').then(result => setCreations(result.items || []));
  useEffect(() => { loadCreations().catch(error => message.error(error.message)); }, []);
  useEffect(() => {
    if (!open || !accountId) return;
    let current = true;
    setInventoryBusy(true); setInventoryError('');
    Promise.allSettled([
      api('/api/admin/gam-accounts/' + accountId + '/sites'),
      api('/api/admin/gam-accounts/' + accountId + '/site-domains')
    ]).then(([siteResult, domainResult]) => {
      if (!current) return;
      if (siteResult.status === 'fulfilled') {
        setSites(siteResult.value.items || []); setNextSites(siteResult.value.nextPageToken || '');
      } else setInventoryError(siteResult.reason.message);
      if (domainResult.status === 'fulfilled') setKnownDomains(domainResult.value.items || []);
      else message.warning('已同步子网站暂未加载，仍可手动输入');
    })
      .finally(() => { if (current) setInventoryBusy(false); });
    return () => { current = false; };
  }, [open, accountId, inventoryVersion]);

  const searchUnits = async (query = { accountId: filterAccountId, name: filterName, statuses: filterStatuses }, pageToken = '') => {
    if (!query.accountId) return message.warning('请先选择账号');
    setListBusy(true);
    try {
      const params = new URLSearchParams({ search: query.name.trim(), statuses: query.statuses.join(',') });
      if (pageToken) params.set('pageToken', pageToken);
      const result = await api('/api/admin/gam-accounts/' + query.accountId + '/ad-units?' + params);
      setRemoteUnits(previous => pageToken ? [...previous, ...(result.items || [])] : (result.items || []));
      setNextUnits(result.nextPageToken || ''); setLastQuery(query); setQueried(true);
    } catch (error) { message.error('查询 GAM 广告单元失败：' + error.message); }
    finally { setListBusy(false); }
  };
  const chooseAccount = value => {
    setAccountId(value); setSites([]); setKnownDomains([]); setNextSites('');
    setSiteNames([]); setDomainChoices({}); setDomainSearch({}); setInventoryError('');
  };
  const loadMoreSites = async () => {
    if (!nextSites || !accountId) return;
    setInventoryBusy(true);
    try {
      const result = await api('/api/admin/gam-accounts/' + accountId + '/sites?pageToken=' + encodeURIComponent(nextSites));
      setSites(previous => [...new Map([...previous, ...(result.items || [])].map(item => [item.name, item])).values()]);
      setNextSites(result.nextPageToken || '');
    } catch (error) { message.error(error.message); }
    finally { setInventoryBusy(false); }
  };
  const openCreator = () => {
    setMode('batch'); setSingle(newRow()); setBatchRows(initialBatch()); setResults([]);
    setCreationDate(dayjs());
    setDescription(''); setAdsenseEnabled(false); setTargetWindow('TOP');
    chooseAccount(filterAccountId && activeAccounts.some(item => item.id === filterAccountId) ? filterAccountId : null);
    setOpen(true);
  };
  const updateBatchRow = (id, changes) => setBatchRows(previous => previous.map(row => row.id === id ? { ...row, ...changes } : row));
  const preparedItems = () => prepareGamUnitItems({ accountId, siteNames, sites, domainChoices,
    rows: mode === 'single' ? [single] : batchRows, creationDate: creationDate?.format('YYYY-MM-DD'),
    description, adsenseEnabled, targetWindow, single: mode === 'single' });
  const publish = async () => {
    let items;
    try { items = preparedItems(); } catch (error) { message.warning(error.message); return; }
    setPublishing(true);
    try {
      const result = mode === 'single'
        ? await api('/api/admin/gam-ad-units', { method: 'POST', body: JSON.stringify(items[0]) })
        : await api('/api/admin/gam-ad-units/batch', { method: 'POST', body: JSON.stringify({ gamAccountId: accountId, items }) });
      const rows = mode === 'single' ? [{ status: 'created', code: items[0].code, domain: items[0].domain, item: result.item }]
        : (result.results || []).map(row => ({ ...row, domain: items[row.index]?.domain || '' }));
      setResults(rows); setOpen(false); await loadCreations();
      if (lastQuery?.accountId === accountId) await searchUnits(lastQuery);
      const failures = rows.filter(row => row.status === 'failed').length;
      if (failures) message.warning('已创建 ' + (rows.length - failures) + ' 个，失败 ' + failures + ' 个；请查看下方逐条错误');
      else message.success('已同步 ' + rows.length + ' 个广告单元到 GAM');
    } catch (error) {
      message.error('创建失败：' + error.message + '；如已生成失败记录，请在同步记录中重试');
      await loadCreations().catch(() => {});
    } finally { setPublishing(false); }
  };
  const retry = async item => {
    setRetrying(item.id);
    try { await api('/api/admin/gam-ad-units/' + item.id + '/retry', { method: 'POST' }); message.success('已同步到 GAM'); await loadCreations(); }
    catch (error) { message.error(error.message); await loadCreations(); }
    finally { setRetrying(null); }
  };
  let previewItems = [], previewError = '';
  try { if (accountId && siteNames.length) previewItems = preparedItems(); } catch (error) { previewError = error.message; }
  const accountOptions = activeAccounts.map(item => ({ value: item.id, label: item.name + '（' + item.networkCode + '）' }));
  const historyColumns = [
    { title: '账号', dataIndex: 'networkCode', width: 135 }, { title: '网站', dataIndex: 'domain', width: 170 },
    { title: '广告单元', dataIndex: 'displayName', width: 210 }, { title: '代码', dataIndex: 'adUnitCode', width: 200 },
    { title: '状态', dataIndex: 'status', width: 95, render: value => <Tag color={value === 'created' ? 'green' : 'red'}>{value === 'created' ? '已同步' : '失败'}</Tag> },
    { title: 'GAM 资源名 / 错误', width: 280, ellipsis: true, render: (_, row) => row.providerId || row.publishError },
    { title: '操作', width: 80, render: (_, row) => row.status === 'failed' && <Popconfirm title={'重试同步 ' + row.adUnitCode + '？'} onConfirm={() => retry(row)}><Button size="small" loading={retrying === row.id}>重试</Button></Popconfirm> }
  ];
  const remoteColumns = [
    { title: '广告单元', dataIndex: 'displayName', width: 280 }, { title: '广告单元代码', dataIndex: 'adUnitCode', width: 230 },
    { title: '尺寸', dataIndex: 'adUnitSizes', render: remoteSizes },
    { title: '状态', dataIndex: 'status', width: 120, render: value => <Tag color={value === 'ACTIVE' ? 'green' : 'default'}>{value === 'ACTIVE' ? '启用' : value === 'INACTIVE' ? '停用' : value || '—'}</Tag> }
  ];

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <div className="page-heading"><div><Title level={2}>广告单元</Title><Text type="secondary">按账号查询和创建 Google Ad Manager 广告单元</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={openCreator}>新建广告单元</Button></div>
    <Card><Space wrap>
      <Select showSearch optionFilterProp="label" style={{ width: 310 }} placeholder="请选择账号" value={filterAccountId} onChange={value => { setFilterAccountId(value); setQueried(false); setRemoteUnits([]); setNextUnits(''); }} options={accountOptions}/>
      <Input style={{ width: 280 }} placeholder="广告单元名称" value={filterName} onChange={event => setFilterName(event.target.value)} onPressEnter={() => searchUnits()}/>
      <Select mode="multiple" style={{ width: 240 }} value={filterStatuses} onChange={setFilterStatuses} options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]}/>
      <Button icon={<SearchOutlined/>} loading={listBusy} onClick={() => searchUnits()}>查询广告单元</Button>
    </Space></Card>
    <Card bodyStyle={{ padding: 0 }}><Table rowKey="name" loading={listBusy} dataSource={remoteUnits} columns={remoteColumns} pagination={{ pageSize: 20 }} scroll={{ x: 900 }} locale={{ emptyText: <Empty description={queried ? '没有匹配的广告单元' : '选择账号后点击查询广告单元'}/> }}/>{nextUnits && <div style={{ textAlign: 'center', padding: 12 }}><Button loading={listBusy} onClick={() => searchUnits(lastQuery, nextUnits)}>加载更多</Button></div>}</Card>
    {results.length > 0 && <Alert type={results.some(row => row.status === 'failed') ? 'warning' : 'success'} showIcon
      message={'本次同步：成功 ' + results.filter(row => row.status === 'created').length + ' 个，失败 ' + results.filter(row => row.status === 'failed').length + ' 个'}
      description={results.some(row => row.status === 'failed') && <div style={{ maxHeight: 220, overflowY: 'auto', overflowWrap: 'anywhere' }}>
        {results.filter(row => row.status === 'failed').map(row => <div key={row.index} style={{ marginTop: 6 }}>
          {row.domain ? row.domain + ' · ' : ''}{row.code}：{row.error || '接口未返回错误详情'}
        </div>)}
      </div>}/>}
    <Collapse items={[{ key: 'history', label: '同步记录与失败重试', children: <Table rowKey="id" size="small" dataSource={creations} columns={historyColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1100 }}/> }]}/>
    <Modal title="新建广告单元" open={open} width={760} onCancel={() => { if (!publishing) setOpen(false); }} maskClosable={!publishing} closable={!publishing} footer={<Space><Button disabled={publishing} onClick={() => setOpen(false)}>取消</Button><Button type="primary" loading={publishing} disabled={inventoryBusy || !previewItems.length} onClick={publish}>{mode === 'batch' ? '批量创建' : '创建并同步'}</Button></Space>}>
      <div style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 8 }}>
        <Row gutter={[16, 12]}>
          <Col xs={24} sm={12}><Text><Text type="danger">* </Text>账号</Text><Select showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="请选择账号" value={accountId} onChange={chooseAccount} options={accountOptions}/></Col>
          <Col xs={24} sm={12}><Text><Text type="danger">* </Text>网站</Text><Select mode={mode === 'batch' ? 'multiple' : undefined} showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="从 GAM Sites 选择网站" value={mode === 'batch' ? siteNames : siteNames[0]} onChange={value => setSiteNames(Array.isArray(value) ? value : value ? [value] : [])} loading={inventoryBusy} disabled={!accountId} options={sites.map(item => ({ value: item.name, label: siteDomain(item.url) + (item.approvalStatus ? ' · ' + item.approvalStatus : '') }))}/>{nextSites && <Button size="small" onClick={loadMoreSites} loading={inventoryBusy}>加载更多网站</Button>}</Col>
          <Col span={24}><Text><Text type="danger">* </Text>命名日期</Text><div style={{ marginTop: 6 }}><DatePicker value={creationDate} onChange={setCreationDate} format="YYMMDD" allowClear={false} aria-label="命名日期"/><Text type="secondary" style={{ marginLeft: 12 }}>名称和代码自动生成：年月日-域名-广告类型</Text></div></Col>
          <Col span={24}><Alert type="info" showIcon message="创建层级：顶级广告单元" description="系统自动使用当前 GAM 账号的网络根单元，无需选择现有广告单元。"/></Col>
        </Row>
        {inventoryError && <Alert type="error" style={{ marginTop: 12 }} showIcon message={'GAM 目录加载失败：' + inventoryError} action={<Button size="small" onClick={() => setInventoryVersion(value => value + 1)}>重试</Button>}/>}
        {siteNames.map(siteName => {
          const site = sites.find(item => item.name === siteName);
          return site && <SiteDomainPicker key={siteName} site={site} knownDomains={knownDomains}
            selected={domainChoices[siteName] || []} search={domainSearch[siteName] || ''} single={mode === 'single'}
            onSearch={value => setDomainSearch(previous => ({ ...previous, [siteName]: value }))}
            onSelect={value => setDomainChoices(previous => ({ ...previous, [siteName]: value }))}/>;
        })}
        {previewError && <Alert type="warning" showIcon style={{ marginTop: 12 }} message={previewError}/>}
        {previewItems.length > 0 && <Alert type="info" showIcon style={{ marginTop: 12 }}
          message={'本次将创建 ' + previewItems.length + ' 个广告单元' + (mode === 'batch' ? '；名称与代码一致' : '')}
          description={<div data-testid="gam-unit-preview" style={{ maxHeight: 160, overflowY: 'auto' }}>{previewItems.map((item, index) => <div key={index} style={{ overflowWrap: 'anywhere' }}>{index + 1}. {item.name}{item.name !== item.code ? ' · ' + item.code : ''}</div>)}</div>}/>}
        <Tabs style={{ marginTop: 16 }} activeKey={mode} onChange={value => { setMode(value); if (value === 'single') { setSiteNames(previous => previous.slice(0, 1)); setDomainChoices(previous => Object.fromEntries(Object.entries(previous).map(([key, domains]) => [key, domains.slice(0, 1)]))); } }} items={[
          { key: 'single', label: '创建单个', children: <UnitFields row={single} index={0} onChange={changes => setSingle(previous => ({ ...previous, ...changes }))}/> },
          { key: 'batch', label: '批量创建', children: <><Text>每个域名固定创建：banner1、banner2、banner3、INT、ANC。修改日期或域名，上方预览会一起更新。</Text><Collapse style={{ marginTop: 12 }} items={[{ key: 'sizes', label: '广告尺寸设置（已预选模板）', children: batchRows.map((row, index) => <UnitFields key={row.id} row={row} index={index} fixedSuffix={batchUnitTemplates[index].suffix} onChange={changes => updateBatchRow(row.id, changes)}/>) }]}/></> }
        ]}/>
        <Collapse size="small" items={[{ key: 'advanced', label: '更多设置', children: <Row gutter={[16, 12]}>
          <Col span={24}><Text>说明</Text><Input maxLength={500} style={{ marginTop: 6 }} value={description} onChange={event => setDescription(event.target.value)}/></Col>
          <Col xs={12}><Text>目标窗口</Text><Select style={{ width: '100%', marginTop: 6 }} value={targetWindow} onChange={setTargetWindow} options={[{ value: '', label: '继承网络根单元' }, { value: 'TOP', label: 'TOP' }, { value: 'BLANK', label: 'BLANK' }]}/></Col>
          <Col xs={12}><Text>启用 AdSense</Text><div style={{ marginTop: 10 }}><Switch checked={adsenseEnabled} onChange={setAdsenseEnabled}/></div></Col>
        </Row> }]}/>
        <Text type="secondary">所选域名用于本站关联；GAM 广告单元创建在网络根单元下。手动输入仅验证所属主域名，不代表已通过 GAM 网站审核。</Text>
      </div>
    </Modal>
  </Space>;
}
