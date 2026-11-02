import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp, Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form,
  Input, InputNumber, Layout, Menu, Modal, Popconfirm, Row, Select, Space, Statistic, Table,
  Tag, Typography, message
} from 'antd';
import {
  ApiOutlined, BarChartOutlined, CopyOutlined, DashboardOutlined, DollarOutlined, KeyOutlined,
  LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UploadOutlined, UserSwitchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const RevenueChart = React.lazy(() => import('./RevenueChart.jsx'));
const hostname = window.location.hostname.toLowerCase();
const portal = hostname === 'adxpub.geekforest.ai' || new URLSearchParams(window.location.search).get('portal') === 'publisher' ? 'publisher' : 'admin';

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `http_${response.status}`);
  return payload;
}

const money = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString('zh-CN');

class PageErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('page_render_failed', error); }
  render() {
    if (this.state.error) return <Card title="页面加载失败" extra={<Button onClick={() => window.location.reload()}>刷新页面</Button>}><Alert type="error" showIcon message="页面组件发生异常" description="请刷新后重试；如果仍然失败，请把此页面截图和浏览器控制台错误发给技术人员。" /></Card>;
    return this.props.children;
  }
}

function Login({ onLogin }) {
  const [busy, setBusy] = useState(false);
  const submit = async values => {
    setBusy(true);
    try { onLogin((await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) })).user); }
    catch (error) { message.error(error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败'); }
    finally { setBusy(false); }
  };
  const publisher=portal==='publisher';
  return <div className={`login-page ${publisher?'publisher-login':''}`}><div className="login-brand"><div className="brand-mark">AX</div><div><b>{publisher?'AdX Publisher':'AdX Control'}</b><span>{publisher?'渠道收益与流量数据工作台':'平台数据与渠道管理后台'}</span></div></div><Card className="login-card"><Title level={3}>{publisher?'渠道登录':'管理员登录'}</Title><Text type="secondary">{publisher?'使用平台分配的渠道账号登录，仅可查看本渠道分成后数据。':'仅限平台管理员访问，渠道账号请前往渠道后台。'}</Text><Form layout="vertical" onFinish={submit} requiredMark={false}><Form.Item name="email" label="登录邮箱" rules={[{ required: true }, { type: 'email' }]}><Input size="large" /></Form.Item><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password size="large" /></Form.Item><Button block size="large" type="primary" htmlType="submit" loading={busy}>登录</Button></Form></Card></div>;
}

function MetricCards({ summary = {}, admin }) {
  const items = [
    [admin?'总流水（收入）':'渠道结算收入', money(summary.revenue), <DollarOutlined />],
    ...(admin?[['渠道结算收益', money(summary.channelRevenue), <TeamOutlined />]]:[]),
    ['展示量', number(summary.impressions), <BarChartOutlined />],
    ['匹配率', `${Number(summary.matchRate || 0).toFixed(2)}%`, <SafetyOutlined />]
  ];
  return <Row gutter={[16, 16]}>{items.map(([title, value, icon]) => <Col xs={24} sm={12} xl={6} key={title}><Card className="metric"><Statistic title={title} value={value} prefix={icon} /></Card></Col>)}</Row>;
}

