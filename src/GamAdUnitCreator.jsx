import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Collapse, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tabs, Tag, Typography, message } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { batchUnitTemplates, belongsToSite, gamBrowserSizes, prepareGamUnitItems, siteDomain } from './gam-unit-plan.mjs';
import { archivableSubdomainUnit, indexCreationRecords, mainDomainOf, resolveAdUnitDomain, scanArchivableUnits } from './gam-unit-domains.mjs';

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
const sizeOptions = (values, available = []) => [...new Set([...values, ...available])]
  .map(value => ({ value, label: sizeLabels[value] || value }));
const newRow = (type = 'banner', bannerNo = 1) => ({
  id: Math.random().toString(36).slice(2), type, bannerNo, sizes: [...typeFor(type).sizes], name: '', code: ''
});
const initialBatch = () => batchUnitTemplates.map(template => newRow(template.type, template.bannerNo));
const duplicateMessage = error => ({
  ad_unit_already_created: '当前 GAM 账号已有相同代码的创建记录',
  ad_unit_name_already_created: '当前 GAM 账号已有相同名称的创建记录',
  ad_unit_already_exists_in_gam: '当前 GAM 账号已有相同代码的广告单元',
  ad_unit_name_already_exists_in_gam: '当前 GAM 账号已有相同名称的广告单元',
  duplicate_ad_unit_code: '本批次有重复的广告单元代码',
  duplicate_ad_unit_name: '本批次有重复的广告单元名称'
})[error] || error;

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
function browserSizes(values) {
  return (values || []).filter(item => item.environmentType === 'BROWSER').map(item => {
    const size = item.size || {};
    if (size.sizeType === 'PIXEL') return size.width + 'x' + size.height;
    return { FLUID: 'fluid', INTERSTITIAL: 'out-of-page', NATIVE: 'native' }[size.sizeType] || '';
  }).filter(Boolean);
}

function UnitFields({ row, index, onChange, fixedSuffix, networkSizes }) {
  const template = typeFor(row.type);
  return <Card size="small" title={fixedSuffix || '广告单元 ' + (index + 1)} extra={fixedSuffix && <Tag>{template.label}</Tag>} style={{ marginBottom: 12 }}>
    <Row gutter={[16, 12]}>
      {!fixedSuffix && <Col xs={24} sm={row.type === 'banner' ? 12 : 24}><Text>广告类型</Text><Select style={{ width: '100%', marginTop: 6 }} value={row.type} options={unitTypes.map(item => ({ value: item.value, label: item.label }))} onChange={type => onChange({ type, bannerNo: 1, sizes: [...typeFor(type).sizes], name: '', code: '' })}/></Col>}
      {!fixedSuffix && row.type === 'banner' && <Col xs={24} sm={12}><Text>Banner 序号</Text><InputNumber min={1} max={999} precision={0} style={{ width: '100%', marginTop: 6 }} value={row.bannerNo} onChange={bannerNo => onChange({ bannerNo })}/></Col>}
      <Col span={24}><Text type="secondary">尺寸模板：{template.sizes.map(size => sizeLabels[size] || size).join('、')}；GAM 账号可选尺寸 {networkSizes.length} 种</Text><Select mode="tags" tokenSeparators={[',', '，']} style={{ width: '100%', marginTop: 6 }} value={row.sizes} options={sizeOptions(template.sizes, networkSizes)} placeholder="选择尺寸，或输入宽x高" onChange={sizes => onChange({ sizes })}/></Col>
      {!fixedSuffix && <Col xs={24} sm={12}><Text>广告单元名称（可选）</Text><Input style={{ marginTop: 6 }} value={row.name} maxLength={255} placeholder="默认：年月日-域名-广告类型" onChange={event => onChange({ name: event.target.value })}/></Col>}
      {!fixedSuffix && <Col xs={24} sm={12}><Text>广告单元代码（可选）</Text><Input style={{ marginTop: 6 }} value={row.code} maxLength={100} placeholder="默认：年月日-域名-广告类型" onChange={event => onChange({ code: event.target.value })}/></Col>}
    </Row>
  </Card>;
}

