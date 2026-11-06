import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Collapse, DatePicker, Descriptions, Drawer, Dropdown, Empty, Form,
  Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table,
  Tag, Typography, message
} from 'antd';
import {
  ApiOutlined, BarChartOutlined, CopyOutlined, DashboardOutlined, DollarOutlined, KeyOutlined,
  LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UploadOutlined, UserSwitchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import GamAdUnitCreator from './GamAdUnitCreator.jsx';
import { adminPermissionOptions } from './navigation.js';

const { Title, Text } = Typography;
const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = value => Number(value || 0).toLocaleString('zh-CN');
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'http_' + response.status);
  return payload;
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
  const [gamAccountId,setGamAccountId] = useState(null);
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
  const publish = async item => {
    if(!gamAccountId)return message.warning('请选择 REST 账户');
    setBusy('publish:'+item.id);
    try { const result=await api('/api/admin/ad-units/'+item.id+'/publish',{method:'POST',body:JSON.stringify({gamAccountId})}); message.success('已通过 REST 创建顶级广告单元：'+result.name); await load(); }
    catch(e) { message.error(e.message); await load(); } finally { setBusy(''); }
  };
  const download = () => {
    const rows=(preview?.items||items).map(x=>[x.code,x.name,x.size,x.description,x.adsenseEnabled?'是':'否',x.placement,x.targetWindow,x.label,x.status||'planned',x.providerId||'']);
    const csv='\ufeff'+[['代码','名称','大小','说明','AdSense','刊登位置','目标窗口','标签','状态','REST 资源名'],...rows].map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a'); a.href=url; a.download='ad-units.csv'; a.click(); URL.revokeObjectURL(url);
  };
  const options=(values,setter)=><Select mode="tags" allowClear value={values} onChange={setter} style={{width:'100%'}} tokenSeparators={[',','，']} placeholder="可输入多个值"/>;
  return <Space direction="vertical" size={16} className="page-stack">
    <GamAdUnitCreator accounts={accounts}/>
    <Collapse items={[{key:'legacy',label:'旧版 JSON 导入与创建任务',children:<Space direction="vertical" size={16} style={{width:'100%'}}>
    <Alert type="info" showIcon message="JSON 导入兼容模式" description="已有 JSON 任务仍可在下方发布。新建广告单元推荐使用上方的 GAM Sites 域名和尺寸模板批量同步。"/>
    <Card title="JSON 任务生成规则"><Row gutter={[16,16]}><Col xs={24} md={8}><Text strong>子域名</Text>{options(subdomains,setSubdomains)}</Col><Col xs={24} md={8}><Text strong>广告位类型</Text>{options(types,setTypes)}</Col><Col xs={24} md={8}><Text strong>尺寸</Text>{options(sizes,setSizes)}</Col></Row>
      <Space wrap style={{marginTop:16}}><label className="file-button"><UploadOutlined/> {file?.name||'上传广告单元表 JSON'}<input type="file" accept="application/json,.json" onChange={choose}/></label><Button type="primary" loading={busy==='preview'} disabled={!payload} onClick={runPreview}>预览广告单元</Button></Space>
    </Card>
    {preview&&<Card title={'预览结果：'+preview.total+' 个'} extra={<Space><Button onClick={download}>下载</Button><Button type="primary" loading={busy==='create'} onClick={create}>保存创建任务</Button></Space>}>
      <Alert type={preview.duplicates?.length?'warning':'success'} showIcon message={preview.duplicates?.length?'发现 '+preview.duplicates.length+' 个重复项，将跳过':'未发现重复项'}/>
      <Table rowKey="code" dataSource={preview.items} pagination={{pageSize:20}} scroll={{x:1100}} columns={[
        {title:'名称',dataIndex:'name'},{title:'编码',dataIndex:'code'},{title:'尺寸',dataIndex:'size'},{title:'说明',dataIndex:'description'},
        {title:'AdSense',dataIndex:'adsenseEnabled',render:v=>v?'是':'否'},{title:'刊登位置',dataIndex:'placement'},{title:'目标窗口',dataIndex:'targetWindow'}
      ]}/>
    </Card>}
    <Card title="JSON 任务 REST 发布设置"><Space wrap>
      <Select style={{minWidth:230}} placeholder="选择 REST 账户" value={gamAccountId} onChange={setGamAccountId} options={accounts.filter(x=>x.status==='active').map(x=>({value:x.id,label:x.name+'（'+x.networkCode+'）'}))}/>
      <Text type="secondary">发布时自动使用该账号的网络根单元，创建顶级广告单元。</Text>
    </Space></Card>
    <Card title="原有 JSON 创建任务" extra={<Button onClick={download} disabled={!items.length}>导出 CSV</Button>}><Table rowKey="id" dataSource={items} scroll={{x:1300}} columns={[
      {title:'编码',dataIndex:'code'},{title:'名称',dataIndex:'name'},{title:'尺寸',dataIndex:'size'},
      {title:'状态',dataIndex:'status',render:v=><Tag color={v==='created'?'green':v==='failed'?'red':'orange'}>{v==='created'?'已创建':v==='failed'?'失败':'待发布'}</Tag>},
      {title:'REST 资源名',dataIndex:'providerId',ellipsis:true},{title:'错误',dataIndex:'publishError',ellipsis:true},
      {title:'操作',render:(_,r)=>r.status==='created'?null:<Popconfirm title={'确认将 '+r.code+' 发布到所选 REST 账户？'} onConfirm={()=>publish(r)}><Button size="small" type="primary" loading={busy==='publish:'+r.id}>发布</Button></Popconfirm>}
    ]}/></Card>
    </Space>}]} />
  </Space>;
}

