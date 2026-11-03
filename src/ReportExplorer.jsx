import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Drawer, Input, InputNumber, Modal, Row, Select, Space, Statistic, Table, Typography, message } from 'antd';
import { BarChartOutlined, DownloadOutlined, FilterOutlined, ReloadOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;
const dimensions = [
  ['date','日期'], ['hour','小时'], ['account','上游账号'], ['channel','渠道'],
  ['advertiser','广告主'], ['bd','BD'], ['url','网站'], ['country','国家'],
  ['adUnit','广告单元'], ['adUnitId','广告单元 ID']
];
const coreMetrics = [
  ['requests','请求'], ['matchedRequests','响应'], ['impressions','展示'],
  ['clicks','点击'], ['revenue','收入'], ['matchRate','匹配率'],
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
  adUnit:'', adUnitId:'', domain:'', country:'', hour:'', minRequests:'',
  minRevenue:'', minMatchRate:'', minEcpm:'' };
const width = { date:115, hour:75, account:170, channel:140, advertiser:150, bd:130,
  url:240, country:90, adUnit:240, adUnitId:150 };

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

export default function ReportExplorer({ range, setRange, admin }) {
  const [selectedDimensions, setSelectedDimensions] = useState(['date','account','url','adUnit','adUnitId']);
  const [selectedMetrics, setSelectedMetrics] = useState(coreMetrics.map(([key]) => key));
  const [filters, setFilters] = useState(defaultFilters), [applied, setApplied] = useState(defaultFilters);
  const [options, setOptions] = useState({ accounts:[], channels:[] });
  const [rows, setRows] = useState([]), [total, setTotal] = useState(0);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false), [exporting, setExporting] = useState(false);
  const [drill, setDrill] = useState(null), [detailRows, setDetailRows] = useState([]);
  const [detailTotal, setDetailTotal] = useState(0), [detailPage, setDetailPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const shownDimensions = dimensions.filter(([key]) => admin || !['channel','advertiser','bd'].includes(key));
  const shownMetrics = [...coreMetrics, ...(admin ? adminMetrics : [])];
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]:value ?? '' }));
  const params = (dims, pageNumber, size, extra = {}) => new URLSearchParams({
    start:range[0].format('YYYY-MM-DD'), end:range[1].format('YYYY-MM-DD'),
    dimensions:dims.join(','), page:String(pageNumber), pageSize:String(size),
    ...Object.fromEntries(Object.entries(applied).filter(([,value]) => String(value).trim() !== '')),
    ...extra
  });
  useEffect(() => {
    if (!admin) return;
    Promise.all([getJson('/api/admin/upstream-accounts'),getJson('/api/admin/channels')])
      .then(([accounts,channels]) => setOptions({ accounts:accounts.items || [], channels:channels.items || [] }))
      .catch(cause => message.error('筛选项加载失败：' + cause.message));
  }, [admin]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    getJson('/api/reports?' + params(selectedDimensions,page,pageSize))
      .then(data => { if (active) { setRows(data.items || []); setTotal(data.total || 0); } })
      .catch(cause => { if (active) { setError(cause.message); setRows([]); setTotal(0); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range[0].valueOf(),range[1].valueOf(),selectedDimensions.join(','),applied,page,pageSize]);
  const detailDimensions = shownDimensions.map(([key]) => key);
  useEffect(() => {
    if (!drill) return;
    let active = true; setDetailLoading(true);
    getJson('/api/reports?' + params(detailDimensions,detailPage,50,{ drill:JSON.stringify(drill.values) }))
      .then(data => { if (active) { setDetailRows(data.items || []); setDetailTotal(data.total || 0); } })
      .catch(cause => { if (active) message.error(cause.message); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [drill,detailPage]);
  const search = () => { setPage(1); setApplied({ ...filters }); setFilterOpen(false); };
  const reset = () => { setFilters(defaultFilters); setApplied(defaultFilters); setPage(1);
    setSelectedDimensions(['date','account','url','adUnit','adUnitId']); setSelectedMetrics(coreMetrics.map(([key]) => key)); };
  const openDetail = row => {
    const values = Object.fromEntries(selectedDimensions.map(key =>
      [key, key === 'channel' ? row.channelId : key === 'url' ? row.rawUrl : row[key]]));
    setDetailRows([]); setDetailTotal(0); setDetailPage(1); setDrill({ row, values });
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const query = params(selectedDimensions,1,50000,{ metrics:selectedMetrics.join(',') });
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
  const detailColumns = [...dimensionColumns(detailDimensions),...metricColumns(selectedMetrics,admin)];
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>数据报告</Title>
      <Text type="secondary">Google Ad Manager REST 同步数据；支持多维查询、指标筛选和点击下钻</Text></div>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={() => setApplied({ ...applied })}>刷新</Button></div>
    {error && <Alert type="error" showIcon message="报表加载失败" description={error}/>}
    <Card><Space wrap>
      <DatePicker.RangePicker value={range} onChange={value => value && setRange(value)}/>
      {admin && <Select allowClear showSearch placeholder="上游账号" value={filters.upstreamAccount || undefined}
        onChange={value => setFilter('upstreamAccount',value)}
        options={options.accounts.map(item => ({ value:item.accountKey, label:item.name + '（' + item.accountKey + '）' }))} style={{width:220}}/>}
      {admin && <Select allowClear showSearch placeholder="渠道" value={filters.channelId || undefined}
        onChange={value => setFilter('channelId',value)}
        options={options.channels.map(item => ({ value:String(item.id), label:item.name }))} style={{width:150}}/>}
      <Input placeholder="广告单元名称" value={filters.adUnit} onChange={event => setFilter('adUnit',event.target.value)} style={{width:190}}/>
      <Input placeholder="网站 / 域名" value={filters.domain} onChange={event => setFilter('domain',event.target.value)} style={{width:180}}/>
      <Button icon={<FilterOutlined/>} onClick={() => setFilterOpen(true)}>更多筛选</Button>
      <Button type="primary" icon={<BarChartOutlined/>} onClick={search}>查询</Button>
      <Button onClick={reset}>重置</Button>
    </Space><Row gutter={[16,12]} style={{marginTop:16}}>
      <Col xs={24} xl={12}><Text>分组维度</Text><Select mode="multiple" value={selectedDimensions}
        onChange={value => { if (value.length) { setPage(1); setSelectedDimensions(value); } }}
        options={shownDimensions.map(([value,label]) => ({value,label}))} style={{width:'100%'}}/></Col>
      <Col xs={24} xl={12}><Text>显示指标</Text><Select mode="multiple" value={selectedMetrics}
        onChange={value => value.length && setSelectedMetrics(value)}
        options={shownMetrics.map(([value,label]) => ({value,label}))} style={{width:'100%'}}/></Col>
    </Row></Card>
    <Card title="REST 数据明细" extra={<Space><Text type="secondary">共 {number(total)} 组</Text>
      <Button icon={<DownloadOutlined/>} loading={exporting} onClick={exportCsv}>导出 CSV</Button></Space>}>
      <Table size="small" rowKey={(row,index) => String(page) + '-' + index} loading={loading} dataSource={rows}
        columns={columns} scroll={{x:'max-content'}} onRow={row => ({
          onClick:() => openDetail(row), style:{cursor:'pointer'}
        })} pagination={{ current:page, pageSize, total, showSizeChanger:true, pageSizeOptions:[20,50,100,200],
          onChange:(next,size) => { setPage(next); setPageSize(size); } }}
        locale={{emptyText:'该条件下没有已同步的 REST 数据'}}/></Card>
    <Drawer title="更多筛选" open={filterOpen} onClose={() => setFilterOpen(false)} width={420}
      extra={<Button type="primary" onClick={search}>应用筛选</Button>}>
      <Space direction="vertical" style={{width:'100%'}} size={14}>
        <label>数据来源<Select value={filters.source} onChange={value => setFilter('source',value)}
          options={[{value:'rest',label:'Google REST 实际同步'},{value:'all',label:'全部来源'}]} style={{width:'100%'}}/></label>
        {admin && <label>广告主<Input value={filters.advertiser} onChange={event => setFilter('advertiser',event.target.value)}/></label>}
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
    <Modal title="报表下钻明细" open={Boolean(drill)} onCancel={() => setDrill(null)} footer={null} width="92vw">
      {drill && <><Space wrap style={{marginBottom:16}}>
        <Statistic title="当前分组收入" value={money(drill.row.revenue)}/>
        <Statistic title="展示" value={number(drill.row.impressions)}/>
        <Statistic title="点击" value={number(drill.row.clicks)}/>
        <Text type="secondary">按日期、小时、网站、国家及广告单元等维度查看同一分组</Text>
      </Space><Table size="small" rowKey={(row,index) => String(detailPage) + '-' + index} loading={detailLoading}
        dataSource={detailRows} columns={detailColumns} scroll={{x:'max-content'}}
        pagination={{current:detailPage,pageSize:50,total:detailTotal,onChange:setDetailPage}}/></>}
    </Modal>
  </Space>;
}