export default function GamAdUnitCreator({ accounts = [] }) {
  const activeAccounts = accounts.filter(item => item.status === 'active' && Boolean(item.enabled));
  const listAccounts = accounts.filter(item => item.status === 'active');
  const accountListKey = listAccounts.map(item => item.id + ':' + item.networkCode).join(',');
  const [filterAccountId, setFilterAccountId] = useState(null), [filterName, setFilterName] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [queried, setQueried] = useState(false), [remoteUnits, setRemoteUnits] = useState([]);
  const [lastQuery, setLastQuery] = useState(null), [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState(''), [selectedUnits, setSelectedUnits] = useState([]);
  const [editing, setEditing] = useState(null), [editLoading, setEditLoading] = useState('');
  const [savingEdit, setSavingEdit] = useState(false), [archiving, setArchiving] = useState(false);
  const listGeneration = useRef(0);
  const [open, setOpen] = useState(false), [mode, setMode] = useState('batch');
  const [accountId, setAccountId] = useState(null), [siteNames, setSiteNames] = useState([]);
  const [sites, setSites] = useState([]), [knownDomains, setKnownDomains] = useState([]);
  const [networkSizes, setNetworkSizes] = useState([]), [sizeBusy, setSizeBusy] = useState(false);
  const [sizeError, setSizeError] = useState('');
  const [domainChoices, setDomainChoices] = useState({}), [domainSearch, setDomainSearch] = useState({});
  const [nextSites, setNextSites] = useState('');
  const [inventoryBusy, setInventoryBusy] = useState(false), [inventoryError, setInventoryError] = useState('');
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [single, setSingle] = useState(newRow()), [batchRows, setBatchRows] = useState(initialBatch);
  const [creationDate, setCreationDate] = useState(() => dayjs());
  const [description, setDescription] = useState(''), [adsenseEnabled, setAdsenseEnabled] = useState(false);
  const [targetWindow, setTargetWindow] = useState('TOP');
  const [creations, setCreations] = useState([]), [results, setResults] = useState([]);
  const [domainMap, setDomainMap] = useState([]);
  const [bulkOpen, setBulkOpen] = useState(false), [bulkInput, setBulkInput] = useState('');
  const [bulkPreview, setBulkPreview] = useState(null), [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [publishing, setPublishing] = useState(false), [retrying, setRetrying] = useState(null);

  const loadCreations = async () => {
    const [history, mapping] = await Promise.all([
      api('/api/admin/gam-ad-units'), api('/api/admin/gam-ad-units/domain-map')
    ]);
    setCreations(history.items || []);
    setDomainMap(mapping.items || []);
  };
  useEffect(() => { loadCreations().catch(error => message.error(error.message)); }, []);
  const creationByResource = useMemo(() => indexCreationRecords(domainMap), [domainMap]);
  const withDomain = row => ({ ...row, ...resolveAdUnitDomain(row,
    creationByResource.get(String(row.networkCode) + ':' + row.name)) });
  const displayedUnits = useMemo(() => remoteUnits.map(withDomain), [remoteUnits, creationByResource]);
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
  useEffect(() => {
    if (!open || !accountId) return;
    let current = true;
    setNetworkSizes([]); setSizeBusy(true); setSizeError('');
    (async () => {
      const items = [], seen = new Set();
      let pageToken = '';
      do {
        const query = pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : '';
        const result = await api('/api/admin/gam-accounts/' + accountId + '/ad-unit-sizes' + query);
        items.push(...(result.items || []));
        const next = result.nextPageToken || '';
        if (next && seen.has(next)) throw new Error('GAM 尺寸分页重复');
        seen.add(next);
        pageToken = next;
      } while (pageToken && items.length < 1000);
      if (pageToken) throw new Error('GAM 尺寸数量超出限制');
      if (current) setNetworkSizes(gamBrowserSizes(items));
    })().catch(error => { if (current) setSizeError(error.message); })
      .finally(() => { if (current) setSizeBusy(false); });
    return () => { current = false; };
  }, [open, accountId]);

  const searchUnits = async (query = { accountId: filterAccountId, name: filterName, status: filterStatus }) => {
    const chosen = query.accountId ? listAccounts.filter(item => item.id === query.accountId) : listAccounts;
    if (!chosen.length) return message.warning('暂无可查询的 GAM 账号');
    const generation = ++listGeneration.current;
    setRemoteUnits([]); setSelectedUnits([]); setQueried(true); setListBusy(true); setListError(''); setLastQuery(query);
    const results = await Promise.allSettled(chosen.map(async account => {
      let pageToken = '', count = 0;
      const seen = new Set();
      do {
        const params = new URLSearchParams({ search: query.name.trim(), statuses: query.status || '' });
        if (pageToken) params.set('pageToken', pageToken);
        const result = await api('/api/admin/gam-accounts/' + account.id + '/ad-units?' + params);
        if (generation !== listGeneration.current) return;
        const rows = (result.items || []).map(row => ({ ...row, gamAccountId: account.id,
          accountName: account.name, networkCode: account.networkCode, accountEnabled: Boolean(account.enabled) }));
        setRemoteUnits(previous => [...previous, ...rows]);
        count += rows.length;
        const next = result.nextPageToken || '';
        if (next && seen.has(next)) throw new Error('GAM 广告单元分页重复');
        seen.add(next);
        pageToken = next;
      } while (pageToken && count < 10000);
      if (pageToken) throw new Error('该账号广告单元超过 10000 个，请缩小筛选范围');
    }));
    if (generation !== listGeneration.current) return;
    const failed = results.map((result, index) => result.status === 'rejected'
      ? chosen[index].name + '：' + result.reason.message : '').filter(Boolean);
    if (failed.length) setListError('部分账号查询失败：' + failed.join('；'));
    setListBusy(false);
  };
  useEffect(() => {
    if (accountListKey) searchUnits({ accountId: null, name: '', status: '' });
    return () => { listGeneration.current += 1; };
  }, [accountListKey]);
  const chooseAccount = value => {
    setAccountId(value); setSites([]); setKnownDomains([]); setNetworkSizes([]); setSizeError(''); setNextSites('');
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
      if (!lastQuery?.accountId || lastQuery.accountId === accountId) await searchUnits(lastQuery || { accountId: null, name: '', status: '' });
      const failures = rows.filter(row => row.status === 'failed').length;
      if (failures) message.warning('已创建 ' + (rows.length - failures) + ' 个，失败 ' + failures + ' 个；请查看下方逐条错误');
      else message.success('已同步 ' + rows.length + ' 个广告单元到 GAM');
    } catch (error) {
      message.error('创建失败：' + duplicateMessage(error.message));
      await loadCreations().catch(() => {});
    } finally { setPublishing(false); }
  };
  const retry = async item => {
    setRetrying(item.id);
    try { await api('/api/admin/gam-ad-units/' + item.id + '/retry', { method: 'POST' }); message.success('已同步到 GAM'); await loadCreations(); }
    catch (error) { message.error(error.message); await loadCreations(); }
    finally { setRetrying(null); }
  };
  const openEdit = async row => {
    setEditLoading(row.name);
    try {
      const result = await api('/api/admin/gam-accounts/' + row.gamAccountId + '/ad-units/' + row.name.split('/').at(-1));
      const unit = result.item;
      if (unit.status === 'ARCHIVED' || !unit.parentAdUnit) return message.warning('根单元或已归档单元不能修改');
      const original = { displayName: unit.displayName || '', description: unit.description || '',
        sizes: browserSizes(unit.adUnitSizes) };
      setEditing({ row, original, values: { ...original } });
    } catch (error) { message.error('读取广告单元失败：' + error.message); }
    finally { setEditLoading(''); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    const { row, original, values } = editing;
    const changes = {};
    if (values.displayName.trim() !== original.displayName) changes.displayName = values.displayName.trim();
    if (values.description !== original.description) changes.description = values.description;
    if (JSON.stringify(values.sizes) !== JSON.stringify(original.sizes)) changes.sizes = values.sizes;
    if (!Object.keys(changes).length) { setEditing(null); return; }
    if (!values.displayName.trim() || values.displayName.length > 255 ||
        (changes.sizes && !values.sizes.length)) return message.warning('请填写名称并至少保留一个浏览器尺寸');
    setSavingEdit(true);
    try {
      await api('/api/admin/gam-accounts/' + row.gamAccountId + '/ad-units/' + row.name.split('/').at(-1),
        { method: 'PATCH', body: JSON.stringify(changes) });
      setEditing(null); message.success('已同步修改到 GAM');
      await searchUnits(lastQuery || { accountId: null, name: '', status: '' });
      await loadCreations().catch(() => {});
    } catch (error) { message.error('修改失败：' + duplicateMessage(error.message)); }
    finally { setSavingEdit(false); }
  };
  const archiveRows = async rows => {
    if (!rows.length) return { archived: 0, failed: [] };
    const byAccount = new Map();
    for (const row of rows) byAccount.set(row.gamAccountId, [...new Set([...(byAccount.get(row.gamAccountId) || []), row.name])]);
    const batches = [...byAccount].flatMap(([gamAccountId, unitNames]) =>
      Array.from({ length: Math.ceil(unitNames.length / 100) }, (_, index) =>
        [gamAccountId, unitNames.slice(index * 100, (index + 1) * 100)]));
    setArchiving(true);
    try {
      const results = await Promise.allSettled(batches.map(([gamAccountId, unitNames]) =>
        api('/api/admin/gam-accounts/' + gamAccountId + '/ad-units/batch-archive',
          { method: 'POST', body: JSON.stringify({ names: unitNames }) })));
      const archived = results.reduce((count, result, index) => count + (result.status === 'fulfilled'
        ? batches[index][1].length : 0), 0);
      const failed = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
      setSelectedUnits([]);
      await searchUnits(lastQuery || { accountId: null, name: '', status: '' });
      return { archived, failed };
    } finally { setArchiving(false); }
  };
  const archiveUnits = async names => {
    const selected = new Set(names);
    const rows = remoteUnits.filter(row => selected.has(row.name) && row.status !== 'ARCHIVED' && row.parentAdUnit && row.accountEnabled);
    const { archived, failed } = await archiveRows(rows);
    if (failed.length) message.error('已归档 ' + archived + ' 个，部分失败：' + failed.join('；'));
    else message.success('已在 GAM 归档 ' + archived + ' 个广告单元');
  };
  const findBulkMatches = async target => {
    const [mapping, allUnits] = await Promise.all([
      api('/api/admin/gam-ad-units/domain-map'),
      scanArchivableUnits(activeAccounts, (account, pageToken) => {
        const query = new URLSearchParams({ statuses: 'ACTIVE,INACTIVE' });
        if (pageToken) query.set('pageToken', pageToken);
        return api('/api/admin/gam-accounts/' + account.id + '/ad-units?' + query);
      })
    ]);
    const records = mapping.items || [];
    setDomainMap(records);
    const byResource = indexCreationRecords(records);
    const rows = allUnits.filter(row => archivableSubdomainUnit(row, target,
      byResource.get(String(row.networkCode) + ':' + row.name)))
      .map(row => ({ ...row, ...resolveAdUnitDomain(row,
        byResource.get(String(row.networkCode) + ':' + row.name)) }));
    return { target, rows, scanned: allUnits.length };
  };
  const previewBulkArchive = async () => {
    const target = siteDomain(bulkInput);
    if (!target || target === mainDomainOf(target)) {
      setBulkError('请输入完整子域名，例如 news.example.com；主域名不能使用此批量操作。');
      setBulkPreview(null);
      return;
    }
    if (!activeAccounts.length) { setBulkError('暂无可归档的 GAM 账号'); return; }
    setBulkBusy(true); setBulkError(''); setBulkPreview(null);
    try {
      const preview = await findBulkMatches(target);
      setBulkPreview(preview);
      if (!preview.rows.length) setBulkError('未找到可确认归属且未归档的广告单元；未执行任何归档。');
    } catch (error) { setBulkError('预览不完整，已停止：' + error.message); }
    finally { setBulkBusy(false); }
  };
  const confirmBulkArchive = async () => {
    if (!bulkPreview?.rows.length || siteDomain(bulkInput) !== bulkPreview.target) return;
    setBulkBusy(true); setBulkError('');
    try {
      const fresh = await findBulkMatches(bulkPreview.target);
      const signature = result => result.rows.map(row => row.gamAccountId + ':' + row.name).sort().join('|');
      if (signature(fresh) !== signature(bulkPreview)) {
        setBulkPreview(fresh);
        setBulkError('GAM 广告单元已变化，请检查更新后的名单，再次确认。');
        return;
      }
      const { archived, failed } = await archiveRows(fresh.rows);
      setBulkPreview(null);
      if (failed.length) setBulkError('已归档 ' + archived + ' 个；部分失败：' + failed.join('；') + '。请重新预览剩余单元。');
      else { setBulkOpen(false); message.success('已在 GAM 归档 ' + archived + ' 个属于 ' + fresh.target + ' 的广告单元'); }
    } catch (error) { setBulkError('归档前核对失败，未执行批量归档：' + error.message); }
    finally { setBulkBusy(false); }
  };
  let previewItems = [], previewError = '';
  try {
    if (accountId && siteNames.length) previewItems = preparedItems();
    const existing = creations.filter(row => Number(row.gamAccountId) === Number(accountId));
    for (const item of previewItems) {
      if (existing.some(row => row.adUnitCode?.toLowerCase() === item.code.toLowerCase())) { previewError = '当前账号已有相同代码：' + item.code; break; }
      if (existing.some(row => row.displayName?.toLowerCase() === item.name.toLowerCase())) { previewError = '当前账号已有相同名称：' + item.name; break; }
    }
  } catch (error) { previewError = error.message; }
  const accountOptions = activeAccounts.map(item => ({ value: item.id, label: item.name + '（' + item.networkCode + '）' }));
  const listAccountOptions = [{ value: 'all', label: '全部 GAM 账号' },
    ...listAccounts.map(item => ({ value: item.id, label: item.name + '（' + item.networkCode + '）' }))];
  const historyColumns = [
    { title: '账号', dataIndex: 'networkCode', width: 135 }, { title: '网站', dataIndex: 'domain', width: 170 },
    { title: '广告单元', dataIndex: 'displayName', width: 210 }, { title: '代码', dataIndex: 'adUnitCode', width: 200 },
    { title: '状态', dataIndex: 'status', width: 95, render: value => <Tag color={value === 'created' ? 'green' : 'red'}>{value === 'created' ? '已同步' : '失败'}</Tag> },
    { title: 'GAM 资源名 / 错误', width: 280, ellipsis: true, render: (_, row) => row.providerId || row.publishError },
    { title: '操作', width: 80, render: (_, row) => row.status === 'failed' && <Popconfirm title={'重试同步 ' + row.adUnitCode + '？'} onConfirm={() => retry(row)}><Button size="small" loading={retrying === row.id}>重试</Button></Popconfirm> }
  ];
  const remoteColumns = [
    { title: 'GAM 账号', dataIndex: 'accountName', width: 180 },
    { title: '广告单元', dataIndex: 'displayName', width: 280 }, { title: '广告单元代码', dataIndex: 'adUnitCode', width: 230 },
    { title: '主域名', dataIndex: 'mainDomain', width: 190, render: value => value || '—' },
    { title: '子域名', dataIndex: 'subdomain', width: 210, render: (value, row) => value || (row.domain ? '—' : <Text type="secondary">未确认 · {row.source}</Text>) },
    { title: '归属依据', dataIndex: 'source', width: 145 },
    { title: '尺寸', dataIndex: 'adUnitSizes', render: remoteSizes },
    { title: '状态', dataIndex: 'status', width: 135, render: value => <Tag color={value === 'ACTIVE' ? 'green' : value === 'ARCHIVED' ? 'red' : 'default'}>
      {value === 'ACTIVE' ? '激活' : value === 'INACTIVE' ? '停用' : value === 'ARCHIVED' ? '已归档' : value || '—'}</Tag> },
    { title: '操作', width: 180, render: (_, row) => row.parentAdUnit && row.status !== 'ARCHIVED' && row.accountEnabled ? <Space>
      <Button size="small" loading={editLoading === row.name} onClick={() => openEdit(row)}>编辑</Button>
      <Popconfirm title={'归档 ' + row.displayName + '？'} description="归档后停止投放，历史报表仍保留。" okText="确认归档" cancelText="取消"
        onConfirm={() => archiveUnits([row.name])}><Button size="small" danger loading={archiving}>归档</Button></Popconfirm>
    </Space> : row.accountEnabled ? '—' : '账号已停用' }
  ];

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <div className="page-heading"><div><Title level={2}>广告单元</Title><Text type="secondary">默认列出各 GAM 账号的全部广告单元；可编辑、筛选或归档</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={openCreator}>新建广告单元</Button></div>
    <Card><Space wrap>
      <Select showSearch optionFilterProp="label" style={{ width: 310 }} value={filterAccountId ?? 'all'}
        onChange={value => { const id = value === 'all' ? null : value; setFilterAccountId(id);
          searchUnits({ accountId: id, name: filterName, status: filterStatus }); }} options={listAccountOptions}/>
      <Input style={{ width: 280 }} placeholder="广告单元名称" value={filterName} onChange={event => setFilterName(event.target.value)} onPressEnter={() => searchUnits()}/>
      <Select style={{ width: 200 }} value={filterStatus} onChange={value => { setFilterStatus(value);
        searchUnits({ accountId: filterAccountId, name: filterName, status: value }); }} options={[
        { value: '', label: '全部状态' }, { value: 'ACTIVE', label: '激活' },
        { value: 'INACTIVE', label: '停用' }, { value: 'ARCHIVED', label: '已归档' }
      ]}/>
      <Button icon={<SearchOutlined/>} loading={listBusy} onClick={() => searchUnits()}>查询广告单元</Button>
      <Popconfirm title={'归档选中的 ' + selectedUnits.length + ' 个广告单元？'}
        description="这些广告单元将在 GAM 停止投放；历史报表不会删除。" okText="确认归档" cancelText="取消"
        onConfirm={() => archiveUnits(selectedUnits)}><Button danger disabled={!selectedUnits.length} loading={archiving}>归档选中</Button></Popconfirm>
      <Button danger onClick={() => { setBulkOpen(true); setBulkInput(''); setBulkPreview(null); setBulkError(''); }}>
        按子域名批量归档</Button>
    </Space></Card>
    {listError && <Alert type="warning" showIcon message={listError} action={<Button size="small" onClick={() => searchUnits(lastQuery)}>重试</Button>}/>}
    <Card title="GAM 已存在的广告单元" extra={<Text type="secondary">{listBusy ? '正在加载…' : '共 ' + remoteUnits.length + ' 个'} · 归档后停止投放，历史报表保留</Text>} bodyStyle={{ padding: 0 }}>
      <Table rowKey="name" loading={listBusy && !remoteUnits.length} dataSource={displayedUnits} columns={remoteColumns}
        rowSelection={{ selectedRowKeys: selectedUnits, onChange: setSelectedUnits,
          getCheckboxProps: row => ({ disabled: !row.parentAdUnit || row.status === 'ARCHIVED' || !row.accountEnabled }) }}
        pagination={{ pageSize: 20 }} scroll={{ x: 1600 }} locale={{ emptyText: <Empty description={queried ? '没有匹配的广告单元' : '正在读取 GAM 广告单元'}/> }}/>
    </Card>
    {results.length > 0 && <Alert type={results.some(row => row.status === 'failed') ? 'warning' : 'success'} showIcon
      message={'本次同步：成功 ' + results.filter(row => row.status === 'created').length + ' 个，失败 ' + results.filter(row => row.status === 'failed').length + ' 个'}
      description={results.some(row => row.status === 'failed') && <div style={{ maxHeight: 220, overflowY: 'auto', overflowWrap: 'anywhere' }}>
        {results.filter(row => row.status === 'failed').map(row => <div key={row.index} style={{ marginTop: 6 }}>
          {row.domain ? row.domain + ' · ' : ''}{row.code}：{duplicateMessage(row.error || '接口未返回错误详情')}
        </div>)}
      </div>}/>}
    <Collapse items={[{ key: 'history', label: '同步记录与失败重试', children: <Table rowKey="id" size="small" dataSource={creations} columns={historyColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1100 }}/> }]}/>
    <Modal title="按子域名批量归档 GAM 广告单元" open={bulkOpen} width={1080}
      onCancel={() => { if (!bulkBusy && !archiving) setBulkOpen(false); }}
      onOk={confirmBulkArchive} okText="确认批量归档到 GAM" confirmLoading={bulkBusy || archiving}
      okButtonProps={{ danger: true, disabled: !bulkPreview?.rows.length || bulkBusy || archiving }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="info" showIcon message="只归档明确属于输入子域名的广告单元"
          description="从所有可用 GAM 账号完整扫描未归档广告单元，按本站创建记录或 GAM 代码/名称中的完整域名精确匹配。主域名、相似域名和无法确认归属的单元不会归档；历史报表保留。"/>
        <Space wrap>
          <Input style={{ width: 360 }} placeholder="输入完整子域名，如 news.example.com" value={bulkInput}
            onChange={event => { setBulkInput(event.target.value); setBulkPreview(null); setBulkError(''); }}
            onPressEnter={previewBulkArchive} disabled={bulkBusy || archiving}/>
          <Button onClick={previewBulkArchive} loading={bulkBusy} disabled={archiving}>扫描并预览</Button>
        </Space>
        {bulkError && <Alert type="warning" showIcon message={bulkError}/>}
        {bulkPreview && <>
          <Text>子域名：<strong>{bulkPreview.target}</strong> · 已扫描 {bulkPreview.scanned} 个单元 · 精确命中 <strong>{bulkPreview.rows.length}</strong> 个
            {bulkPreview.rows.length > 0 && ' · 涉及 ' + new Set(bulkPreview.rows.map(row => row.gamAccountId)).size + ' 个 GAM 账号'}</Text>
          <Table size="small" rowKey="name" dataSource={bulkPreview.rows} pagination={{ pageSize: 10 }} scroll={{ x: 1000 }}
            columns={remoteColumns.filter(col => ['accountName', 'displayName', 'adUnitCode', 'mainDomain', 'subdomain', 'status'].includes(col.dataIndex))}/>
        </>}
      </Space>
    </Modal>
    <Modal title="编辑 GAM 广告单元" open={Boolean(editing)} onCancel={() => { if (!savingEdit) setEditing(null); }}
      onOk={saveEdit} okText="保存并同步到 GAM" confirmLoading={savingEdit} okButtonProps={{ disabled: !editing?.values.displayName.trim() }}>
      {editing && <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Text type="secondary">账号：{editing.row.accountName} · 广告单元代码不可修改</Text>
        <label>广告单元代码<Input style={{ marginTop: 6 }} value={editing.row.adUnitCode} disabled/></label>
        <label>名称<Input style={{ marginTop: 6 }} maxLength={255} value={editing.values.displayName}
          onChange={event => setEditing(current => ({ ...current, values: { ...current.values, displayName: event.target.value } }))}/></label>
        <label>说明<Input.TextArea style={{ marginTop: 6 }} maxLength={65535} rows={3} value={editing.values.description}
          onChange={event => setEditing(current => ({ ...current, values: { ...current.values, description: event.target.value } }))}/></label>
        <label>浏览器广告尺寸<Select mode="tags" tokenSeparators={[',', '，']} style={{ width: '100%', marginTop: 6 }}
          value={editing.values.sizes} options={sizeOptions([...bannerSizes, ...interstitialSizes], editing.values.sizes)}
          onChange={sizes => setEditing(current => ({ ...current, values: { ...current.values, sizes } }))}/></label>
        <Text type="secondary">只修改浏览器尺寸；原有视频/音频尺寸及其他 GAM 设置保持不变。</Text>
      </Space>}
    </Modal>
    <Modal title="新建广告单元" open={open} width={760} onCancel={() => { if (!publishing) setOpen(false); }} maskClosable={!publishing} closable={!publishing} footer={<Space><Button disabled={publishing} onClick={() => setOpen(false)}>取消</Button><Button type="primary" loading={publishing} disabled={inventoryBusy || Boolean(previewError) || !previewItems.length} onClick={publish}>{mode === 'batch' ? '批量创建' : '创建并同步'}</Button></Space>}>
      <div style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 8 }}>
        <Row gutter={[16, 12]}>
          <Col xs={24} sm={12}><Text><Text type="danger">* </Text>账号</Text><Select showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="请选择账号" value={accountId} onChange={chooseAccount} options={accountOptions}/></Col>
          <Col xs={24} sm={12}><Text><Text type="danger">* </Text>网站</Text><Select mode={mode === 'batch' ? 'multiple' : undefined} showSearch optionFilterProp="label" style={{ width: '100%', marginTop: 6 }} placeholder="从 GAM Sites 选择网站" value={mode === 'batch' ? siteNames : siteNames[0]} onChange={value => setSiteNames(Array.isArray(value) ? value : value ? [value] : [])} loading={inventoryBusy} disabled={!accountId} options={sites.map(item => ({ value: item.name, label: siteDomain(item.url) + (item.approvalStatus ? ' · ' + item.approvalStatus : '') }))}/>{nextSites && <Button size="small" onClick={loadMoreSites} loading={inventoryBusy}>加载更多网站</Button>}</Col>
          <Col span={24}><Text><Text type="danger">* </Text>命名日期</Text><div style={{ marginTop: 6 }}><DatePicker value={creationDate} onChange={setCreationDate} format="YYMMDD" allowClear={false} aria-label="命名日期"/><Text type="secondary" style={{ marginLeft: 12 }}>名称和代码自动生成：年月日-域名-广告类型</Text></div></Col>
          <Col span={24}><Alert type="info" showIcon message="创建层级：顶级广告单元" description="系统自动使用当前 GAM 账号的网络根单元，无需选择现有广告单元。"/></Col>
        </Row>
        {inventoryError && <Alert type="error" style={{ marginTop: 12 }} showIcon message={'GAM 目录加载失败：' + inventoryError} action={<Button size="small" onClick={() => setInventoryVersion(value => value + 1)}>重试</Button>}/>}
        {accountId && <Text type={sizeError ? 'warning' : 'secondary'} style={{ display: 'block', marginTop: 8 }}>
          {sizeBusy ? '正在读取该账号的 GAM 尺寸…' : sizeError ? 'GAM 尺寸暂不可用，仍可使用模板或手动输入：' + sizeError : '已读取该账号的 GAM 可选尺寸；模板和手动输入仍可使用。'}
        </Text>}
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
          { key: 'single', label: '创建单个', children: <UnitFields row={single} index={0} networkSizes={networkSizes} onChange={changes => setSingle(previous => ({ ...previous, ...changes }))}/> },
          { key: 'batch', label: '批量创建', children: <><Text>每个域名固定创建：banner1、banner2、banner3、INT、ANC。修改日期或域名，上方预览会一起更新。</Text><Collapse style={{ marginTop: 12 }} items={[{ key: 'sizes', label: '广告尺寸设置（已预选模板）', children: batchRows.map((row, index) => <UnitFields key={row.id} row={row} index={index} networkSizes={networkSizes} fixedSuffix={batchUnitTemplates[index].suffix} onChange={changes => updateBatchRow(row.id, changes)}/>) }]}/></> }
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
