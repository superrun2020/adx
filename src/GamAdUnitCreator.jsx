import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Input, Popconfirm, Row, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;
const bannerSizes = ['250x250', '300x250', '320x50', '336x280'];
const interstitialSizes = ['1x1', '320x480', '480x320', '768x1024', '1024x768', 'out-of-page', 'native', 'fluid'];
const sizeLabels = { 'out-of-page': '页外', native: '自定义呈现 / Native', fluid: '自适应尺寸 / Fluid' };
const templates = [
  { id: 'ANL', label: '锚定 · ANL', sizes: ['320x50'] },
  { id: 'banner1', label: 'Banner 1', sizes: bannerSizes },
  { id: 'banner2', label: 'Banner 2', sizes: bannerSizes },
  { id: 'banner3', label: 'Banner 3', sizes: bannerSizes },
  { id: 'INT', label: '插页 · INT', sizes: interstitialSizes }
];

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'http_' + response.status);
  return payload;
}

function siteDomain(url) {
  try { return new URL(String(url).startsWith('http://') || String(url).startsWith('https://') ? url : 'https://' + url).hostname.toLowerCase(); }
  catch { return ''; }
}

const sizeOptions = values => values.map(value => ({ value, label: sizeLabels[value] || value }));

export default function GamAdUnitCreator({ accounts }) {
  const [accountId, setAccountId] = useState(null);
  const [sites, setSites] = useState([]), [parents, setParents] = useState([]);
  const [nextSites, setNextSites] = useState(''), [nextParents, setNextParents] = useState('');
  const [selectedSites, setSelectedSites] = useState([]), [parentAdUnit, setParentAdUnit] = useState('');
  const [selectedTemplates, setSelectedTemplates] = useState([]), [templateSizes, setTemplateSizes] = useState({ ANL: ['320x50'] });
  const [description, setDescription] = useState(''), [adsenseEnabled, setAdsenseEnabled] = useState(false);
  const [targetWindow, setTargetWindow] = useState(''), [drafts, setDrafts] = useState([]);
  const [creations, setCreations] = useState([]), [results, setResults] = useState([]);
  const [busy, setBusy] = useState(''), [inventoryError, setInventoryError] = useState('');
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const activeAccounts = accounts.filter(item => item.status === 'active');

  const loadCreations = () => api('/api/admin/gam-ad-units').then(result => setCreations(result.items || []));
  useEffect(() => { loadCreations().catch(error => message.error(error.message)); }, []);
  useEffect(() => {
    if (!accountId) return;
    let current = true;
    setBusy('inventory'); setInventoryError('');
    Promise.all([
      api('/api/admin/gam-accounts/' + accountId + '/sites'),
      api('/api/admin/gam-accounts/' + accountId + '/ad-units')
    ]).then(([siteResult, unitResult]) => {
      if (!current) return;
      setSites(siteResult.items || []); setNextSites(siteResult.nextPageToken || '');
      setParents(unitResult.items || []); setNextParents(unitResult.nextPageToken || '');
    }).catch(error => { if (current) setInventoryError(error.message); })
      .finally(() => { if (current) setBusy(''); });
    return () => { current = false; };
  }, [accountId, inventoryVersion]);

  const chooseAccount = value => {
    setAccountId(value); setSites([]); setParents([]); setNextSites(''); setNextParents('');
    setSelectedSites([]); setParentAdUnit(''); setDrafts([]); setResults([]);
  };
  const loadMore = async kind => {
    const token = kind === 'sites' ? nextSites : nextParents;
    if (!token || !accountId) return;
    setBusy(kind);
    try {
      const result = await api('/api/admin/gam-accounts/' + accountId + '/' + (kind === 'sites' ? 'sites' : 'ad-units') + '?pageToken=' + encodeURIComponent(token));
      if (kind === 'sites') {
        setSites(previous => [...new Map([...previous, ...(result.items || [])].map(item => [item.name, item])).values()]);
        setNextSites(result.nextPageToken || '');
      } else {
        setParents(previous => [...new Map([...previous, ...(result.items || [])].map(item => [item.name, item])).values()]);
        setNextParents(result.nextPageToken || '');
      }
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };
  const updateDraft = (key, changes) => setDrafts(previous => previous.map(item => item.key === key ? { ...item, ...changes } : item));
  const preview = () => {
    if (!accountId || !parentAdUnit || !selectedSites.length || !selectedTemplates.length)
      return message.warning('请选择账户、域名、父广告单元和版位模板');
    const chosen = selectedTemplates.map(id => templates.find(item => item.id === id));
    if (chosen.some(item => !templateSizes[item.id]?.length)) return message.warning('请为每个版位模板选择至少一个尺寸');
    if (selectedSites.length * chosen.length > 50) return message.warning('每批最多 50 个广告单元，请分批创建');
    const rows = selectedSites.flatMap(siteName => {
      const domain = siteDomain(sites.find(item => item.name === siteName)?.url || '');
      return chosen.map(item => {
        const code = domain + '-' + item.id;
        return { key: siteName + '/' + item.id, siteName, domain, templateId: item.id,
          gamAccountId: accountId, parentAdUnit, code, name: code,
          sizes: templateSizes[item.id], description, adsenseEnabled, targetWindow };
      });
    });
    if (rows.some(row => !row.domain) || new Set(rows.map(row => row.code.toLowerCase())).size !== rows.length)
      return message.error('所选 GAM 网站域名为空或重复，请调整选择');
    setDrafts(rows); setResults([]);
  };
  const publish = async () => {
    if (!drafts.length) return;
    if (drafts.some(row => !row.name.trim() || !row.code.trim() || !row.sizes.length) ||
        new Set(drafts.map(row => row.code.toLowerCase())).size !== drafts.length)
      return message.error('名称、编码和尺寸必填，且同批编码不能重复');
    setBusy('publish');
    try {
      const payload = await api('/api/admin/gam-ad-units/batch', { method: 'POST',
        body: JSON.stringify({ gamAccountId: accountId, items: drafts }) });
      setResults(payload.results || []); setDrafts([]);
      await loadCreations();
      if (payload.failed) message.warning('已同步 ' + payload.created + ' 个，失败 ' + payload.failed + ' 个；可查看下方详情');
      else message.success('已同步 ' + payload.created + ' 个广告单元到 GAM');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };
  const retry = async item => {
    setBusy('retry:' + item.id);
    try {
      await api('/api/admin/gam-ad-units/' + item.id + '/retry', { method: 'POST' });
      message.success('已同步到 GAM'); await loadCreations();
    } catch (error) { message.error(error.message); await loadCreations(); }
    finally { setBusy(''); }
  };
  const draftColumns = [
    { title: '域名', dataIndex: 'domain', width: 180 },
    { title: '模板', dataIndex: 'templateId', width: 100 },
    { title: '名称', dataIndex: 'name', width: 220, render: (value, row) => <Input value={value} onChange={event => updateDraft(row.key, { name: event.target.value })}/> },
    { title: '编码', dataIndex: 'code', width: 220, render: (value, row) => <Input value={value} onChange={event => updateDraft(row.key, { code: event.target.value })}/> },
    { title: '尺寸', dataIndex: 'sizes', width: 260, render: (value, row) => <Select mode="tags" tokenSeparators={[',', '，']} style={{ width: '100%' }} value={value} options={sizeOptions(templates.find(item => item.id === row.templateId)?.sizes || [])} onChange={sizes => updateDraft(row.key, { sizes })}/> }
  ];

  return <>
    <Alert type="info" showIcon message="GAM REST 同步" description="从所选账户实时读取 Sites 域名和父广告单元。域名关联保存在本站；GAM AdUnit API 没有直接绑定 Site 的字段。请预览名称、编码和尺寸后再创建。"/>
    <Card title="快速批量创建并同步到 GAM" extra={<Button icon={<ReloadOutlined/>} onClick={() => loadCreations().catch(error => message.error(error.message))}>刷新记录</Button>}>
      <Row gutter={[16, 12]}>
        <Col xs={24} lg={8}><Text strong>Ad Manager 账户</Text><Select showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="选择已连接的 REST 账户" value={accountId} onChange={chooseAccount} options={activeAccounts.map(item => ({ value: item.id, label: item.name + '（' + item.networkCode + '）' }))}/></Col>
        <Col xs={24} lg={8}><Text strong>账户域名 · GAM Sites</Text><Select mode="multiple" showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="可选择多个域名" value={selectedSites} onChange={value => { setSelectedSites(value); setDrafts([]); }} loading={busy === 'inventory'} disabled={!accountId} options={sites.map(item => ({ value: item.name, label: siteDomain(item.url) + (item.approvalStatus ? ' · ' + item.approvalStatus : '') }))}/>{nextSites && <Button size="small" loading={busy === 'sites'} onClick={() => loadMore('sites')}>加载更多域名</Button>}</Col>
        <Col xs={24} lg={8}><Text strong>父广告单元</Text><Select showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="从此账户选择父单元" value={parentAdUnit || undefined} onChange={value => { setParentAdUnit(value); setDrafts([]); }} loading={busy === 'inventory'} disabled={!accountId} options={parents.map(item => ({ value: item.name, label: item.displayName + '（' + item.name + '）' }))}/>{nextParents && <Button size="small" loading={busy === 'ad-units'} onClick={() => loadMore('ad-units')}>加载更多父单元</Button>}</Col>
      </Row>
      {inventoryError && <Alert style={{ marginTop: 12 }} type="error" showIcon message={'账户目录加载失败：' + inventoryError} action={<Button size="small" onClick={() => setInventoryVersion(value => value + 1)}>重试</Button>}/>}
      <div style={{ marginTop: 18 }}><Text strong>版位模板与尺寸</Text></div>
      <Select mode="multiple" style={{ width: '100%', marginTop: 6 }} placeholder="可选择 ANL、Banner 1/2/3、INT 组合" value={selectedTemplates} onChange={value => { setSelectedTemplates(value); setDrafts([]); }} options={templates.map(item => ({ value: item.id, label: item.label }))}/>
      <Row gutter={[16, 12]} style={{ marginTop: 12 }}>{selectedTemplates.map(id => {
        const item = templates.find(entry => entry.id === id);
        return <Col xs={24} md={12} xl={8} key={id}><Text>{item.label} 尺寸</Text><Select mode="tags" tokenSeparators={[',', '，']} style={{ width: '100%', marginTop: 6 }} placeholder="选择模板尺寸，或输入宽x高" value={templateSizes[id] || []} onChange={value => { setTemplateSizes(previous => ({ ...previous, [id]: value })); setDrafts([]); }} options={sizeOptions(item.sizes)}/></Col>;
      })}</Row>
      <Row gutter={[16, 12]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}><Text>说明（可选）</Text><Input style={{ marginTop: 6 }} value={description} onChange={event => { setDescription(event.target.value); setDrafts([]); }} maxLength={500}/></Col>
        <Col xs={12} md={5}><Text>目标窗口</Text><Select style={{ width: '100%', marginTop: 6 }} value={targetWindow} onChange={value => { setTargetWindow(value); setDrafts([]); }} options={[{ value: '', label: '继承父单元' }, { value: 'TOP', label: 'TOP' }, { value: 'BLANK', label: 'BLANK' }]}/></Col>
        <Col xs={12} md={5}><Text>启用 AdSense</Text><div style={{ marginTop: 10 }}><Switch checked={adsenseEnabled} onChange={value => { setAdsenseEnabled(value); setDrafts([]); }}/></div></Col>
      </Row>
      <Button style={{ marginTop: 16 }} onClick={preview} disabled={busy === 'inventory'}>生成批量预览</Button>
    </Card>
    {drafts.length > 0 && <Card title={'待同步预览 · ' + drafts.length + ' 个'} extra={<Popconfirm title={'确认创建并同步 ' + drafts.length + ' 个广告单元到 GAM？'} onConfirm={publish}><Button type="primary" loading={busy === 'publish'}>确认创建并同步</Button></Popconfirm>}>
      <Table rowKey="key" size="small" dataSource={drafts} columns={draftColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1050 }}/>
    </Card>}
    {results.length > 0 && <Card title="本次同步结果"><Table rowKey="index" size="small" dataSource={results} pagination={{ pageSize: 10 }} columns={[{ title: '域名', dataIndex: 'siteName', render: value => siteDomain(sites.find(item => item.name === value)?.url || '') || value }, { title: '编码', dataIndex: 'code' }, { title: '状态', dataIndex: 'status', render: value => <Tag color={value === 'created' ? 'green' : 'red'}>{value === 'created' ? '已同步' : '失败'}</Tag> }, { title: '结果', render: (_, row) => row.item?.providerId || row.error }]}/></Card>}
    <Card title="GAM 广告单元同步记录"><Table rowKey="id" size="small" dataSource={creations} scroll={{ x: 1150 }} pagination={{ pageSize: 20 }} columns={[
      { title: '账户', dataIndex: 'networkCode', width: 130 }, { title: '域名', dataIndex: 'domain', width: 190 },
      { title: '编码', dataIndex: 'adUnitCode', width: 210 }, { title: '名称', dataIndex: 'displayName', width: 210 },
      { title: '尺寸', dataIndex: 'sizesJson', width: 170, render: value => { try { return JSON.parse(value).map(size => sizeLabels[size] || size).join('、'); } catch { return value; } } },
      { title: '状态', dataIndex: 'status', width: 90, render: value => <Tag color={value === 'created' ? 'green' : 'red'}>{value === 'created' ? '已同步' : '失败'}</Tag> },
      { title: 'GAM 资源名', dataIndex: 'providerId', width: 280, ellipsis: true },
      { title: '错误', dataIndex: 'publishError', width: 220, ellipsis: true },
      { title: '操作', width: 80, render: (_, row) => row.status === 'failed' && <Popconfirm title={'重试同步 ' + row.adUnitCode + '？'} onConfirm={() => retry(row)}><Button size="small" loading={busy === 'retry:' + row.id}>重试</Button></Popconfirm> }
    ]}/></Card>
  </>;
}
