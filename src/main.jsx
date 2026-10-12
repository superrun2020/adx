import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp, Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form,
  Input, InputNumber, Layout, Menu, Modal, Popconfirm, Row, Select, Space, Statistic, Table,
  Tag, Typography, message
} from 'antd';
import {
  ApiOutlined, BarChartOutlined, DashboardOutlined, DollarOutlined, KeyOutlined,
  LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UploadOutlined, UserSwitchOutlined
} from '@ant-design/icons';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import dayjs from 'dayjs';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
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
    [admin?'总原始收入':'渠道结算收入', money(summary.revenue), <DollarOutlined />],
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
    <Row gutter={[16, 16]}><Col xs={24} xl={16}><Card title="每日收益趋势" extra={data.lastSync ? `最近同步 ${data.lastSync}` : '尚未同步'}><div className="chart"><ResponsiveContainer><AreaChart data={data.trend}><defs><linearGradient id="revenue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#168aad" stopOpacity={.35}/><stop offset="95%" stopColor="#168aad" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date"/><YAxis/><Tooltip formatter={v => money(v)}/><Area type="monotone" dataKey="revenue" stroke="#168aad" fill="url(#revenue)" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></Card></Col><Col xs={24} xl={8}><Card title="收益最高的链接"><Table size="small" pagination={false} rowKey="url" dataSource={data.topUrls} columns={[{ title: '链接', dataIndex: 'url', ellipsis: true }, { title: '收益', dataIndex: 'revenue', align: 'right', render: money }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}/></Card></Col></Row>
  </Space>;
}

function Reports({ range, setRange, admin }) {
  const [rows, setRows] = useState([]); const [loading, setLoading] = useState(false); const [dimension, setDimension] = useState(['account','adUnit','url','date','hour','country']); const [filters,setFilters]=useState({account:'',adUnit:'',domain:''});
  const load = async () => { setLoading(true); try { const q = new URLSearchParams({start:range[0].format('YYYY-MM-DD'),end:range[1].format('YYYY-MM-DD'),dimensions:dimension.join(','),...Object.fromEntries(Object.entries(filters).filter(([,v])=>v.trim()))}); setRows((await api(`/api/reports?${q}`)).items); } catch(e){message.error(e.message)} finally{setLoading(false)} };
  useEffect(()=>{load()},[range[0].valueOf(),range[1].valueOf(),dimension.join(',')]);
  const dimensions=[['date','日期'],['url','链接'],['account','账号'],['adUnit','广告单元'],['hour','小时'],['country','国家']];
  const cols=[...dimension.map(d=>({title:dimensions.find(x=>x[0]===d)?.[1],dataIndex:d,ellipsis:true,fixed:d==='date'?'left':undefined})),{title:'请求',dataIndex:'requests',align:'right',render:number},{title:'匹配',dataIndex:'matchedRequests',align:'right',render:number},{title:'展示',dataIndex:'impressions',align:'right',render:number},{title:'点击',dataIndex:'clicks',align:'right',render:number},{title:'匹配率',dataIndex:'matchRate',align:'right',render:v=>`${Number(v).toFixed(2)}%`},{title:admin?'总流水':'结算收入',dataIndex:'revenue',align:'right',render:money},...(admin?[{title:'上游分成后',dataIndex:'upstreamRevenue',align:'right',render:money},{title:'上游比例',dataIndex:'upstreamSharePercent',align:'right',render:v=>`${v}%`},{title:'下游比例',dataIndex:'channelSharePercent',align:'right',render:v=>`${v}%`},{title:'渠道结算',dataIndex:'channelRevenue',align:'right',render:money}]:[])];
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>数据报告</Title><Text type="secondary">支持按小时、账户、广告单元和域名查询，结算金额按规则自动计算</Text></div></div><Card><Space wrap><DatePicker.RangePicker value={range} onChange={v=>v&&setRange(v)}/><Input placeholder="广告账户" value={filters.account} onChange={e=>setFilters({...filters,account:e.target.value})} style={{width:160}}/><Input placeholder="广告单元" value={filters.adUnit} onChange={e=>setFilters({...filters,adUnit:e.target.value})} style={{width:220}}/><Input placeholder="域名" value={filters.domain} onChange={e=>setFilters({...filters,domain:e.target.value})} style={{width:180}}/><Select mode="multiple" value={dimension} onChange={v=>v.length&&setDimension(v)} options={dimensions.map(([value,label])=>({value,label}))} style={{minWidth:360}}/><Button type="primary" icon={<BarChartOutlined/>} onClick={load}>搜索</Button><Button onClick={()=>{setFilters({account:'',adUnit:'',domain:''});setDimension(['account','adUnit','url','date','hour','country'])}}>重置</Button></Space></Card><Card title="小时明细"><Table rowKey={(r,i)=>JSON.stringify(r)+i} loading={loading} dataSource={rows} columns={cols} scroll={{x:1500}} pagination={{pageSize:20,showSizeChanger:true}}/></Card></Space>;
}