function Dashboard({ range, setRange, admin }) {
  const [data, setData] = useState({ summary: {}, trend: [], topUrls: [], lastSync: null });
  const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); try { setData(await api(`/api/dashboard?start=${range[0].format('YYYY-MM-DD')}&end=${range[1].format('YYYY-MM-DD')}`)); } catch (e) { message.error(e.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [range[0].valueOf(), range[1].valueOf()]);
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>经营总览</Title><Text type="secondary">收入、流量质量与渠道结算一屏掌握</Text></div><Space><DatePicker.RangePicker value={range} onChange={v => v && setRange(v)} /><Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button></Space></div>
    <MetricCards summary={data.summary} admin={admin} />
    <Row gutter={[16, 16]}><Col xs={24} xl={16}><Card title="每日收益趋势" extra={data.lastSync ? `最近同步 ${data.lastSync}` : '尚未同步'}><div className="chart"><PageErrorBoundary><React.Suspense fallback={<div style={{padding:24,color:"#587184"}}>图表加载中…</div>}><RevenueChart data={data.trend} formatMoney={money}/></React.Suspense></PageErrorBoundary></div></Card></Col><Col xs={24} xl={8}><Card title="收益最高的链接"><Table size="small" pagination={false} rowKey="url" dataSource={data.topUrls} columns={[{ title: '链接', dataIndex: 'url', ellipsis: true }, { title: '收益', dataIndex: 'revenue', align: 'right', render: money }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}/></Card></Col></Row>
  </Space>;
}

function Reports({ range, setRange, admin }) {
  const [rows, setRows] = useState([]); const [loading, setLoading] = useState(false); const [dimension, setDimension] = useState(['account','adUnit','url','date','hour','country']); const [filters,setFilters]=useState({upstreamAccount:'',channelId:'',adUnit:'',domain:''}); const [options,setOptions]=useState({accounts:[],channels:[]});
  useEffect(()=>{if(!admin)return;Promise.all([api('/api/admin/upstream-accounts'),api('/api/admin/channels')]).then(([a,c])=>setOptions({accounts:a.items||[],channels:c.items||[]})).catch(e=>message.error(`筛选项加载失败：${e.message}`))},[admin]);
  const load = async () => { setLoading(true); try { const q = new URLSearchParams({start:range[0].format('YYYY-MM-DD'),end:range[1].format('YYYY-MM-DD'),dimensions:dimension.join(','),...Object.fromEntries(Object.entries(filters).filter(([,v])=>String(v).trim()))}); setRows((await api(`/api/reports?${q}`)).items); } catch(e){message.error(e.message)} finally{setLoading(false)} };
  useEffect(()=>{load()},[range[0].valueOf(),range[1].valueOf(),dimension.join(',')]);
  const dimensions=[['date','日期'],['url','链接'],['account','账号'],['adUnit','广告单元'],['hour','小时'],['country','国家']];
  const columnWidths={account:220,adUnit:300,url:280,date:120,hour:80,country:110}; const cols=[...dimension.map(d=>({title:dimensions.find(x=>x[0]===d)?.[1],dataIndex:d,width:columnWidths[d],fixed:d==='date'?'left':undefined})),...(dimension.includes('url')?[{title:'主域名',dataIndex:'mainDomain',width:180},{title:'域名类型',dataIndex:'domainType',width:100}]:[]),{title:'请求',dataIndex:'requests',width:100,align:'right',render:number},{title:'匹配',dataIndex:'matchedRequests',width:100,align:'right',render:number},{title:'展示',dataIndex:'impressions',width:100,align:'right',render:number},{title:'点击',dataIndex:'clicks',width:100,align:'right',render:number},{title:'匹配率',dataIndex:'matchRate',width:110,align:'right',render:v=>`${Number(v).toFixed(2)}%`},{title:admin?'总流水（收入）':'结算收入',dataIndex:'revenue',width:140,align:'right',render:money},{title:'CPM',dataIndex:'ecpm',width:110,align:'right',render:money},...(admin?[{title:'上游分成后',dataIndex:'upstreamRevenue',width:130,align:'right',render:money},{title:'上游比例',dataIndex:'upstreamSharePercent',width:110,align:'right',render:v=>`${v}%`},{title:'下游比例',dataIndex:'channelSharePercent',width:110,align:'right',render:v=>`${v}%`},{title:'渠道结算',dataIndex:'channelRevenue',width:120,align:'right',render:money},{title:'毛利',dataIndex:'grossProfit',width:120,align:'right',render:money}]:[])];
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>数据报告</Title><Text type="secondary">支持按小时、上游账户、渠道、广告单元和域名查询，结算金额按规则自动计算</Text></div></div><Card><Space wrap><DatePicker.RangePicker value={range} onChange={v=>v&&setRange(v)}/>{admin&&<Select allowClear showSearch placeholder="上游账户" value={filters.upstreamAccount||undefined} onChange={v=>setFilters({...filters,upstreamAccount:v||''})} options={options.accounts.map(x=>({value:x.accountKey,label:`${x.name}（${x.accountKey}）`}))} style={{width:220}}/>}{admin&&<Select allowClear showSearch placeholder="渠道" value={filters.channelId||undefined} onChange={v=>setFilters({...filters,channelId:v||''})} options={options.channels.map(x=>({value:String(x.id),label:x.name}))} style={{width:160}}/>}<Input placeholder="广告单元" value={filters.adUnit} onChange={e=>setFilters({...filters,adUnit:e.target.value})} style={{width:220}}/><Input placeholder="域名" value={filters.domain} onChange={e=>setFilters({...filters,domain:e.target.value})} style={{width:180}}/><Select mode="multiple" value={dimension} onChange={v=>v.length&&setDimension(v)} options={dimensions.map(([value,label])=>({value,label}))} style={{minWidth:360}}/><Button type="primary" icon={<BarChartOutlined/>} onClick={load}>搜索</Button><Button onClick={()=>{setFilters({upstreamAccount:'',channelId:'',adUnit:'',domain:''});setDimension(['account','adUnit','url','date','hour','country'])}}>重置</Button></Space></Card><Card title="小时明细"><Table rowKey={(r,i)=>JSON.stringify(r)+i} loading={loading} dataSource={rows} columns={cols} scroll={{x:1500}} pagination={{pageSize:20,showSizeChanger:true}}/></Card></Space>;
}

function SettlementConfig() {
  const [accounts,setAccounts]=useState([]),[units,setUnits]=useState([]),[rules,setRules]=useState([]),[channels,setChannels]=useState([]);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const [accountForm]=Form.useForm(),[unitForm]=Form.useForm(),[ruleForm]=Form.useForm();
  const load=async()=>{setLoading(true);setLoadError('');const results=await Promise.allSettled([api('/api/admin/upstream-accounts'),api('/api/admin/ad-unit-domains'),api('/api/admin/share-rules'),api('/api/admin/channels')]);const [a,u,r,c]=results; if(a.status==='fulfilled')setAccounts(a.value.items||[]); if(u.status==='fulfilled')setUnits(u.value.items||[]); if(r.status==='fulfilled')setRules(r.value.items||[]); if(c.status==='fulfilled')setChannels(c.value.items||[]); const failed=results.filter(x=>x.status==='rejected'); if(failed.length){const detail=failed.map(x=>x.reason?.message||'请求失败').join('、');setLoadError(`部分配置加载失败：${detail}`);message.error(detail)} setLoading(false)};
  useEffect(()=>{load()},[]);
  const submit=async(path,values,form)=>{try{const payload={...values,effectiveFrom:values.effectiveFrom?.format('YYYY-MM-DD')};await api(path,{method:'POST',body:JSON.stringify(payload)});message.success('已保存并读回');form.resetFields();load()}catch(e){message.error(e.message)}};
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>结算配置</Title><Text type="secondary">上游账户、广告单元域名和渠道下游比例分开配置，最具体规则优先</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>{loadError&&<Alert type="warning" showIcon message={loadError} action={<Button size="small" onClick={load}>重试</Button>}/>}<Row gutter={[16,16]}><Col xs={24} xl={8}><Card loading={loading} title="上游账户分成"><Form form={accountForm} layout="vertical" onFinish={v=>submit('/api/admin/upstream-accounts',v,accountForm)}><Form.Item name="accountKey" label="上游账户标识" rules={[{required:true}]}><Input placeholder="Ad Manager account"/></Form.Item><Form.Item name="name" label="账户名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="sharePercent" label="上游分成比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} style={{width:'100%'}}/></Form.Item><Button type="primary" htmlType="submit">保存上游账户</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={accounts} columns={[{title:'账户',dataIndex:'accountKey'},{title:'比例',dataIndex:'sharePercent',render:v=>`${v}%`}]} /></Card></Col><Col xs={24} xl={8}><Card loading={loading} title="广告单元绑定域名"><Form form={unitForm} layout="vertical" onFinish={v=>submit('/api/admin/ad-unit-domains',v,unitForm)}><Form.Item name="adUnit" label="广告单元" rules={[{required:true}]}><Input placeholder="Ad unit name or ID"/></Form.Item><Form.Item name="domain" label="域名" rules={[{required:true}]}><Input placeholder="https://example.com"/></Form.Item><Button type="primary" htmlType="submit">保存域名绑定</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={units} columns={[{title:'广告单元',dataIndex:'adUnit'},{title:'域名',dataIndex:'domain'}]} /></Card></Col><Col xs={24} xl={8}><Card loading={loading} title="渠道下游比例"><Form form={ruleForm} layout="vertical" onFinish={v=>submit('/api/admin/share-rules',v,ruleForm)}><Form.Item name="channelId" label="渠道" rules={[{required:true}]}><Select options={channels.map(c=>({value:c.id,label:c.name}))}/></Form.Item><Form.Item name="scopeType" label="规则维度" initialValue="ad_unit"><Select options={[{value:'ad_unit',label:'广告单元'},{value:'account',label:'上游账户'}]}/></Form.Item><Form.Item name="scopeValue" label="匹配值" rules={[{required:true}]}><Input placeholder="广告单元或账户标识"/></Form.Item><Form.Item name="sharePercent" label="下游结算比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} style={{width:'100%'}}/></Form.Item><Form.Item name="effectiveFrom" label="生效日期" rules={[{required:true}]} initialValue={dayjs()}><DatePicker format="YYYY-MM-DD" style={{width:'100%'}}/></Form.Item><Button type="primary" htmlType="submit">保存下游规则</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={rules} columns={[{title:'维度',dataIndex:'scopeType'},{title:'匹配值',dataIndex:'scopeValue'},{title:'比例',dataIndex:'sharePercent',render:v=>`${v}%`}]} /></Card></Col></Row></Space>;
}

