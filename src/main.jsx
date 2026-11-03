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
const loadReports = () => import('./ReportExplorer.jsx');
const loadAdminPages = () => import('./AdminPages.jsx');
const Reports = React.lazy(loadReports);
const AdminPages = React.lazy(loadAdminPages);
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

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('app_render_failed', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div style={{ minHeight: '100vh', padding: '10vh 8vw', background: '#f4f7f9', color: '#172b3a' }}>
      <h1>工作区加载失败</h1><p>网络可能中断，刷新后可继续使用。</p>
      <button type="button" onClick={() => window.location.reload()}>重新加载</button>
    </div>;
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

function Shell({ user, onLogout, initialView = 'dashboard' }) {
  const [view,setView]=useState(initialView); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  const admin=user.role==='admin';
  useEffect(() => {
    const preload = () => { loadReports().catch(() => {}); if (admin) loadAdminPages().catch(() => {}); };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 1000);
    return () => window.clearTimeout(id);
  }, [admin]);
  const menu=useMemo(()=>[
    {key:'dashboard',icon:<DashboardOutlined/>,label:'经营总览'},
    {key:'reports',icon:<BarChartOutlined/>,label:'数据报告'},
    ...(admin?[{type:'group',label:'平台管理',children:[{key:'channels',icon:<TeamOutlined/>,label:'渠道管理'},{key:'gam',icon:<SafetyOutlined/>,label:'Ad Manager REST'},{key:'settlement',icon:<DollarOutlined/>,label:'结算配置'},{key:'ad-units',icon:<PlusOutlined/>,label:'广告单元创建'},{key:'admins',icon:<UserSwitchOutlined/>,label:'管理员账户'},{key:'report-keys',icon:<KeyOutlined/>,label:'账户日报 API Key'}]}]:[]),
    {type:'group',label:'开发能力',children:[{key:'api',icon:<ApiOutlined/>,label:'渠道 API'}]}
  ],[admin]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin}/>:<AdminPages view={view} user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={238}><div className="side-brand"><span>AX</span>{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key})=>setView(key)}/></Sider><Layout><Header><div><Text strong>{user.name||user.email}</Text><Tag color={admin?'blue':'cyan'}>{admin?'平台管理员':'渠道账号'}</Tag></div><Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm></Header><Content><PageErrorBoundary key={view}><React.Suspense fallback={<Card loading style={{minHeight:220}}>正在加载页面…</Card>}>{body}</React.Suspense></PageErrorBoundary></Content></Layout></Layout>;
}

function Root({ initialUser, initialView }) {
  const [user,setUser]=useState(initialUser || null); const [ready,setReady]=useState(Boolean(initialUser));
  useEffect(()=>{if(initialUser)return;api('/api/auth/me').then(r=>setUser(r.user)).catch(()=>{}).finally(()=>setReady(true))},[initialUser]);
  const logout=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});setUser(null)};
  if(!ready)return <div className="boot">正在加载安全工作区…</div>;
  return user?<Shell user={user} onLogout={logout} initialView={initialView}/>:<Login onLogin={setUser}/>;
}

export function mountApp(initialUser, initialView) {
  createRoot(document.getElementById('root')).render(<AppErrorBoundary><AntApp><Root initialUser={initialUser} initialView={initialView}/></AntApp></AppErrorBoundary>);
}