function SettlementConfig() {
  const [accounts,setAccounts]=useState([]),[units,setUnits]=useState([]),[rules,setRules]=useState([]),[channels,setChannels]=useState([]);
  const [accountForm]=Form.useForm(),[unitForm]=Form.useForm(),[ruleForm]=Form.useForm();
  const load=async()=>{try{const [a,u,r,c]=await Promise.all([api('/api/admin/upstream-accounts'),api('/api/admin/ad-unit-domains'),api('/api/admin/share-rules'),api('/api/admin/channels')]);setAccounts(a.items);setUnits(u.items);setRules(r.items);setChannels(c.items)}catch(e){message.error(`结算配置加载失败：${e.message}`)}};
  useEffect(()=>{load()},[]);
  const submit=async(path,values,form)=>{try{const payload={...values,effectiveFrom:values.effectiveFrom?.format('YYYY-MM-DD')};await api(path,{method:'POST',body:JSON.stringify(payload)});message.success('已保存并读回');form.resetFields();load()}catch(e){message.error(e.message)}};
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>结算配置</Title><Text type="secondary">上游账户、广告单元域名和渠道下游比例分开配置，最具体规则优先</Text></div></div><Row gutter={[16,16]}><Col xs={24} xl={8}><Card title="上游账户分成"><Form form={accountForm} layout="vertical" onFinish={v=>submit('/api/admin/upstream-accounts',v,accountForm)}><Form.Item name="accountKey" label="上游账户标识" rules={[{required:true}]}><Input placeholder="Ad Manager account"/></Form.Item><Form.Item name="name" label="账户名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="sharePercent" label="上游分成比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} style={{width:'100%'}}/></Form.Item><Button type="primary" htmlType="submit">保存上游账户</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={accounts} columns={[{title:'账户',dataIndex:'accountKey'},{title:'比例',dataIndex:'sharePercent',render:v=>`${v}%`}]} /></Card></Col><Col xs={24} xl={8}><Card title="广告单元绑定域名"><Form form={unitForm} layout="vertical" onFinish={v=>submit('/api/admin/ad-unit-domains',v,unitForm)}><Form.Item name="adUnit" label="广告单元" rules={[{required:true}]}><Input placeholder="Ad unit name or ID"/></Form.Item><Form.Item name="domain" label="域名" rules={[{required:true}]}><Input placeholder="https://example.com"/></Form.Item><Button type="primary" htmlType="submit">保存域名绑定</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={units} columns={[{title:'广告单元',dataIndex:'adUnit'},{title:'域名',dataIndex:'domain'}]} /></Card></Col><Col xs={24} xl={8}><Card title="渠道下游比例"><Form form={ruleForm} layout="vertical" onFinish={v=>submit('/api/admin/share-rules',v,ruleForm)}><Form.Item name="channelId" label="渠道" rules={[{required:true}]}><Select options={channels.map(c=>({value:c.id,label:c.name}))}/></Form.Item><Form.Item name="scopeType" label="规则维度" initialValue="ad_unit"><Select options={[{value:'ad_unit',label:'广告单元'},{value:'account',label:'上游账户'}]}/></Form.Item><Form.Item name="scopeValue" label="匹配值" rules={[{required:true}]}><Input placeholder="广告单元或账户标识"/></Form.Item><Form.Item name="sharePercent" label="下游结算比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} style={{width:'100%'}}/></Form.Item><Form.Item name="effectiveFrom" label="生效日期" rules={[{required:true}]} initialValue={dayjs()}><DatePicker format="YYYY-MM-DD" style={{width:'100%'}}/></Form.Item><Button type="primary" htmlType="submit">保存下游规则</Button></Form><Table size="small" pagination={{pageSize:5}} rowKey="id" dataSource={rules} columns={[{title:'维度',dataIndex:'scopeType'},{title:'匹配值',dataIndex:'scopeValue'},{title:'比例',dataIndex:'sharePercent',render:v=>`${v}%`}]} /></Card></Col></Row></Space>;
}