function AdUnitBuilder() {
  const [file,setFile] = useState(null), [payload,setPayload] = useState(null), [preview,setPreview] = useState(null), [items,setItems] = useState([]), [accounts,setAccounts] = useState([]);
  const [busy,setBusy] = useState(''), [subdomains,setSubdomains] = useState([]), [types,setTypes] = useState([]), [sizes,setSizes] = useState([]);
  const [gamAccountId,setGamAccountId] = useState(null), [parentAdUnit,setParentAdUnit] = useState(''), [parents,setParents] = useState([]);
  const load = async () => { const [u,a] = await Promise.all([api('/api/admin/ad-units'),api('/api/admin/gam-accounts')]); setItems(u.items); setAccounts(a.items); };
  useEffect(() => { load().catch(e=>message.error(e.message)); }, []);
  const choose = async e => { const picked=e.target.files?.[0]; if(!picked)return; try { setPayload(JSON.parse(await picked.text())); setFile(picked); setPreview(null); } catch { message.error('JSON 文件无法解析'); } };
  const runPreview = async () => {
    if(!payload)return message.warning('请先上传 JSON'); setBusy('preview');
    try { setPreview(await api('/api/admin/ad-units/preview',{method:'POST',body:JSON.stringify({payload,rules:{subdomains,inventoryTypes:types,sizes}})})); }
    catch(e) { message.error(e.message); } finally { setBusy(''); }
  };
  const create = async () => {
    if(!preview?.items?.length)return; setBusy('create');
    try { const result=await api('/api/admin/ad-units/create',{method:'POST',body:JSON.stringify({items:preview.items})}); message.success('已保存 '+result.created+' 个创建任务'); setPreview(null); await load(); }
    catch(e) { message.error(e.message); } finally { setBusy(''); }
  };
  const loadParents = async () => {
    if(!gamAccountId)return message.warning('先选择 REST 账户'); setBusy('parents');
    try { const result=await api('/api/admin/gam-accounts/'+gamAccountId+'/ad-units'); setParents(result.items); message.success('已加载 '+result.items.length+' 个广告单元'); }
    catch(e) { message.error(e.message); } finally { setBusy(''); }
  };
  const publish = async item => {
    if(!gamAccountId || !parentAdUnit.trim())return message.warning('请选择 REST 账户并填写父广告单元资源名');
    setBusy('publish:'+item.id);
    try { const result=await api('/api/admin/ad-units/'+item.id+'/publish',{method:'POST',body:JSON.stringify({gamAccountId,parentAdUnit:parentAdUnit.trim()})}); message.success('已通过 REST 创建：'+result.name); await load(); }
    catch(e) { message.error(e.message); await load(); } finally { setBusy(''); }
  };
  const download = () => {
    const rows=(preview?.items||items).map(x=>[x.code,x.name,x.size,x.description,x.adsenseEnabled?'是':'否',x.placement,x.targetWindow,x.label,x.status||'planned',x.providerId||'']);
    const csv='\ufeff'+[['代码','名称','大小','说明','AdSense','刊登位置','目标窗口','标签','状态','REST 资源名'],...rows].map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a'); a.href=url; a.download='ad-units.csv'; a.click(); URL.revokeObjectURL(url);
  };
  const options=(values,setter)=><Select mode="tags" allowClear value={values} onChange={setter} style={{width:'100%'}} tokenSeparators={[',','，']} placeholder="可输入多个值"/>;
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>广告单元创建</Title><Text type="secondary">先生成任务，再通过 Google Ad Manager REST v1 发布</Text></div></div>
    <Alert type="info" showIcon message="发布要求" description="尺寸支持宽×高或 fluid；发布前选择可用 REST 账户和父广告单元。系统先检查远端同编码广告单元，再执行创建并记录 REST 资源名。"/>
    <Card title="生成规则"><Row gutter={[16,16]}><Col xs={24} md={8}><Text strong>子域名</Text>{options(subdomains,setSubdomains)}</Col><Col xs={24} md={8}><Text strong>广告位类型</Text>{options(types,setTypes)}</Col><Col xs={24} md={8}><Text strong>尺寸</Text>{options(sizes,setSizes)}</Col></Row>
      <Space wrap style={{marginTop:16}}><label className="file-button"><UploadOutlined/> {file?.name||'上传广告单元表 JSON'}<input type="file" accept="application/json,.json" onChange={choose}/></label><Button type="primary" loading={busy==='preview'} disabled={!payload} onClick={runPreview}>预览广告单元</Button></Space>
    </Card>
    {preview&&<Card title={'预览结果：'+preview.total+' 个'} extra={<Space><Button onClick={download}>下载</Button><Button type="primary" loading={busy==='create'} onClick={create}>保存创建任务</Button></Space>}>
      <Alert type={preview.duplicates?.length?'warning':'success'} showIcon message={preview.duplicates?.length?'发现 '+preview.duplicates.length+' 个重复项，将跳过':'未发现重复项'}/>
      <Table rowKey="code" dataSource={preview.items} pagination={{pageSize:20}} scroll={{x:1100}} columns={[
        {title:'名称',dataIndex:'name'},{title:'编码',dataIndex:'code'},{title:'尺寸',dataIndex:'size'},{title:'说明',dataIndex:'description'},
        {title:'AdSense',dataIndex:'adsenseEnabled',render:v=>v?'是':'否'},{title:'刊登位置',dataIndex:'placement'},{title:'目标窗口',dataIndex:'targetWindow'}
      ]}/>
    </Card>}
    <Card title="REST 发布设置"><Space wrap>
      <Select style={{minWidth:230}} placeholder="选择 REST 账户" value={gamAccountId} onChange={v=>{setGamAccountId(v);setParents([]);setParentAdUnit('')}} options={accounts.filter(x=>x.status==='active').map(x=>({value:x.id,label:x.name+'（'+x.networkCode+'）'}))}/>
      <Button onClick={loadParents} loading={busy==='parents'} disabled={!gamAccountId}>加载父广告单元</Button>
      <Select showSearch allowClear style={{minWidth:380}} placeholder="选择已加载的父广告单元" value={parentAdUnit||undefined} onChange={v=>setParentAdUnit(v||'')} options={parents.map(x=>({value:x.name,label:x.displayName+'（'+x.name+'）'}))}/>
      <Input style={{width:380}} placeholder="也可输入 networks/编号/adUnits/编号" value={parentAdUnit} onChange={e=>setParentAdUnit(e.target.value)}/>
    </Space></Card>
    <Card title="创建任务" extra={<Button onClick={download} disabled={!items.length}>导出 CSV</Button>}><Table rowKey="id" dataSource={items} scroll={{x:1300}} columns={[
      {title:'编码',dataIndex:'code'},{title:'名称',dataIndex:'name'},{title:'尺寸',dataIndex:'size'},
      {title:'状态',dataIndex:'status',render:v=><Tag color={v==='created'?'green':v==='failed'?'red':'orange'}>{v==='created'?'已创建':v==='failed'?'失败':'待发布'}</Tag>},
      {title:'REST 资源名',dataIndex:'providerId',ellipsis:true},{title:'错误',dataIndex:'publishError',ellipsis:true},
      {title:'操作',render:(_,r)=>r.status==='created'?null:<Popconfirm title={'确认将 '+r.code+' 发布到所选 REST 账户？'} onConfirm={()=>publish(r)}><Button size="small" type="primary" loading={busy==='publish:'+r.id}>发布</Button></Popconfirm>}
    ]}/></Card>
  </Space>;
}

