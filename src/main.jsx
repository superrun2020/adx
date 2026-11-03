import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp, Alert, Button, Card, Col, DatePicker, Empty,
  Layout, Menu, Popconfirm, Row, Space, Statistic, Table,
  Tag, Typography, message
} from 'antd';
import {
  ApiOutlined, BarChartOutlined, DashboardOutlined, DollarOutlined, KeyOutlined,
  LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UserSwitchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import Reports from './ReportExplorer.jsx';
import AdminPages from './AdminPages.jsx';
import './styles.css';


const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const RevenueChart = React.lazy(() => import('./RevenueChart.jsx'));
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

function retryAssetLoad(error) {
  const detail = String(error?.message || error);
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|Failed to load module script|Loading chunk|ChunkLoadError|CSS_CHUNK_LOAD_FAILED/i.test(detail)) return false;
  try {
    if (sessionStorage.getItem('adx_route_retry_once')) return false;
    sessionStorage.setItem('adx_route_retry_once', '1');
  } catch { return false; }
  window.setTimeout(() => window.location.reload(), 300);
  return true;
}

class PageErrorBoundary extends React.Component {
  state = { error: null, recovering: false };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    console.error('page_render_failed', error);
    if (retryAssetLoad(error)) this.setState({ recovering: true });
  }
  render() {
    if (this.state.error) return <Card title={this.state.recovering ? '正在恢复页面…' : '页面暂时无法显示'}
      extra={<Button onClick={() => window.location.reload()}>重新加载</Button>}>
      <Alert type="warning" showIcon message={this.state.recovering ? '正在重新连接资源' : '请重新加载后继续使用'} />
    </Card>;
    return this.props.children;
  }
}

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    console.error('app_render_failed', error);
    this.props.onError(error);
    retryAssetLoad(error);
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

function MetricCards({ summary, admin }) {
  const pending = !summary;
  const items = [
    [admin?'总流水（收入）':'渠道结算收入', pending ? '—' : money(summary.revenue), <DollarOutlined />],
    ...(admin?[['渠道结算收益', pending ? '—' : money(summary.channelRevenue), <TeamOutlined />]]:[]),
    ['展示量', pending ? '—' : number(summary.impressions), <BarChartOutlined />],
    ['匹配率', pending ? '—' : Number(summary.matchRate || 0).toFixed(2) + '%', <SafetyOutlined />]
  ];
  return <Row gutter={[16, 16]}>{items.map(([title, value, icon]) => <Col xs={24} sm={12} xl={6} key={title}><Card className="metric"><Statistic title={title} value={value} prefix={icon} /></Card></Col>)}</Row>;
}

function Dashboard({ range, setRange, admin, initialDashboard }) {
  const rangeKey = range[0].format('YYYY-MM-DD') + ':' + range[1].format('YYYY-MM-DD');
  const [data, setData] = useState(initialDashboard?.key === rangeKey ? initialDashboard.data || null : null);
  const [loading, setLoading] = useState(false);
  const load = async (force = false) => {
    setLoading(true);
    try {
      let result;
      if (!force && initialDashboard?.key === rangeKey && !initialDashboard.used) {
        initialDashboard.used = true;
        const cached = await initialDashboard.promise;
        if (cached.error) throw cached.error;
        result = cached.data;
      } else {
        result = await api('/api/dashboard?start=' + range[0].format('YYYY-MM-DD') + '&end=' + range[1].format('YYYY-MM-DD'));
      }
      setData(result);
    } catch (e) { message.error(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [range[0].valueOf(), range[1].valueOf()]);
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>经营总览</Title><Text type="secondary">收入、流量质量与渠道结算一屏掌握</Text></div><Space><DatePicker.RangePicker value={range} onChange={v => v && setRange(v)} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>刷新</Button></Space></div>
    <MetricCards summary={data?.summary} admin={admin} />
    <Row gutter={[16, 16]}><Col xs={24} xl={16}><Card title="每日收益趋势" extra={data?.lastSync ? '最近同步 ' + data.lastSync : '尚未同步'}><div className="chart"><PageErrorBoundary><React.Suspense fallback={<div style={{padding:24,color:"#587184"}}>图表加载中…</div>}><RevenueChart data={data?.trend || []} formatMoney={money}/></React.Suspense></PageErrorBoundary></div></Card></Col><Col xs={24} xl={8}><Card title="收益最高的链接"><Table size="small" pagination={false} rowKey="url" dataSource={data?.topUrls || []} columns={[{ title: '链接', dataIndex: 'url', ellipsis: true }, { title: '收益', dataIndex: 'revenue', align: 'right', render: money }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}/></Card></Col></Row>
  </Space>;
}

function Shell({ user, onLogout, initialView = 'dashboard', initialDashboard, onReady }) {
  const [view,setView]=useState(initialView); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  const admin=user.role==='admin';
  useEffect(() => { onReady(); }, []);
  const menu=useMemo(()=>[
    {key:'dashboard',icon:<DashboardOutlined/>,label:'经营总览'},
    {key:'reports',icon:<BarChartOutlined/>,label:'数据报告'},
    ...(admin?[{type:'group',label:'平台管理',children:[{key:'channels',icon:<TeamOutlined/>,label:'渠道管理'},{key:'gam',icon:<SafetyOutlined/>,label:'Ad Manager REST'},{key:'settlement',icon:<DollarOutlined/>,label:'结算配置'},{key:'ad-units',icon:<PlusOutlined/>,label:'广告单元创建'},{key:'admins',icon:<UserSwitchOutlined/>,label:'管理员账户'},{key:'report-keys',icon:<KeyOutlined/>,label:'账户日报 API Key'}]}]:[]),
    {type:'group',label:'开发能力',children:[{key:'api',icon:<ApiOutlined/>,label:'渠道 API'}]}
  ],[admin]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin} initialDashboard={initialDashboard}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin}/>:<AdminPages view={view} user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={238}><div className="side-brand"><span>AX</span>{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key})=>setView(key)}/></Sider><Layout><Header><div><Text strong>{user.name||user.email}</Text><Tag color={admin?'blue':'cyan'}>{admin?'平台管理员':'渠道账号'}</Tag></div><Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm></Header><Content><PageErrorBoundary key={view}><React.Suspense fallback={<Card loading style={{minHeight:220}}>正在加载页面…</Card>}>{body}</React.Suspense></PageErrorBoundary></Content></Layout></Layout>;
}

function Root({ initialUser, initialView, initialDashboard, onReady }) {
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  };
  return <Shell user={initialUser} onLogout={logout} initialView={initialView} initialDashboard={initialDashboard} onReady={onReady} />;
}

export function mountApp(initialUser, initialView, initialDashboard) {
  const fallback = document.getElementById('root');
  const appRoot = document.getElementById('app-root');
  const onReady = () => { appRoot.hidden = false; fallback.hidden = true; };
  const onError = () => {
    appRoot.hidden = true;
    fallback.hidden = false;
    const error = document.getElementById('quick-error');
    error.firstChild.textContent = '后台页面加载失败，请刷新重试。';
    error.hidden = false;
  };
  createRoot(appRoot).render(<AppErrorBoundary onError={onError}><AntApp><Root initialUser={initialUser} initialView={initialView} initialDashboard={initialDashboard} onReady={onReady}/></AntApp></AppErrorBoundary>);
}
