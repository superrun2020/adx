import React, { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Checkbox, Drawer, Input, InputNumber, Select, Space, Table, Typography, message } from 'antd';
import { BarChartOutlined, DownloadOutlined, FilterOutlined, ReloadOutlined } from '@ant-design/icons';
import { readCached, rememberRead } from './readCache.js';
import ReportDateFilter from './ReportDateFilter.jsx';

const { Title, Text } = Typography;
const dimensions = [
  ['date','日期'], ['hour','小时'], ['url','网站'], ['account','账号'],
  ['advertiser','广告主'], ['channel','渠道'], ['bd','BD'], ['country','国家/地区'],
  ['adUnit','广告单元'], ['adUnitId','广告单元 ID']
];
const coreMetrics = [
  ['requests','请求次数'], ['matchedRequests','匹配次数'], ['impressions','展示次数'],
  ['clicks','点击次数'], ['revenue','收入'], ['matchRate','匹配率'],
  ['impressionRate','展示率'], ['clickRate','点击率'], ['ecpm','eCPM']
];
const adminMetrics = [
  ['upstreamRevenue','上游分成后'], ['channelRevenue','渠道结算'],
  ['grossProfit','毛利'], ['upstreamSharePercent','上游比例'],
  ['channelSharePercent','渠道比例']
];
const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const number = value => Number(value || 0).toLocaleString('zh-CN');
const pct = value => Number(value || 0).toFixed(2) + '%';
const defaultFilters = { source:'rest', upstreamAccount:'', channelId:'', advertiser:'', bd:'',
  adUnit:'', adUnitId:'', domain:'', domainMatch:'contains', country:'', hour:'', minRequests:'',
  minRevenue:'', minMatchRate:'', minEcpm:'' };
const defaultDimensions = ['url','adUnit','adUnitId'];
const width = { date:115, hour:75, account:170, channel:140, advertiser:150, bd:130,
  url:240, country:90, adUnit:240, adUnitId:150 };
const defaultReportPath = range => '/api/reports?' + new URLSearchParams({
  start:range[0].format('YYYY-MM-DD'), end:range[1].format('YYYY-MM-DD'),
  dimensions:defaultDimensions.join(','), page:'1', pageSize:'50', source:'rest'
});