function Channels() {
  const [items,setItems]=useState([]); const [open,setOpen]=useState(false); const [editing,setEditing]=useState(null); const [form]=Form.useForm();
  const load=()=>api('/api/admin/channels').then(r=>setItems(r.items)).catch(e=>message.error(e.message)); useEffect(load,[]);
  const save=async values=>{try{const payload={...values,effectiveFrom:values.effectiveFrom?.format('YYYY-MM-DD')};await api(editing?`/api/admin/channels/${editing.id}`:'/api/admin/channels',{method:editing?'PUT':'POST',body:JSON.stringify(payload)});message.success('已保存并读回');setOpen(false);load()}catch(e){message.error(e.message)}};
  const show=item=>{setEditing(item||null);form.setFieldsValue(item?{...item,effectiveFrom:dayjs() }:{sharePercent:80,status:'active',effectiveFrom:dayjs()});setOpen(true)};
  const resetPassword=r=>Modal.confirm({title:`重置 ${r.name} 的登录密码`,content:<Input.Password id="channel-new-password" placeholder="至少10位"/>,onOk:async()=>{const password=document.getElementById('channel-new-password')?.value||'';await api(`/api/admin/channels/${r.id}/password`,{method:'POST',body:JSON.stringify({password})});message.success('密码已更新，旧会话已退出')}});
  const rotateSecret=async r=>{const {secret}=await api(`/api/admin/channels/${r.id}/api-secret`,{method:'POST'});Modal.info({title:'新的渠道 API 密钥',width:620,content:<><Alert type="warning" showIcon message="密钥只显示这一次，请立即交付给渠道并妥善保存"/><Input.TextArea value={secret} readOnly autoSize style={{marginTop:16}}/></>});load()};
  const columns=[{title:'渠道',dataIndex:'name'},{title:'登录邮箱',dataIndex:'email'},{title:'分成比例',dataIndex:'sharePercent',render:v=>`${v}%`},{title:'API',dataIndex:'apiConfigured',render:v=><Tag color={v?'green':'orange'}>{v?'已配置':'未生成'}</Tag>},{title:'状态',dataIndex:'status',render:v=><Tag color={v==='active'?'green':'default'}>{v==='active'?'启用':'停用'}</Tag>},{title:'操作',render:(_,r)=><Space><Button type="link" onClick={()=>show(r)}>编辑</Button><Button type="link" icon={<KeyOutlined/>} onClick={()=>resetPassword(r)}>密码</Button><Button type="link" onClick={()=>rotateSecret(r)}>API密钥</Button></Space>}];
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>渠道管理</Title><Text type="secondary">渠道登录密码、分成比例和 API 密钥统一管理</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={()=>show(null)}>新建渠道</Button></div><Card><Table rowKey="id" dataSource={items} columns={columns} scroll={{x:900}}/></Card><Drawer title={editing?'编辑渠道':'新建渠道'} open={open} onClose={()=>setOpen(false)} width={520} destroyOnClose><Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="渠道名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="email" label="登录邮箱" rules={[{required:true,type:'email'}]}><Input disabled={Boolean(editing)}/></Form.Item>{!editing&&<Form.Item name="password" label="初始密码" rules={[{required:true,min:10}]}><Input.Password/></Form.Item>}<Form.Item name="sharePercent" label="渠道分成比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} precision={2} style={{width:'100%'}}/></Form.Item><Form.Item name="effectiveFrom" label="分成生效日期" rules={[{required:true,message:'请选择生效日期'}]} extra="历史数据按该日期起使用新比例；修改同一日期会更新该日期的规则"><DatePicker format="YYYY-MM-DD" style={{width:'100%'}}/></Form.Item><Form.Item name="status" label="状态"><Select options={[{value:'active',label:'启用'},{value:'disabled',label:'停用'}]}/></Form.Item><Button type="primary" htmlType="submit">保存并读回</Button></Form></Drawer></Space>;
}