function Channels() {
  const [items,setItems]=useState([]); const [open,setOpen]=useState(false); const [editing,setEditing]=useState(null); const [form]=Form.useForm();
  const load=()=>api('/api/admin/channels').then(r=>setItems(r.items)).catch(e=>message.error(e.message)); useEffect(()=>{ void load(); },[]);
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
  const [filters,setFilters] = useState({});
  const [busy,setBusy] = useState(''), [editing,setEditing] = useState(null), [reportAccount,setReportAccount] = useState(null);
  const [file,setFile] = useState(null), [credentials,setCredentials] = useState(null), [preview,setPreview] = useState(null);
  const [dates,setDates] = useState(null);
  const [form] = Form.useForm(), [filterForm] = Form.useForm(), [reportForm] = Form.useForm();
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
  const openCreate = () => {
    form.resetFields(); form.setFieldsValue({advertiserSharePercent:0,operationStatus:'normal',enabled:true});
    setCredentials(null); setFile(null); setEditing({id:null});
  };
  const openEdit = item => {
    form.setFieldsValue({name:item.name,accountEmail:item.accountEmail,networkCode:item.networkCode,advertiser:item.advertiser || upstreamField(item,'advertiser').replace('—',''),bd:item.bd || upstreamField(item,'bd').replace('—',''),advertiserSharePercent:item.advertiserSharePercent || 0,operationStatus:item.operationStatus || 'normal',enabled:item.enabled !== 0,notes:item.notes});
    setCredentials(null); setFile(null); setEditing(item);
  };
  const save = async values => {
    if (!editing?.id && !credentials) return message.warning('新建账户需要上传服务账号 JSON');
    if (!editing?.id && items.some(item=>item.networkCode===values.networkCode?.trim())) return message.error('Network Code 已存在，请用编辑操作');
    setBusy('save');
    try {
      const payload = {...values,enabled:Boolean(values.enabled),...(credentials?{credentials}:{})};
      await api(editing?.id?'/api/admin/gam-accounts/'+editing.id:'/api/admin/gam-accounts', {method:editing?.id?'PUT':'POST',body:JSON.stringify(payload)});
      message.success(editing?.id?'账号已更新':'账户已保存，请测试连接');
      form.resetFields(); setCredentials(null); setFile(null); setEditing(null); await load();
    }
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
  const selectedDates = () => dates ? {start:dates[0].format('YYYY-MM-DD'),end:dates[1].format('YYYY-MM-DD')} : {};
  const previewReport = item => invoke(item.id,'preview',selectedDates(),'报表预览完成');
  const syncNow = item => invoke(item.id,'sync-now',selectedDates(),'REST 数据已写入本地报表');
  const upstreamField = (item, field) => [...new Set(upstream.filter(account => account.gamAccountId === item.id).map(account => account[field]).filter(Boolean))].join('、') || '—';
  const filteredItems = items.filter(item => {
    const search = String(filters.search || '').trim().toLowerCase();
    return (!search || [item.name,item.accountEmail,item.networkCode].some(value=>String(value||'').toLowerCase().includes(search))) &&
      (!filters.advertiser || (item.advertiser || upstreamField(item,'advertiser')) === filters.advertiser) &&
      (!filters.bd || (item.bd || upstreamField(item,'bd')) === filters.bd) &&
      (!filters.operationStatus || item.operationStatus === filters.operationStatus) &&
      (filters.enabled === undefined || Boolean(item.enabled) === filters.enabled);
  });
  const advertiserOptions = [...new Set(items.map(item=>item.advertiser || upstreamField(item,'advertiser')).filter(value=>value && value!=='—'))].map(value=>({value,label:value}));
  const bdOptions = [...new Set(items.map(item=>item.bd || upstreamField(item,'bd')).filter(value=>value && value!=='—'))].map(value=>({value,label:value}));
  const accountActions = item => [
    {key:'test',label:'测试 REST 连接'},
    {key:'report',label:'配置报表',disabled:item.status!=='active'||!item.enabled},
    {key:'preview',label:'预览报表',disabled:!item.reportName||!item.enabled},
    {key:item.syncEnabled?'pause':'activate',label:item.syncEnabled?'暂停自动同步':'启用自动同步',disabled:!item.syncEnabled&&(!item.lastPreviewRows||!item.enabled)},
    {key:'sync',label:'立即同步',disabled:!item.syncEnabled||!item.enabled}
  ];
  const accountAction = (item, key) => {
    if (key==='test') return void invoke(item.id,'test',{},'连接成功');
    if (key==='report') return openReport(item);
    if (key==='preview') return void previewReport(item);
    if (key==='pause') return void invoke(item.id,'pause',{},'自动入库已暂停');
    if (key==='activate') return Modal.confirm({title:'已核对金额单位及新旧报表口径？',onOk:()=>invoke(item.id,'activate',{},'自动入库已启用')});
    if (key==='sync') return Modal.confirm({title:'确认将所选日期范围写入本地报表？',content:dates?'使用上方手选日期。':'默认按此账号网络时区读取昨日到今日。',onOk:()=>syncNow(item)});
  };
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>账号管理</Title><Text type="secondary">管理 Ad Manager 账号、授权密钥与数据同步</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={openCreate}>新增账号</Button></div>
    <Card className="account-filter-card"><Form form={filterForm} onFinish={setFilters} className="account-filter-form">
      <Form.Item name="search"><Input allowClear placeholder="账号名称 / 邮箱"/></Form.Item>
      <Form.Item name="advertiser"><Select allowClear placeholder="广告主" options={advertiserOptions}/></Form.Item>
      <Form.Item name="bd"><Select allowClear placeholder="BD" options={bdOptions}/></Form.Item>
      <Form.Item name="operationStatus"><Select allowClear placeholder="运营状态" options={[{value:'normal',label:'正常'},{value:'limited',label:'限流'},{value:'unknown',label:'未设置'}]}/></Form.Item>
      <Form.Item name="enabled"><Select allowClear placeholder="启用状态" options={[{value:true,label:'已启用'},{value:false,label:'已停用'}]}/></Form.Item>
      <Form.Item><Space><Button type="primary" htmlType="submit">搜索</Button><Button onClick={()=>{filterForm.resetFields();setFilters({});}}>重置</Button></Space></Form.Item>
    </Form></Card>
    <Card className="account-table-card"><Table rowKey="id" dataSource={filteredItems} locale={{emptyText:'暂无账号'}} pagination={{pageSize:10,showSizeChanger:false}} scroll={{x:1135}} columns={[
      {title:'账号',width:210,render:(_,item)=><div className="account-identity"><strong>{item.name}</strong><small>{item.accountEmail || '未填写账号邮箱'}</small></div>},
      {title:'Network Code',width:145,render:(_,item)=><div className="account-identity">{item.networkCode}<small>{item.timeZone||'时区待测试'}</small></div>},
      {title:'广告主',width:125,ellipsis:true,render:(_,item)=>item.advertiser || upstreamField(item,'advertiser')},
      {title:'BD',width:95,ellipsis:true,render:(_,item)=>item.bd || upstreamField(item,'bd')},
      {title:'运营状态',dataIndex:'operationStatus',width:95,render:value=><Tag color={value==='limited'?'gold':value==='normal'?'green':'default'}>{value==='limited'?'限流':value==='normal'?'正常':'未设置'}</Tag>},
      {title:'启用',dataIndex:'enabled',width:85,render:value=><Tag color={value?'green':'default'}>{value?'已启用':'已停用'}</Tag>},
      {title:'配置',width:230,render:(_,item)=><Space size={[4,4]} wrap><Tag color={item.credentialConfigured?'blue':'red'}>{item.credentialConfigured?'密钥已配':'缺少密钥'}</Tag><Tag color={item.status==='active'?'green':item.status==='error'?'red':'orange'}>{item.status==='active'?'连接可用':item.status==='error'?'连接失败':'待测试'}</Tag><Tag color={item.syncEnabled?'green':'default'}>{item.syncEnabled?'同步启用':'同步暂停'}</Tag></Space>},
      {title:'操作',width:150,render:(_,item)=><Space size={4}><Button type="link" onClick={()=>openEdit(item)}>编辑</Button><Dropdown menu={{items:accountActions(item),onClick:({key})=>accountAction(item,key)}} trigger={['click']}><Button size="small">更多</Button></Dropdown></Space>}
    ]}/></Card>
    <Alert type="warning" showIcon message="先核对新旧报表的财务口径" description="REST 的 AD_EXCHANGE_REVENUE 与旧报表的行项目级收入不可直接视为相同。请先选择渠道、上游账户和金额单位，预览核对后再启用自动入库。"/>
    <Card title="日期范围（预览或手动同步）"><Space wrap><DatePicker.RangePicker value={dates} onChange={setDates} placeholder={['账号时区：昨日','账号时区：今日']}/><Text type="secondary">留空时按每个 Ad Manager 账号自身时区读取昨日到今日；手选日期则按指定日期。</Text></Space></Card>
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
    <Modal title={editing?.id?'编辑 Ad Manager 账号':'新增 Ad Manager 账号'} open={Boolean(editing)} onCancel={()=>setEditing(null)} footer={null} width={760} maskClosable={false} forceRender styles={{body:{maxHeight:'calc(100vh - 190px)',overflowY:'auto'}}}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Row gutter={16}>
          <Col xs={24} md={12}><Form.Item name="name" label="账号名称" rules={[{required:true,message:'请输入账号名称'}]}><Input maxLength={200}/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="accountEmail" label="账号邮箱" rules={[{type:'email',message:'邮箱格式不正确'}]}><Input type="email"/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="networkCode" label="Network Code" extra={editing?.id?'创建后不可更改；更换网络请新增账号':null} rules={[{required:true,pattern:/^\d{6,}$/,message:'请输入至少 6 位数字'}]}><Input readOnly={Boolean(editing?.id)}/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="bd" label="BD"><Input maxLength={200}/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="advertiser" label="广告主"><Input maxLength={200}/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="advertiserSharePercent" label="广告主分成比例（%）"><InputNumber min={0} max={100} precision={2} style={{width:'100%'}}/></Form.Item></Col>
        </Row>
        <Form.Item label={editing?.id?'替换 Google JSON 密钥（可选）':'Google JSON 密钥'} required={!editing?.id}>
          <label className="account-key-upload"><UploadOutlined/> <span>{file?.name|| (editing?.id?'留空保留当前密钥，上传则替换':'点击上传服务账号 JSON')}</span><input type="file" accept="application/json,.json" onChange={choose}/></label>
          <Text type="secondary">密钥仅在服务器加密保存，页面不会回显明文。替换密钥或 Network Code 后，需重新测试和启用同步。</Text>
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} md={12}><Form.Item name="operationStatus" label="运营状态"><Select options={[{value:'normal',label:'正常'},{value:'limited',label:'限流'},{value:'unknown',label:'未设置'}]}/></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="enabled" label="启用状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用"/></Form.Item></Col>
        </Row>
        <Form.Item name="notes" label="备注"><Input.TextArea rows={2} maxLength={2000} showCount/></Form.Item>
        <div className="account-proxy-note"><strong>代理配置（可选）</strong><Text type="secondary">当前 REST 连接沿用服务器网络代理配置。</Text></div>
        <Text type="secondary">账号资料中的广告主比例仅用于记录；实际结算以「结算配置」为准。停用账号会暂停自动同步。</Text>
        <div className="account-modal-actions"><Button onClick={()=>setEditing(null)}>取消</Button><Button type="primary" htmlType="submit" loading={busy==='save'}>保存账号</Button></div>
      </Form>
    </Modal>
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

function AdminUsers({user}){
  const [items,setItems]=useState([]),[editing,setEditing]=useState(null),[open,setOpen]=useState(false),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
  const [form]=Form.useForm();
  const isSuper=Form.useWatch('isSuperAdmin',form);
  const load=async()=>{setLoading(true);try{setItems((await api('/api/admin/users')).items||[])}catch(e){message.error('管理员账户加载失败：'+e.message)}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);
  const openCreate=()=>{setEditing(null);form.resetFields();form.setFieldsValue({isSuperAdmin:false,sidebarPermissions:['dashboard','reports']});setOpen(true)};
  const openEdit=item=>{setEditing(item);form.setFieldsValue({name:item.name,status:item.status,isSuperAdmin:item.isSuperAdmin,sidebarPermissions:item.sidebarPermissions});setOpen(true)};
  const save=async values=>{setSaving(true);try{const path=editing?'/api/admin/users/'+editing.id:'/api/admin/users';await api(path,{method:editing?'PUT':'POST',body:JSON.stringify(values)});message.success(editing?'管理员权限已更新；该账号需重新登录':'管理员已创建');setOpen(false);await load()}catch(e){message.error('保存失败：'+e.message)}finally{setSaving(false)}};
  const reset=item=>Modal.confirm({title:'重置 '+item.name+' 的密码',content:<Input.Password id="admin-new-password" placeholder="至少10位"/>,onOk:async()=>{const password=document.getElementById('admin-new-password')?.value||'';try{await api('/api/admin/users/'+item.id+'/password',{method:'POST',body:JSON.stringify({password})});message.success('密码已更新，旧会话已退出')}catch(e){message.error('重置失败：'+e.message);throw e}}});
  const remove=async item=>{try{await api('/api/admin/users/'+item.id,{method:'DELETE'});message.success('管理员已删除，旧会话已失效');await load()}catch(e){message.error('删除失败：'+e.message)}};
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>管理员账户</Title><Text type="secondary">最高管理员可授权菜单并管理其他管理员；权限同时在后端接口校验</Text></div><Button type="primary" icon={<PlusOutlined/>} onClick={openCreate}>新增管理员</Button></div>
    <Card><Table loading={loading} rowKey="id" dataSource={items} scroll={{x:1100}} columns={[
      {title:'姓名',dataIndex:'name',width:130},{title:'邮箱',dataIndex:'email',width:250},
      {title:'身份',dataIndex:'isSuperAdmin',width:130,render:value=><Tag color={value?'gold':'blue'}>{value?'最高管理员':'普通管理员'}</Tag>},
      {title:'可访问菜单',dataIndex:'sidebarPermissions',render:(views,row)=>row.isSuperAdmin?'全部菜单':(views||[]).map(view=>adminPermissionOptions.find(option=>option.value===view)?.label||view).join('、')},
      {title:'状态',dataIndex:'status',width:100,render:value=><Tag color={value==='active'?'green':'default'}>{value==='active'?'启用':'停用'}</Tag>},
      {title:'操作',width:250,render:(_,item)=><Space><Button type="link" onClick={()=>openEdit(item)}>编辑授权</Button><Button type="link" onClick={()=>reset(item)}>重置密码</Button><Popconfirm title={'删除 '+item.email+'？'} description="账户及登录会话将立即删除" onConfirm={()=>remove(item)} disabled={item.id===user.id}><Button type="link" danger disabled={item.id===user.id}>删除</Button></Popconfirm></Space>}
    ]}/></Card>
    <Drawer title={editing?'编辑管理员授权':'新增管理员'} open={open} onClose={()=>setOpen(false)} width={560} destroyOnClose={false}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="name" label="姓名" rules={[{required:true}]}><Input/></Form.Item>
        {!editing&&<Form.Item name="email" label="登录邮箱" rules={[{required:true,type:'email'}]}><Input/></Form.Item>}
        {!editing&&<Form.Item name="password" label="初始密码" rules={[{required:true,min:10}]}><Input.Password/></Form.Item>}
        {editing&&<Form.Item name="status" label="账户状态" rules={[{required:true}]}><Select options={[{value:'active',label:'启用'},{value:'disabled',label:'停用'}]} disabled={editing.id===user.id}/></Form.Item>}
        <Form.Item name="isSuperAdmin" label="最高管理员" valuePropName="checked"><Switch disabled={editing?.id===user.id} /></Form.Item>
        <Alert type="info" showIcon style={{marginBottom:16}} message={isSuper?'最高管理员可访问全部菜单，并可管理和删除其他管理员':'勾选普通管理员可以访问的侧边栏菜单；管理员账户仅最高管理员可访问'}/>
        <Form.Item name="sidebarPermissions" label="侧边栏访问权限" rules={[{type:'array',min:1,message:'请至少勾选一个菜单'}]}><Checkbox.Group options={adminPermissionOptions} disabled={Boolean(isSuper)} style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:10}}/></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>{editing?'保存授权':'创建账户'}</Button>
      </Form>
    </Drawer>
  </Space>;
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
        <Form.Item name="advertiser" label="广告主"><Input maxLength={200}/></Form.Item>
        <Form.Item name="bd" label="BD"><Input maxLength={200}/></Form.Item>
        <Form.Item name="sharePercent" label="上游结算比例（%）" rules={[{required:true}]}><InputNumber min={0} max={100} precision={2} style={{width:'100%'}}/></Form.Item>
        <Space><Button type="primary" htmlType="submit">保存上游配置</Button>{editingUp&&<Button onClick={()=>{setEditingUp(null);upForm.resetFields()}}>取消编辑</Button>}</Space>
      </Form><Table size="small" rowKey="id" dataSource={accounts} columns={[
        {title:'账户',dataIndex:'name'},{title:'REST 账户',dataIndex:'gamAccountName'},
        {title:'广告主',dataIndex:'advertiser'},{title:'BD',dataIndex:'bd'},
        {title:'比例',dataIndex:'sharePercent',render:v=>v+'%'},
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


export default function AdminPages({ view, user }) {
  if (view === 'channels') return <Channels/>;
  if (view === 'imports') return <DataImport/>;
  if (view === 'gam') return <GamAccounts/>;
  if (view === 'settlement') return <SettlementConfigEditor/>;
  if (view === 'ad-units') return <AdUnitBuilder/>;
  if (view === 'admins') return <AdminUsers user={user}/>;
  if (view === 'report-keys') return <ReportApiKeys/>;
  return <ApiDocs user={user}/>;
}