async function getJson(path) {
  const response = await fetch(path, { credentials:'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  return data;
}
function metricColumns(selected, admin) {
  return selected.map(key => {
    const label = [...coreMetrics, ...(admin ? adminMetrics : [])].find(([id]) => id === key)?.[1] || key;
    const render = key.toLowerCase().includes('rate') || key.endsWith('Percent') ? pct
      : ['revenue','ecpm','grossProfit'].some(part => key.toLowerCase().includes(part.toLowerCase())) ? money : number;
    return { title:label, dataIndex:key, width:125, align:'right', render };
  });
}

export default function ReportExplorer({ range, setRange, admin, user }) {
  const [selectedDimensions, setSelectedDimensions] = useState(defaultDimensions);
  const [selectedMetrics, setSelectedMetrics] = useState(coreMetrics.map(([key]) => key));
  const [filters, setFilters] = useState(defaultFilters), [applied, setApplied] = useState(defaultFilters);
  const [options, setOptions] = useState({ accounts:[], channels:[] });
  const [rows, setRows] = useState(() => readCached(user, defaultReportPath(range))?.data?.items || []);
  const [total, setTotal] = useState(() => readCached(user, defaultReportPath(range))?.data?.total || 0);
  const [cachedRows, setCachedRows] = useState(() => Boolean(readCached(user, defaultReportPath(range))));
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(50);
  const [dailyRows, setDailyRows] = useState([]), [dailyTotal, setDailyTotal] = useState(0);
  const [dailyBreakdown, setDailyBreakdown] = useState('');
  const [dailyPage, setDailyPage] = useState(1), [dailyPageSize, setDailyPageSize] = useState(10);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyCached, setDailyCached] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false), [exporting, setExporting] = useState(false);
  const shownDimensions = dimensions.filter(([key]) => admin || !['channel','advertiser','bd'].includes(key));
  const dailyBreakdownOptions = [{value:'',label:'仅按日期'},
    ...shownDimensions.filter(([key]) => !['date','hour'].includes(key))
      .map(([value,label]) => ({value,label:'日期 + ' + label}))];
  const shownMetrics = [...coreMetrics, ...(admin ? adminMetrics : [])];
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]:value ?? '' }));
  const params = (dims, pageNumber, size, extra = {}) => new URLSearchParams({
    start:range[0].format('YYYY-MM-DD'), end:range[1].format('YYYY-MM-DD'),
    dimensions:dims.join(','), page:String(pageNumber), pageSize:String(size),
    ...Object.fromEntries(Object.entries(applied).filter(([key,value]) =>
      String(value).trim() !== '' && (key !== 'domainMatch' || applied.domain.trim()))),
    ...extra
  });
  useEffect(() => {
    if (!admin) return;
    getJson('/api/admin/reports/filter-options')
      .then(data => setOptions({ accounts:data.accounts || [], channels:data.channels || [] }))
      .catch(cause => message.error('筛选项加载失败：' + cause.message));
  }, [admin]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    const extra = selectedDate && selectedDimensions.includes('date')
      ? { drill:JSON.stringify({ date:selectedDate }) } : {};
    const path = '/api/reports?' + params(selectedDimensions,page,pageSize,extra);
    const saved = readCached(user, path);
    setRows(saved?.data?.items || []); setTotal(saved?.data?.total || 0); setCachedRows(Boolean(saved));
    getJson(path)
      .then(data => { if (active) { rememberRead(user, path, data); setRows(data.items || []); setTotal(data.total || 0); setCachedRows(false); } })
      .catch(cause => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range[0].valueOf(),range[1].valueOf(),selectedDimensions.join(','),applied,page,pageSize,selectedDate]);
  useEffect(() => {
    if (!selectedDimensions.includes('date')) { setDailyRows([]); setDailyTotal(0); setDailyCached(false); return; }
    let active = true; setDailyLoading(true);
    const path = '/api/reports?' + params(['date', ...(dailyBreakdown ? [dailyBreakdown] : [])],dailyPage,dailyPageSize);
    const saved = readCached(user, path);
    setDailyRows(saved?.data?.items || []); setDailyTotal(saved?.data?.total || 0); setDailyCached(Boolean(saved));
    getJson(path)
      .then(data => { if (active) {
        if (dailyPage > 1 && !(data.items || []).length) { setDailyPage(1); return; }
        rememberRead(user, path, data); setDailyRows(data.items || []);
        setDailyTotal(data.total || 0); setDailyCached(false);
      } })
      .catch(cause => { if (active) message.error('每日汇总加载失败：' + cause.message); })
      .finally(() => { if (active) setDailyLoading(false); });
    return () => { active = false; };
  }, [range[0].valueOf(),range[1].valueOf(),applied,dailyBreakdown,dailyPage,dailyPageSize,selectedDimensions.includes('date')]);
  const search = () => { setPage(1); setDailyPage(1); setSelectedDate(null); setApplied({ ...filters }); setFilterOpen(false); };
  const reset = () => { setFilters(defaultFilters); setApplied(defaultFilters); setPage(1); setDailyPage(1); setSelectedDate(null);
    setSelectedDimensions(defaultDimensions); setSelectedMetrics(coreMetrics.map(([key]) => key)); };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const query = params(selectedDimensions,1,50000,{
        metrics:selectedMetrics.join(','),
        ...(selectedDate && selectedDimensions.includes('date') ? {drill:JSON.stringify({date:selectedDate})} : {})
      });
      const response = await fetch('/api/reports/export?' + query, { credentials:'include' });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'http_' + response.status); }
      const blob = await response.blob(), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'adx-report.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { message.error(cause.message); } finally { setExporting(false); }
  };
  const dimensionColumns = dims => dims.map(key => ({
    title:dimensions.find(([id]) => id === key)?.[1] || key, dataIndex:key, width:width[key],
    render:value => value === null || value === undefined || value === '' ? '—' : String(value)
  }));
  const columns = [...dimensionColumns(selectedDimensions),...metricColumns(selectedMetrics,admin)];
  const dailyColumns = [{title:'日期',dataIndex:'date',width:130,fixed:'left'},
    ...dimensionColumns(dailyBreakdown ? [dailyBreakdown] : []),
    ...metricColumns(selectedMetrics,admin)];
  return <Space direction="vertical" size={16} className="page-stack report-explorer">
    <div className="page-heading"><div><Title level={2}>数据报告</Title>
      <Text type="secondary">按多维度查询、分析 Ad Manager 原始收益数据</Text>{cachedRows && <Text type="secondary" style={{marginLeft:10}}>已显示缓存数据{loading ? '，正在更新' : ''}</Text>}</div>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={() => setApplied({ ...applied })}>刷新</Button></div>
    {error && <Alert type="error" showIcon message="报表加载失败" description={error}/>}
    <Card className="report-query-card">
      <div className="report-query-grid">
        <label className="report-filter-field report-filter-date"><span>日期范围</span><ReportDateFilter value={range} onChange={value => {
          setPage(1); setDailyPage(1); setSelectedDate(null); setRange(value);
        }}/></label>
        <label className="report-filter-field"><span>域名</span><Space.Compact block>
          <Select aria-label="域名匹配方式" value={filters.domainMatch} onChange={value => setFilter('domainMatch',value)}
            options={[{value:'contains',label:'模糊匹配'},{value:'exact',label:'精确匹配'}]} style={{width:112,flex:'none'}}/>
          <Input allowClear placeholder="输入域名关键字" value={filters.domain} onChange={event => setFilter('domain',event.target.value)}/>
        </Space.Compact></label>
        {admin && <label className="report-filter-field"><span>账号</span><AutoComplete allowClear
          placeholder="全部账号" value={filters.upstreamAccount || undefined} onChange={value => setFilter('upstreamAccount',value)}
          options={options.accounts.map(item => ({ value:item.accountKey, label:item.name + '（' + item.accountKey + '）' }))}/></label>}
        {admin && <label className="report-filter-field"><span>广告主</span><AutoComplete allowClear
          placeholder="全部广告主" value={filters.advertiser} onChange={value => setFilter('advertiser',value)}
          options={[...new Set(options.accounts.map(item => item.advertiser).filter(Boolean))].map(value => ({ value }))}/></label>}
        {admin && <label className="report-filter-field"><span>渠道</span><Select allowClear showSearch optionFilterProp="label"
          placeholder="全部渠道" value={filters.channelId || undefined} onChange={value => setFilter('channelId',value)}
          options={options.channels.map(item => ({ value:String(item.id), label:item.name }))}/></label>}
      </div>
      <div className="report-choice-row"><span className="report-choice-label">维度</span>
        <Checkbox.Group value={selectedDimensions} options={shownDimensions.map(([value,label]) => ({value,label}))}
          onChange={value => { if (value.length) {
            setPage(1); setDailyPage(1);
            if (!value.includes('date')) setSelectedDate(null);
            setSelectedDimensions(value.includes('date') ? ['date', ...value.filter(key => key !== 'date')] : value);
          } }}/></div>
      <div className="report-choice-row"><span className="report-choice-label">指标</span>
        <Checkbox.Group value={selectedMetrics} options={shownMetrics.map(([value,label]) => ({value,label}))}
          onChange={value => value.length && setSelectedMetrics(value)}/></div>
      <div className="report-query-actions"><Button icon={<FilterOutlined/>} onClick={() => setFilterOpen(true)}>更多筛选</Button>
        <span className="report-actions-spacer"/><Button onClick={reset}>重置</Button>
        <Button icon={<DownloadOutlined/>} loading={exporting} onClick={exportCsv}>导出 CSV</Button>
        <Button type="primary" icon={<BarChartOutlined/>} onClick={search}>查询收益</Button></div>
    </Card>
    <Card className="report-results-card" title="收益明细" extra={<Space><Text type="secondary">{range[0].format('YYYY-MM-DD')} 至 {range[1].format('YYYY-MM-DD')} · 共 {number(total)} 组</Text>
      {selectedDate && <Button size="small" onClick={() => { setPage(1); setSelectedDate(null); }}>全部日期</Button>}</Space>}>
      <Table size="small" rowKey={(row,index) => String(page) + '-' + index} loading={loading && !cachedRows} dataSource={rows}
        columns={columns} scroll={{x:'max-content'}} pagination={{ current:page, pageSize, total, showSizeChanger:true, pageSizeOptions:[20,50,100,200],
          onChange:(next,size) => { setPage(next); setPageSize(size); } }}
        locale={{emptyText:'该条件下没有已同步的 REST 数据'}}/></Card>
    {selectedDimensions.includes('date') && <Card title="所选区间每日汇总"
      extra={<Space wrap><Text type="secondary">{range[0].format('YYYY-MM-DD')} 至 {range[1].format('YYYY-MM-DD')} · 共 {number(dailyTotal)} {dailyBreakdown ? '组' : '个有数据日期'}</Text>
        <Select aria-label="每日汇总分组维度" value={dailyBreakdown} options={dailyBreakdownOptions} style={{width:190}}
          onChange={value => { setDailyPage(1); setPage(1); setSelectedDate(null); setDailyBreakdown(value); }}/></Space>}>
      <Text type="secondary">按最新日期排序；汇总列随上方“显示指标”变化。{dailyBreakdown ? '可在上方调整分组维度查看不同汇总。' : '点击日期可筛选下方表格，再点一次或选择“全部日期”恢复整个区间。'}</Text>
      <Table style={{marginTop:12}} size="small" rowKey={row => dailyBreakdown
        ? row.date + ':' + String(dailyBreakdown === 'channel' ? row.channelId : row[dailyBreakdown]) : row.date}
        loading={dailyLoading && !dailyCached} dataSource={dailyRows}
        columns={dailyColumns}
        scroll={{x:'max-content'}} onRow={dailyBreakdown ? undefined : row => ({
          onClick:() => { setPage(1); setSelectedDate(current => current === row.date ? null : row.date); },
          style:{cursor:'pointer',background:selectedDate === row.date ? 'var(--report-accent-soft)' : undefined}
        })} pagination={{current:dailyPage,pageSize:dailyPageSize,total:dailyTotal,
          showSizeChanger:true,pageSizeOptions:['5','10','20','50'],
          showTotal:(count, span) => count ? span[0] + '-' + span[1] + ' / 共 ' + count + (dailyBreakdown ? ' 组' : ' 天') : '共 0 ' + (dailyBreakdown ? '组' : '天'),
          onChange:(next,size) => { setDailyPage(size === dailyPageSize ? next : 1); setDailyPageSize(size); }}}
        locale={{emptyText:'所选日期范围内没有已同步的数据'}}/>
    </Card>}
    <Drawer title="更多筛选" open={filterOpen} onClose={() => setFilterOpen(false)} width={420}
      extra={<Button type="primary" onClick={search}>应用筛选</Button>}>
      <Space direction="vertical" style={{width:'100%'}} size={14}>
        <label>数据来源<Select value={filters.source} onChange={value => setFilter('source',value)}
          options={[{value:'rest',label:'Google REST 实际同步'},{value:'all',label:'全部来源'}]} style={{width:'100%'}}/></label>
        <label>广告单元名称<Input value={filters.adUnit} onChange={event => setFilter('adUnit',event.target.value)}/></label>
        {admin && <label>BD<Input value={filters.bd} onChange={event => setFilter('bd',event.target.value)}/></label>}
        <label>广告单元 ID<Input value={filters.adUnitId} onChange={event => setFilter('adUnitId',event.target.value)}/></label>
        <label>国家代码<Input value={filters.country} onChange={event => setFilter('country',event.target.value)}/></label>
        <label>小时<InputNumber min={0} max={23} value={filters.hour === '' ? null : Number(filters.hour)}
          onChange={value => setFilter('hour',value)} style={{width:'100%'}}/></label>
        <label>最低请求数<InputNumber min={0} value={filters.minRequests === '' ? null : Number(filters.minRequests)}
          onChange={value => setFilter('minRequests',value)} style={{width:'100%'}}/></label>
        <label>最低收入（美元）<InputNumber min={0} value={filters.minRevenue === '' ? null : Number(filters.minRevenue)}
          onChange={value => setFilter('minRevenue',value)} style={{width:'100%'}}/></label>
        <label>最低匹配率（%）<InputNumber min={0} max={100} value={filters.minMatchRate === '' ? null : Number(filters.minMatchRate)}
          onChange={value => setFilter('minMatchRate',value)} style={{width:'100%'}}/></label>
        <label>最低 eCPM（美元）<InputNumber min={0} value={filters.minEcpm === '' ? null : Number(filters.minEcpm)}
          onChange={value => setFilter('minEcpm',value)} style={{width:'100%'}}/></label>
      </Space></Drawer>
  </Space>;
}