function DataImport() {
  const [channels,setChannels]=useState([]),[runs,setRuns]=useState([]),[channelId,setChannelId]=useState(),[file,setFile]=useState(null),[payload,setPayload]=useState(null),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false);
  const load=()=>Promise.all([api('/api/admin/channels'),api('/api/admin/imports')]).then(([c,r])=>{setChannels(c.items);setRuns(r.items)});useEffect(()=>{load().catch(e=>message.error(e.message))},[]);
  const choose=async e=>{const picked=e.target.files?.[0];if(!picked)return;try{setPayload(JSON.parse(await picked.text()));setFile(picked);setPreview(null)}catch{message.error('JSON 文件无法解析')}};
  const preflight=async()=>{if(!channelId||!payload)return message.warning('请选择渠道并上传 JSON');setBusy(true);try{setPreview(await api('/api/admin/imports/preview',{method:'POST',body:JSON.stringify({channelId,fileName:file.name,payload})}))}catch(e){message.error(e.message)}finally{setBusy(false)}};
  const commit=async()=>{setBusy(true);try{const r=await api('/api/admin/imports',{method:'POST',body:JSON.stringify({channelId,fileName:file.name,payload})});message.success(`导入完成：成功 ${r.accepted} 条，拒绝 ${r.rejected} 条`);setPreview(null);setPayload(null);setFile(null);load()}catch(e){message.error(e.message)}finally{setBusy(false)}};
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>JSON 数据导入</Title><Text type="secondary">按 Google Ad Manager API 字段口径预检，重复数据按维度键更新</Text></div></div><Alert type="info" showIcon message="Google Ad Manager 字段说明" description={<span>API 专用维度与指标需要在互动式报告中开启“访问 API 字段”后才能显示；部分维度与指标不可组合。系统会标准化核心字段，并完整保留其他原始字段。</span>}/><Card title="上传数据"><Space wrap><Select placeholder="选择所属渠道" value={channelId} onChange={setChannelId} style={{width:260}} options={channels.map(c=>({value:c.id,label:c.name}))}/><label className="file-button"><UploadOutlined/> {file?.name||'选择 JSON 文件'}<input type="file" accept="application/json,.json" onChange={choose}/></label><Button type="primary" loading={busy} disabled={!payload||!channelId} onClick={preflight}>预检字段</Button></Space>{preview&&<div className="import-preview"><Alert type={preview.rejected?'warning':'success'} showIcon message={`共 ${preview.totalRows} 条；通过 ${preview.accepted} 条，拒绝 ${preview.rejected} 条`} description={<Space direction="vertical" size={4}><span>字段映射：{preview.fieldMappings.map(v=>`${v.source} → ${v.field}`).join('、')||'未识别'}</span>{preview.missingRequiredFields.length>0&&<Text type="danger">缺少核心字段：{preview.missingRequiredFields.join('、')}</Text>}{preview.preservedFields.length>0&&<span>仅保留原值：{preview.preservedFields.join('、')}</span>}</Space>}/><Button type="primary" danger={preview.rejected>0} disabled={!preview.accepted} loading={busy} onClick={commit}>确认导入</Button></div>}</Card><Card title="导入记录"><Table rowKey="id" dataSource={runs} columns={[{title:'时间',dataIndex:'createdAt'},{title:'渠道',dataIndex:'channelName'},{title:'文件',dataIndex:'sourceFile',ellipsis:true},{title:'总数',dataIndex:'totalRows'},{title:'成功',dataIndex:'acceptedRows'},{title:'拒绝',dataIndex:'rejectedRows'},{title:'状态',dataIndex:'status'}]}/></Card></Space>;
}

