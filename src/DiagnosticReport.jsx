import React, { useEffect, useState } from 'react';
import { Alert, Card, Select, Space, Table, Tag, Typography } from 'antd';
import NumericSortHeader from './NumericSortHeader.jsx';

const { Text } = Typography;
const kinds = [
  { value:'device', label:'设备' },
  { value:'browser', label:'浏览器' },
  { value:'demand', label:'需求渠道' }
];
const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const number = value => Number(value || 0).toLocaleString('zh-CN');

export default function DiagnosticReport({ range, accounts = [] }) {
  const [kind, setKind] = useState('device');
  const [accountId, setAccountId] = useState('');
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState(null), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      start:range[0].format('YYYY-MM-DD'), end:range[1].format('YYYY-MM-DD'), kind
    });
    if (accountId) query.set('accountId', accountId);
    const load = () => {
      setLoading(true); setError('');
      fetch('/api/admin/reports/diagnostics?' + query, { credentials:'include' })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
        return data;
      })
      .then(data => { if (active) { setItems(data.items || []); setStatus(data.status || []); } })
      .catch(cause => { if (active) setError(cause.message); })
        .finally(() => { if (active) setLoading(false); });
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [range[0].valueOf(), range[1].valueOf(), kind, accountId]);

  const numericColumn = (title, key, render) => ({ title:<NumericSortHeader label={title}
    direction={sort?.key === key ? sort.direction : ''}
    onSort={direction => { setSort({ key, direction }); setPage(1); }}/>,
    dataIndex:key, align:'right', render });
  const columns = [
    { title:kinds.find(item => item.value === kind)?.label || '分类', dataIndex:'category', width:210 },
    numericColumn('展示次数','impressions',number),
    numericColumn('收入','revenue',money),
    numericColumn('可衡量展示','measurableImpressions',number),
    numericColumn('可见展示','viewableImpressions',number),
    numericColumn('可见率','viewability',value => Number(value || 0).toFixed(2) + '%')
  ];
  const sortedItems = sort ? [...items].sort((a,b) => {
    const delta = (Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0);
    return (sort.direction === 'asc' ? delta : -delta) || String(a.category).localeCompare(String(b.category));
  }) : items;
  return <Card className="report-results-card" title="收益诊断" extra={<Space wrap>
    <Select aria-label="诊断维度" value={kind} options={kinds} style={{width:130}} onChange={value => { setKind(value); setPage(1); }}/>
    <Select aria-label="诊断账号" value={accountId} style={{width:230}}
      options={[{value:'',label:'全部账号'}, ...[...new Map(accounts.filter(item => item.gamAccountId).map(item => [String(item.gamAccountId), item])).values()].map(item => ({
        value:String(item.gamAccountId), label:item.name + '（' + item.accountKey + '）'
      }))]} onChange={value => { setAccountId(value); setPage(1); }}/>
  </Space>}>
    <Space direction="vertical" size={8} style={{width:'100%'}}>
      <Text type="secondary">按 GAM 账号时区后台同步；诊断收入仅作分类分析，不计入上方收益汇总。</Text>
      {status.length > 0 && <Space wrap>{status.map(row => <Tag key={row.accountId} color={row.lastError ? 'orange' : 'default'}>
        {row.accountName}：{row.lastSyncedAt ? '最近同步 ' + row.lastSyncedAt + ' UTC' : '待同步'}
      </Tag>)}</Space>}
      {status.some(row => row.lastError) && <Alert type="warning" showIcon message="部分账号诊断同步失败"
        description={status.filter(row => row.lastError).map(row => row.accountName + '：' + row.lastError).join('；')}/>}
      {error && <Alert type="error" showIcon message="收益诊断加载失败" description={error}/>}
      <Table size="small" rowKey="category" dataSource={sortedItems} columns={columns} loading={loading}
        scroll={{x:850}} pagination={{current:page,pageSize,showSizeChanger:true,onChange:(next,size) => { setPage(size === pageSize ? next : 1); setPageSize(size); }}} locale={{emptyText:'所选区间尚无已同步的诊断数据'}}/>
    </Space>
  </Card>;
}