function AdUnitBuilder() {
  const [file,setFile]=useState(null),[payload,setPayload]=useState(null),[preview,setPreview]=useState(null),[items,setItems]=useState([]),[busy,setBusy]=useState(false);
  const [subdomains,setSubdomains]=useState([]),[types,setTypes]=useState([]),[sizes,setSizes]=useState([]);
  const choose=async e=>{const picked=e.target.files?.[0];if(!picked)return;try{setPayload(JSON.parse(await picked.text()));setFile(picked);setPreview(null)}catch{message.error('JSON 文件无法解析')}};
  const runPreview=async()=>{if(!payload)return message.warning('请先上传 JSON');setBusy(true);try{const r=await api('/api/admin/ad-units/preview',{method:'POST',body:JSON.stringify({payload,rules:{subdomains,inventoryTypes:types,sizes}})});setPreview(r);setItems(r.items)}catch(e){message.error(e.message)}finally{setBusy(false)}};
  const create=async()=>{setBusy(true);try{const r=await api('/api/admin/ad-units/create',{method:'POST',body:JSON.stringify({items})});message.success(`已保存 ${r.created} 个广告单元计划`);load()}catch(e){message.error(e.message)}finally{setBusy(false)}};
  const load=()=>api('/api/admin/ad-units').then(r=>setItems(r.items)).catch(e=>message.error(e.message));useEffect(()=>{load()},[]);
  const options=(values,setter)=><Select mode="tags" allowClear value={values} onChange={setter} style={{width:'100%'}} tokenSeparators={[',','，']} placeholder="可输入多个值" />;
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>广告单元创建</Title><Text type="secondary">从 JSON 识别子域名、广告位类型和尺寸，先预览再保存创建计划</Text></div></div><Alert type="info" showIcon message="当前为本地创建计划" description="创建记录会保存到后台，GAM API 权限恢复后再执行真实上游创建。"/><Card title="生成规则"><Row gutter={[16,16]}><Col xs={24} md={8}><Text strong>子域名（可多选）</Text>{options(subdomains,setSubdomains)}</Col><Col xs={24} md={8}><Text strong>广告位类型（可多选）</Text>{options(types,setTypes)}</Col><Col xs={24} md={8}><Text strong>尺寸（可多选）</Text>{options(sizes,setSizes)}</Col></Row><Space wrap style={{marginTop:16}}><label className="file-button"><UploadOutlined/> {file?.name||'上传 JSON'}<input type="file" accept="application/json,.json" onChange={choose}/></label><Button type="primary" loading={busy} disabled={!payload} onClick={runPreview}>预览广告单元</Button></Space></Card>{preview&&<Card title={`预览结果：${preview.total} 个`} extra={<Button type="primary" disabled={!items.length} loading={busy} onClick={create}>创建广告单元计划</Button>}><Alert type={preview.duplicates?.length?'warning':'success'} showIcon message={preview.duplicates?.length?`发现 ${preview.duplicates.length} 个重复项，将自动跳过`:'未发现重复项'}/><Table rowKey="code" dataSource={items} columns={[{title:'名称',dataIndex:'name'},{title:'子域名',dataIndex:'subdomain'},{title:'广告位类型',dataIndex:'inventoryType'},{title:'尺寸',dataIndex:'size'},{title:'编码',dataIndex:'code'}]} scroll={{x:900}} pagination={{pageSize:20}}/></Card>}</Space>;
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

function AdminUsers(){
  const[items,setItems]=useState([]),[open,setOpen]=useState(false),[loading,setLoading]=useState(true);const[form]=Form.useForm();const load=async()=>{setLoading(true);try{setItems((await api('/api/admin/users')).items)}catch(e){message.error(`管理员账户加载失败：${e.message}`)}finally{setLoading(false)}};useEffect(()=>{load()},[]);
  const save=async v=>{await api('/api/admin/users',{method:'POST',body:JSON.stringify(v)});message.success('管理员已创建');setOpen(false);load()};
  const reset=r=>Modal.confirm({title:`重置 ${r.name} 的密码`,content:<Input.Password id="admin-new-password" placeholder="至少10位"/>,onOk:async()=>{const password=document.getElementById('admin-new-password')?.value||'';await api(`/api/admin/users/${r.id}/password`,{method:'POST',body:JSON.stringify({password})});message.success('密码已更新')}});
  return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>管理员账户</Title><Text type="secondary">管理后台账号与渠道账号分开维护</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={()=>setOpen(true)}>新增管理员</Button></div><Card><Table loading={loading} rowKey="id" dataSource={items} columns={[{title:'姓名',dataIndex:'name'},{title:'邮箱',dataIndex:'email'},{title:'状态',dataIndex:'status'},{title:'创建时间',dataIndex:'createdAt'},{title:'操作',render:(_,r)=><Button type="link" onClick={()=>reset(r)}>重置密码</Button>}]}/></Card><Drawer title="新增管理员" open={open} onClose={()=>setOpen(false)} width={480}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="name" label="姓名" rules={[{required:true}]}><Input/></Form.Item><Form.Item name="email" label="登录邮箱" rules={[{required:true,type:'email'}]}><Input/></Form.Item><Form.Item name="password" label="初始密码" rules={[{required:true,min:10}]}><Input.Password/></Form.Item><Button type="primary" htmlType="submit">创建账户</Button></Form></Drawer></Space>;
}

function ApiDocs({ user }) { return <Space direction="vertical" size={16} className="page-stack"><div className="page-heading"><div><Title level={2}>渠道 API</Title><Text type="secondary">渠道密钥只允许读取本渠道授权数据</Text></div></div><Card><Typography><Title level={4}>认证</Title><pre>{`GET /api/public/channel/revenue\nAuthorization: Bearer YOUR_SECRET`}</pre><Title level={4}>查询参数</Title><p><code>start_date</code>、<code>end_date</code>、<code>page</code>、<code>page_size</code></p><Title level={4}>返回字段</Title><p>date、url、ad_unit、country、requests、matched_requests、impressions、clicks、revenue</p><Alert type="info" showIcon message={user.role==='admin'?'管理员可在渠道管理中轮换密钥':'当前接口只返回你的渠道数据与结算后收入'} /></Typography></Card></Space> }

function Shell({ user, onLogout }) {
  const [view,setView]=useState('dashboard'); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  const admin=user.role==='admin';
  const menu=useMemo(()=>[
    {key:'dashboard',icon:<DashboardOutlined/>,label:'经营总览'},
    {key:'reports',icon:<BarChartOutlined/>,label:'数据报告'},
    ...(admin?[{type:'group',label:'平台管理',children:[{key:'channels',icon:<TeamOutlined/>,label:'渠道管理'},{key:'imports',icon:<UploadOutlined/>,label:'JSON数据导入'},{key:'settlement',icon:<DollarOutlined/>,label:'结算配置'},{key:'ad-units',icon:<PlusOutlined/>,label:'广告单元创建'},{key:'admins',icon:<UserSwitchOutlined/>,label:'管理员账户'}]}]:[]),
    {type:'group',label:'开发能力',children:[{key:'api',icon:<ApiOutlined/>,label:'渠道 API'}]}
  ],[admin]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin}/>:view==='channels'?<Channels/>:view==='imports'?<DataImport/>:view==='settlement'?<SettlementConfig/>:view==='ad-units'?<AdUnitBuilder/>:view==='admins'?<AdminUsers/>:<ApiDocs user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={238}><div className="side-brand"><span>AX</span>{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key})=>setView(key)}/></Sider><Layout><Header><div><Text strong>{user.name||user.email}</Text><Tag color={admin?'blue':'cyan'}>{admin?'平台管理员':'渠道账号'}</Tag></div><Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm></Header><Content><PageErrorBoundary key={view}>{body}</PageErrorBoundary></Content></Layout></Layout>;
}

function Root() {
  const [user,setUser]=useState(null); const [ready,setReady]=useState(false);
  useEffect(()=>{api('/api/auth/me').then(r=>setUser(r.user)).catch(()=>{}).finally(()=>setReady(true))},[]);
  const logout=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});setUser(null)};
  if(!ready)return <div className="boot">正在加载安全工作区…</div>;
  return user?<Shell user={user} onLogout={logout}/>:<Login onLogin={setUser}/>;
}

createRoot(document.getElementById('root')).render(<AntApp><Root/></AntApp>);