function GamAccounts() {
  const [items,setItems] = useState([]), [channels,setChannels] = useState([]), [upstream,setUpstream] = useState([]), [runs,setRuns] = useState([]);
  const [busy,setBusy] = useState(''), [open,setOpen] = useState(false), [reportAccount,setReportAccount] = useState(null);
  const [file,setFile] = useState(null), [credentials,setCredentials] = useState(null), [preview,setPreview] = useState(null);
  const [dates,setDates] = useState([dayjs().subtract(1,'day'),dayjs()]);
  const [form] = Form.useForm(), [reportForm] = Form.useForm();
  const load = async () => {
    const [a,c,u,r] = await Promise.all([api('/api/admin/gam-accounts'),api('/api/admin/channels'),api('/api/admin/upstream-accounts'),api('/api/admin/gam-sync/runs')]);
    setItems(a.items); setChannels(c.items); setUpstream(u.items); setRuns(r.items);
  };
  useEffect(() => { load().catch(e => message.error(e.message)); }, []);
  const choose = async e => {
    const picked = e.target.files?.[0]; if (!picked) return;
    try { const json = JSON.parse(await picked.text()); if (!json.client_email || !json.private_key) throw new Error('invalid'); setCredentials(json); setFile(picked); }
    catch { setCredentials(null); setFile(null); message.error('服务账号 JSON 缺少 client_email 或 private_key'); }
  };
  const save = async values => {
    if (!credentials) return message.warning('请上传服务账号 JSON');
    setBusy('save');
    try { await api('/api/admin/gam-accounts', {method:'POST',body:JSON.stringify({...values,credentials})}); message.success('REST 账户已保存，请测试连接'); form.resetFields(); setCredentials(null); setFile(null); setOpen(false); await load(); }
    catch(e) { message.error(e.message); } finally { setBusy(''); }
  };
  const invoke = async (id, action, body, label) => {
    setBusy(id + ':' + action);
    try {
      const response = await api('/api/admin/gam-accounts/' + id + '/' + action, {method:'POST',body:JSON.stringify(body || {})});
      if (action === 'preview') setPreview({account:items.find(x => x.id === id), ...response.preview});
      message.success(label); await load(); return true;
    } catch(e) { message.error(e.message); return false; } finally { setBusy(''); }
  };
  const openReport = item => { setReportAccount(item); reportForm.setFieldsValue({channelId:item.channelId || undefined,upstreamAccountId:item.upstreamAccountId || undefined,moneyDivisor:item.moneyDivisor || 1}); };
  const configure = async values => { if (await invoke(reportAccount.id,'report',values,'REST 报表已配置，请先预览并核对金额')) { setReportAccount(null); setPreview(null); } };
  const previewReport = item => invoke(item.id,'preview',{start:dates?.[0]?.format('YYYY-MM-DD'),end:dates?.[1]?.format('YYYY-MM-DD')},'报表预览完成');
  const syncNow = item => invoke(item.id,'sync-now',{start:dates?.[0]?.format('YYYY-MM-DD'),end:dates?.[1]?.format('YYYY-MM-DD')},'REST 数据已写入本地报表');
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>Google Ad Manager REST 账户</Title><Text type="secondary">REST v1 连接、报表预览与同步；服务账号凭证加密保存</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={() => {form.resetFields();setCredentials(null);setFile(null);setOpen(true);}}>新增账户</Button></div>
    <Alert type="warning" showIcon message="先核对新旧报表的财务口径" description="REST 的 AD_EXCHANGE_REVENUE 与旧报表的行项目级收入不可直接视为相同。请先选择渠道、上游账户和金额单位，预览核对后再启用自动入库。"/>
    <Card title="日期范围（预览或手动同步）"><DatePicker.RangePicker value={dates} onChange={setDates}/></Card>
    <Card title="REST 账户与报表"><Table rowKey="id" dataSource={items} scroll={{x:1150}} columns={[
      {title:'账户',dataIndex:'name'}, {title:'Network Code',dataIndex:'networkCode'},
      {title:'连接',dataIndex:'status',render:v=><Tag color={v==='active'?'green':v==='error'?'red':'orange'}>{v==='active'?'可用':v==='error'?'失败':'未测试'}</Tag>},
      {title:'报表',dataIndex:'reportName',ellipsis:true,render:v=>v||'未配置'},
      {title:'自动入库',dataIndex:'syncEnabled',render:v=><Tag color={v?'green':'default'}>{v?'已启用':'已暂停'}</Tag>},
      {title:'最近预览',dataIndex:'lastPreviewAt',render:(v,r)=>v? v+' / '+r.lastPreviewRows+' 行':'未预览'},
      {title:'操作',width:420,render:(_,r)=><Space wrap>
        <Button size="small" loading={busy===r.id+':test'} onClick={()=>invoke(r.id,'test',{},'连接成功')}>测试</Button>
        <Button size="small" disabled={r.status!=='active'} onClick={()=>openReport(r)}>配置报表</Button>
        <Button size="small" disabled={!r.reportName} loading={busy===r.id+':preview'} onClick={()=>previewReport(r)}>预览</Button>
        {r.syncEnabled?<Button size="small" onClick={()=>invoke(r.id,'pause',{},'自动入库已暂停')}>暂停</Button>:
          <Popconfirm title="已核对金额单位及新旧报表口径？" onConfirm={()=>invoke(r.id,'activate',{},'自动入库已启用')}><Button size="small" type="primary" disabled={!r.lastPreviewRows}>启用</Button></Popconfirm>}
        <Popconfirm title="确认将所选日期范围写入本地报表？" onConfirm={()=>syncNow(r)}><Button size="small" disabled={!r.syncEnabled} loading={busy===r.id+':sync-now'}>立即同步</Button></Popconfirm>
      </Space>}
    ]}/></Card>
    {preview&&<Card title={'预览：'+preview.account?.name+' / '+preview.start+' 至 '+preview.end}><Descriptions items={[
      {key:'rows',label:'行数',children:preview.rows},{key:'revenue',label:'收入（USD）',children:Number(preview.revenue).toFixed(2)},
      {key:'divisor',label:'金额除数',children:preview.moneyDivisor}
    ]}/><Table size="small" rowKey={(_,i)=>i} dataSource={preview.sample||[]} scroll={{x:1000}} columns={[
      {title:'日期',dataIndex:'reportDate'},{title:'小时',dataIndex:'hour'},{title:'域名',dataIndex:'domain'},{title:'广告单元',dataIndex:'adUnit'},
      {title:'国家',dataIndex:'country'},{title:'请求',dataIndex:'requests'},{title:'展示',dataIndex:'impressions'},{title:'收入',dataIndex:'revenue'}
    ]}/></Card>}
    <Card title="同步记录"><Table size="small" rowKey="id" dataSource={runs} columns={[
      {title:'账户',dataIndex:'gamAccountName'},{title:'开始',dataIndex:'windowStart'},{title:'结束',dataIndex:'windowEnd'},
      {title:'状态',dataIndex:'status'},{title:'读取',dataIndex:'rowsRead'},{title:'写入',dataIndex:'rowsWritten'},{title:'错误',dataIndex:'error',ellipsis:true}
    ]}/></Card>
    <Drawer title="新增 REST 账户" open={open} onClose={()=>setOpen(false)} width={560} destroyOnClose><Form form={form} layout="vertical" onFinish={save}>
      <Form.Item name="name" label="账户名称" rules={[{required:true}]}><Input/></Form.Item>
      <Form.Item name="networkCode" label="Network Code" rules={[{required:true}]}><Input/></Form.Item>
      <Form.Item label="服务账号 JSON" required><label className="file-button"><UploadOutlined/> {file?.name||'上传服务账号 JSON'}<input type="file" accept="application/json,.json" onChange={choose}/></label></Form.Item>
      <Button type="primary" htmlType="submit" loading={busy==='save'} disabled={!credentials}>保存账户</Button>
    </Form></Drawer>
    <Drawer title="配置 REST 报表" open={Boolean(reportAccount)} onClose={()=>setReportAccount(null)} width={560} destroyOnClose>
      <Form form={reportForm} layout="vertical" onFinish={configure}>
        <Form.Item name="channelId" label="收入所属渠道" rules={[{required:true}]}><Select options={channels.filter(x=>x.status==='active').map(x=>({value:x.id,label:x.name}))}/></Form.Item>
        <Form.Item name="upstreamAccountId" label="上游结算账户" rules={[{required:true}]}><Select options={upstream.filter(x=>x.gamAccountId===reportAccount?.id && x.status==='active').map(x=>({value:x.id,label:x.name}))}/></Form.Item>
        <Form.Item name="moneyDivisor" label="REST 金额单位" rules={[{required:true}]}><Select options={[{value:1,label:'API 值为 USD'},{value:1000000,label:'API 值为 micros（除以 1,000,000）'}]}/></Form.Item>
        <Alert type="info" showIcon message="保存配置会暂停自动入库，直到重新预览并启用" style={{marginBottom:16}}/>
        <Button type="primary" htmlType="submit" loading={busy===reportAccount?.id+':report'}>保存报表配置</Button>
      </Form>
    </Drawer>
  </Space>;
}

function AdminUsers(){
  const[items,setItems]=useState([]),[open,setOpen]=useState(false),[loading,setLoading]=useState(true);const[form]=Form.useForm();const load=async()=>{setLoading(true);try{setItems((await api('/api/admin/users')).items)}catch(e){message.error(`管理员账户加载失败：${e.message}`)}finally{setLoading(false)}};useEffect(()=>{load()},[]);
  const save=async v=>{await api('/api/admin/users',{method:'POST',body:JSON.stringify(v)});message.success('管理员已创建');setOpen(false);load()};
  const reset=r=>Modal.confirm({title:`重置 ${r.name} 的密码`,content:<Input.Password id="admin-new-password" placeholder="至少10位"/>,onOk:async()=>{const password=document.getElementById('admin-new-password')?.value||'';await api(`/api/admin/users/${r.id}/password`,{method:'POST',body:JSON.stringify({password})});message.success('密码已更新')}});
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>管理员账户</Title><Text type="secondary">管理后台账号与渠道账号分开维护</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={()=>setOpen(true)}>新增管理员</Button></div><Card><Table loading={loading} rowKey="id" dataSource={items} columns={[{title:'姓名',dataIndex:'name'},{title:'邮箱',dataIndex:'email'},{title:'状态',dataIndex:'status'},{title:'创建时间',dataIndex:'createdAt'},{title:'操作',render:(_,r)=><Button type="link" onClick={()=>reset(r)}>重置密码</Button>}]}/></Card><Drawer title="新增管理员" open={open} onClose={()=>setOpen(false)} width={480}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="姓名" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="email" label="登录邮箱" rules={[{required:true,type:'email'}]}><Input/></Form.Item><Form.Item name="password" label="初始密码" rules={[{required:true,min:10}]}><Input.Password/></Form.Item><Button type="primary" htmlType="submit">创建账户</Button></Form></Drawer></Space>;
}

function ReportApiKeys(){
  const [items,setItems]=useState([]),[loading,setLoading]=useState(true),[name,setName]=useState('账户日报查询');
  const load=async()=>{setLoading(true);try{setItems((await api('/api/admin/report-api-keys')).items||[])}catch(e){message.error(`日报 Key 加载失败：${e.message}`)}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);
  const create=async()=>{try{const r=await api('/api/admin/report-api-keys',{method:'POST',body:JSON.stringify({name})});await navigator.clipboard?.writeText(r.key);Modal.success({title:'账户日报 API Key 已生成',content:<Space direction="vertical"><Text>完整 Key 只显示这一次，已尝试复制到剪贴板：</Text><Input value={r.key} readOnly addonAfter={<Button icon={<CopyOutlined/>} onClick={()=>navigator.clipboard.writeText(r.key)}>复制</Button>}/></Space>});load()}catch(e){message.error(e.message)}};
  const revoke=async id=>{try{await api(`/api/admin/report-api-keys/${id}/revoke`,{method:'POST'});message.success('Key 已撤销');load()}catch(e){message.error(e.message)}};
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>账户日报 API Key</Title><Text type="secondary">只读查询每日账户数据，不需要网页登录；Key 仅显示一次，请妥善保存。</Text></div></div><Card title="生成只读 Key"><Space><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Key 名称" style={{width:260}}/><Button type="primary" icon={<KeyOutlined/>} onClick={create} disabled={!name.trim()}>生成 Key</Button></Space></Card><Card title="已生成的 Key"><Table loading={loading} rowKey="id" dataSource={items} columns={[{title:'名称',dataIndex:'name'},{title:'Key 前缀',dataIndex:'keyPrefix'},{title:'权限',dataIndex:'scope'},{title:'状态',dataIndex:'status',render:v=><Tag color={v==='active'?'green':'default'}>{v==='active'?'启用':'已撤销'}</Tag>},{title:'创建时间',dataIndex:'createdAt'},{title:'操作',render:(_,r)=>r.status==='active'&&<Popconfirm title="撤销后不可恢复，确认？" onConfirm={()=>revoke(r.id)}><Button danger type="link">撤销</Button></Popconfirm>}]}/></Card><Card title="调用方式"><pre>{`GET /api/public/account/revenue?start=2026-10-01&end=2026-10-21\nAuthorization: Bearer YOUR_REPORT_API_KEY`}</pre></Card></Space>;
}

function ApiDocs({ user }) {
  const [secret,setSecret]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{if(user?.role!=='channel')return;setLoading(true);api('/api/channel/api-secret').then(r=>setSecret(r.secret||'')).catch(e=>message.error(`API 密钥加载失败：${e.message}`)).finally(()=>setLoading(false))},[user]);
  const copy=async()=>{try{await navigator.clipboard.writeText(secret);message.success('API 密钥已复制')}catch{message.error('复制失败，请手动复制')}};
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>渠道 API</Title><Text type="secondary">渠道密钥只允许读取本渠道授权数据</Text></div></div><Card title="专用 API Key">{user?.role==='channel'?<Space direction="vertical" style={{width:'100%'}}><Text type="secondary">这是当前渠道专用的 API Key，仅能查询本渠道结算数据。</Text><Input.Password value={secret} readOnly loading={loading} addonAfter={<Button type="text" icon={<CopyOutlined/>} disabled={!secret} onClick={copy}>复制</Button>} placeholder="尚未生成，请联系管理员"/></Space>:<Alert type="info" showIcon message="管理员请在渠道管理中创建或轮换渠道 API Key"/>}</Card><Card title="认证方式"><Title level={4}>请求地址</Title><pre>{`GET /api/public/channel/revenue\nAuthorization: Bearer YOUR_SECRET`}</pre><Title level={4}>查询参数</Title><Space wrap><Tag>start_date</Tag><Tag>end_date</Tag><Tag>page</Tag><Tag>page_size</Tag></Space><Title level={4} style={{marginTop:20}}>返回字段</Title><Text>date、url、ad_unit、country、requests、matched_requests、impressions、clicks、revenue</Text><Alert style={{marginTop:20}} type="info" showIcon message={user?.role==='admin'?'管理员可在渠道管理中轮换密钥':'当前接口只返回你的渠道数据与结算后收入'} /></Card></Space>
}

function SettlementConfigEditor() {
  const [gamAccounts,setGamAccounts] = useState([]), [accounts,setAccounts] = useState([]), [channels,setChannels] = useState([]), [domains,setDomains] = useState([]), [rules,setRules] = useState([]);
  const [editingUp,setEditingUp] = useState(null), [editingDown,setEditingDown] = useState(null);
  const [upForm] = Form.useForm(), [downForm] = Form.useForm();
  const load = async () => {
    const [g,a,c,d,r] = await Promise.all([api('/api/admin/gam-accounts'),api('/api/admin/upstream-accounts'),api('/api/admin/channels'),api('/api/admin/ad-unit-domains'),api('/api/admin/domain-share-rules')]);
    setGamAccounts(g.items); setAccounts(a.items); setChannels(c.items); setDomains([...new Map(d.items.map(x=>[x.domain,x])).values()]); setRules(r.items);
  };
  useEffect(() => { load().catch(e=>message.error(e.message)); }, []);
  const saveUp = async v => {
    try { await api(editingUp?'/api/admin/upstream-accounts/'+editingUp.id:'/api/admin/upstream-accounts',{method:editingUp?'PUT':'POST',body:JSON.stringify(v)}); message.success('上游配置已保存'); upForm.resetFields(); setEditingUp(null); await load(); }
    catch(e) { message.error(e.message); }
  };
  const saveDown = async v => {
    try { await api(editingDown?'/api/admin/domain-share-rules/'+editingDown.id:'/api/admin/domain-share-rules',{method:editingDown?'PUT':'POST',body:JSON.stringify({...v,effectiveFrom:v.effectiveFrom?.format('YYYY-MM-DD')})}); message.success('下游配置已保存'); downForm.resetFields(); setEditingDown(null); await load(); }
    catch(e) { message.error(e.message); }
  };
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><Title level={2}>结算配置</Title></div>
    <Row gutter={[16,16]}>
      <Col xs={24} xl={10}><Card title={editingUp?'编辑上游账户':'新增上游账户'}><Form form={upForm} layout="vertical" onFinish={saveUp}>
        <Form.Item name="gamAccountId" label="Google Ad Manager REST 账户" rules={[{required:true}]}><Select options={gamAccounts.map(x=>({value:x.id,label:x.name+'（'+x.networkCode+'）'}))}/></Form.Item>
        <Form.Item name="accountKey" label="上游账户标识" rules={[{required:true}]}><Input disabled={Boolean(editingUp)}/></Form.Item>
        <Form.Item name="name" label="账户名称" rules={[{required:true}]}><Input/></Form.Item>
        <Form.Item name="sharePercent" label="上游结算比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} precision={2} style={{width:'100%'}}/></Form.Item>
        <Space><Button type="primary" htmlType="submit">保存上游配置</Button>{editingUp&&<Button onClick={()=>{setEditingUp(null);upForm.resetFields()}}>取消编辑</Button>}</Space>
      </Form><Table size="small" rowKey="id" dataSource={accounts} columns={[
        {title:'账户',dataIndex:'name'},{title:'REST 账户',dataIndex:'gamAccountName'},{title:'比例',dataIndex:'sharePercent',render:v=>v+'%'},
        {title:'操作',render:(_,r)=><Button type="link" onClick={()=>{setEditingUp(r);upForm.setFieldsValue(r)}}>编辑</Button>}
      ]}/></Card></Col>
      <Col xs={24} xl={14}><Card title={editingDown?'编辑下游规则':'新增下游规则'}><Form form={downForm} layout="vertical" onFinish={saveDown}>
        <Row gutter={12}><Col span={12}><Form.Item name="upstreamAccountId" label="上游账户" rules={[{required:true}]}><Select options={accounts.map(x=>({value:x.id,label:x.name}))}/></Form.Item></Col><Col span={12}><Form.Item name="channelId" label="下游渠道" rules={[{required:true}]}><Select options={channels.map(x=>({value:x.id,label:x.name}))}/></Form.Item></Col></Row>
        <Form.Item name="domain" label="下游域名（可选）"><Select allowClear showSearch options={domains.map(x=>({value:x.domain,label:x.domain}))} placeholder="不选择表示全部域名"/></Form.Item>
        <Row gutter={12}><Col span={12}><Form.Item name="sharePercent" label="下游结算比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} precision={2} style={{width:'100%'}}/></Form.Item></Col><Col span={12}><Form.Item name="effectiveFrom" label="生效日期" rules={[{required:true}]}><DatePicker style={{width:'100%'}}/></Form.Item></Col></Row>
        <Space><Button type="primary" htmlType="submit">保存下游配置</Button>{editingDown&&<Button onClick={()=>{setEditingDown(null);downForm.resetFields()}}>取消编辑</Button>}</Space>
      </Form><Table size="small" rowKey="id" dataSource={rules} columns={[
        {title:'上游',dataIndex:'upstreamAccountName'},{title:'下游',dataIndex:'channelName'},{title:'域名',dataIndex:'domain',render:v=>v||'全部域名'},
        {title:'比例',dataIndex:'sharePercent',render:v=>v+'%'},{title:'操作',render:(_,r)=><Button type="link" onClick={()=>{setEditingDown(r);downForm.setFieldsValue({...r,effectiveFrom:dayjs(r.effectiveFrom)})}}>编辑</Button>}
      ]}/></Card></Col>
    </Row>
  </Space>;
}

function Shell({ user, onLogout }) {
  const [view,setView]=useState('dashboard'); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  const admin=user.role==='admin';
  const menu=useMemo(()=>[
    {key:'dashboard',icon:<DashboardOutlined/>,label:'经营总览'},
    {key:'reports',icon:<BarChartOutlined/>,label:'数据报告'},
    ...(admin?[{type:'group',label:'平台管理',children:[{key:'channels',icon:<TeamOutlined/>,label:'渠道管理'},{key:'gam',icon:<SafetyOutlined/>,label:'Ad Manager REST'},{key:'settlement',icon:<DollarOutlined/>,label:'结算配置'},{key:'ad-units',icon:<PlusOutlined/>,label:'广告单元创建'},{key:'admins',icon:<UserSwitchOutlined/>,label:'管理员账户'},{key:'report-keys',icon:<KeyOutlined/>,label:'账户日报 API Key'}]}]:[]),
    {type:'group',label:'开发能力',children:[{key:'api',icon:<ApiOutlined/>,label:'渠道 API'}]}
  ],[admin]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin}/>:view==='channels'?<Channels/>:view==='imports'?<DataImport/>:view==='gam'?<GamAccounts/>:view==='settlement'?<SettlementConfigEditor/>:view==='ad-units'?<AdUnitBuilder/>:view==='admins'?<AdminUsers/>:view==='report-keys'?<ReportApiKeys/>:<ApiDocs user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={238}><div className="side-brand"><span>AX</span>{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key})=>setView(key)}/></Sider><Layout><Header><div><Text strong>{user.name||user.email}</Text><Tag color={admin?'blue':'cyan'}>{admin?'平台管理员':'渠道账号'}</Tag></div><Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm></Header><Content><PageErrorBoundary key={view}>{body}</PageErrorBoundary></Content></Layout></Layout>;
}

function Root({ initialUser }) {
  const [user,setUser]=useState(initialUser || null); const [ready,setReady]=useState(Boolean(initialUser));
  useEffect(()=>{if(initialUser)return;api('/api/auth/me').then(r=>setUser(r.user)).catch(()=>{}).finally(()=>setReady(true))},[initialUser]);
  const logout=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});setUser(null)};
  if(!ready)return <div className="boot">正在加载安全工作区…</div>;
  return user?<Shell user={user} onLogout={logout}/>:<Login onLogin={setUser}/>;
}

export function mountApp(initialUser) {
  createRoot(document.getElementById('root')).render(<AntApp><Root initialUser={initialUser}/></AntApp>);
}
