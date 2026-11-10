import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp, Alert, Button, Card, Col, Empty,
  Layout, Menu, Popconfirm, Row, Space, Statistic, Table,
  Tag, Typography, message
} from 'antd';
import {
  ApiOutlined, BarChartOutlined, DashboardOutlined, DollarOutlined, KeyOutlined,
  LinkOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UserSwitchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { clearCachedUser, readCached, rememberRead } from './readCache.js';
import { canVisit, viewForPath, viewPaths } from './navigation.js';
import ReportDateFilter from './ReportDateFilter.jsx';
import RevenueChart from './RevenueChart.jsx';
import NumericSortHeader from './NumericSortHeader.jsx';
import './styles.css';


const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const Reports = React.lazy(() => import('./ReportExplorer.jsx'));
const AdminPages = React.lazy(() => import('./AdminPages.jsx'));
const LinkManager = React.lazy(() => import('./LinkManager.jsx'));
const RegressionMonitor = React.lazy(() => import('./RegressionMonitor.jsx'));
const BotReport = React.lazy(() => import('./BotReport.jsx'));
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

function DashboardTopLinks({ user, refreshKey }) {
  const path = '/api/dashboard/highlights';
  const [data, setData] = useState(() => readCached(user, path)?.data || null);
  const [sorts, setSorts] = useState({});
  useEffect(() => {
    let active = true;
    const load = () => {
      const cached = readCached(user, path);
      if (cached && active) setData(cached.data);
      if (cached && Date.now() - cached.savedAt < 10000 && refreshKey === 0) return;
      api(path).then(result => {
        rememberRead(user, path, result);
        if (active) setData(result);
      }).catch(error => { if (active) message.error('收益榜加载失败：' + error.message); });
    };
    load();
    const timer = window.setInterval(load, 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [user.id, refreshKey]);
  const columnsFor = period => [
    { title:'排名', width:64, render:(_, row) => <span className={'rank-badge rank-' + row.rank}>{row.rank}</span> },
    { title:'链接', dataIndex:'url', ellipsis:true, render:value => <strong className="rank-url" title={value}>{value || '—'}</strong> },
    { title:<NumericSortHeader label="展示" direction={sorts[period]?.key === 'impressions' ? sorts[period].direction : ''}
      onSort={direction => setSorts(previous => ({ ...previous, [period]: { key:'impressions', direction } }))}/>,
      dataIndex:'impressions', align:'right', width:110, render:number },
    { title:<NumericSortHeader label="收益" direction={sorts[period]?.key === 'revenue' ? sorts[period].direction : ''}
      onSort={direction => setSorts(previous => ({ ...previous, [period]: { key:'revenue', direction } }))}/>,
      dataIndex:'revenue', align:'right', width:120, render:value => <strong>{money(value)}</strong> }
  ];
  const sortedRows = (period, rows) => {
    const ranked = (rows || []).map((row, index) => ({ ...row, rank:index + 1 }));
    const sort = sorts[period];
    return sort ? ranked.sort((a,b) => {
      const delta = (Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0);
      return (sort.direction === 'asc' ? delta : -delta) || a.rank - b.rank;
    }) : ranked;
  };
  return <Space direction="vertical" size={8} style={{width:'100%'}}>
    <Text type="secondary">当日、当月按各 Ad Manager 账号时区计算，仅统计 REST 同步数据。</Text>
    {data?.timeZoneWarnings?.length > 0 && <Alert type="warning" showIcon message={'以下账号未配置有效时区，暂按 UTC 计算：' + data.timeZoneWarnings.join('、')}/>}
    <Row gutter={[16,16]}>
      {[['当日链接收益 Top 10', 'daily', data?.daily], ['当月链接收益 Top 10', 'monthly', data?.monthly]].map(([title, period, rows]) => <Col xs={24} xl={12} key={title}><Card className="highlight-ranking" title={title} extra="USD"><Table size="small" rowKey="url" pagination={false} columns={columnsFor(period)} dataSource={sortedRows(period, rows)} scroll={{x:520}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已同步数据"/>}}/></Card></Col>)}
    </Row>
  </Space>;
}

function Dashboard({ range, setRange, admin, user, initialDashboard }) {
  const rangeKey = range[0].format('YYYY-MM-DD') + ':' + range[1].format('YYYY-MM-DD');
  const path = '/api/dashboard?start=' + range[0].format('YYYY-MM-DD') + '&end=' + range[1].format('YYYY-MM-DD') + '&source=rest';
  const saved = readCached(user, path);
  const freshInitial = initialDashboard?.key === rangeKey && initialDashboard.fresh;
  const [data, setData] = useState(initialDashboard?.key === rangeKey ? initialDashboard.data || saved?.data || null : saved?.data || null);
  const [dataKey, setDataKey] = useState(rangeKey);
  const currentData = dataKey === rangeKey ? data : saved?.data || null;
  const [showingCached, setShowingCached] = useState(Boolean(saved && !freshInitial));
  const [loading, setLoading] = useState(false);
  const [highlightRefresh, setHighlightRefresh] = useState(0);
  const requestId = useRef(0);
  const load = async (force = false) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      let result;
      if (!force && initialDashboard?.key === rangeKey && !initialDashboard.used) {
        initialDashboard.used = true;
        const cached = await initialDashboard.promise;
        if (cached.error) throw cached.error;
        result = cached.data;
      } else {
        result = await api(path);
      }
      rememberRead(user, path, result);
      if (id === requestId.current) { setData(result); setDataKey(rangeKey); setShowingCached(false); }
    } catch (e) { if (id === requestId.current) message.error(e.message); }
    finally { if (id === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    const latest = readCached(user, path);
    const initial = initialDashboard?.key === rangeKey ? initialDashboard.data : null;
    setData(initial || latest?.data || null);
    setDataKey(rangeKey);
    setShowingCached(Boolean(latest && !freshInitial));
    load();
    return () => { requestId.current += 1; };
  }, [range[0].valueOf(), range[1].valueOf()]);
  return <Space direction="vertical" size={16} className="page-stack report-dashboard">
    <div className="page-heading"><div><Title level={2}>经营总览</Title><Text type="secondary">收入、流量质量与渠道结算一屏掌握</Text>{showingCached && <Tag color="gold" style={{marginLeft:10}}>{loading ? '已显示缓存，正在更新' : '已显示缓存数据'}</Tag>}</div><Space wrap><ReportDateFilter value={range} onChange={setRange}/><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { load(true); setHighlightRefresh(value => value + 1); }}>刷新</Button></Space></div>
    <Text type="secondary">所选区间：{range[0].format('YYYY-MM-DD')} 至 {range[1].format('YYYY-MM-DD')}</Text>
    <MetricCards summary={currentData?.summary} admin={admin} />
    <DashboardTopLinks user={user} refreshKey={highlightRefresh}/>
    <Card title="所选区间每日收益趋势" extra={currentData?.lastSync ? '最近同步 ' + currentData.lastSync : '尚未同步'}><div className="chart"><PageErrorBoundary><RevenueChart data={currentData?.trend || []} formatMoney={money}/></PageErrorBoundary></div></Card>
  </Space>;
}

function Shell({ user, onLogout, initialView = 'dashboard', initialDashboard, onReady }) {
  const admin=user.role==='admin';
  const [view,setView]=useState(() => viewForPath(window.location.pathname, initialView, user)); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  useEffect(() => { onReady(); }, []);
  useEffect(() => {
    if (window.location.pathname !== viewPaths[view]) window.history.replaceState({ view }, '', viewPaths[view]);
  }, [view]);
  useEffect(() => {
    const onPopState = () => {
      const requested = viewForPath(window.location.pathname, 'dashboard', 'admin');
      const next = viewForPath(window.location.pathname, 'dashboard', user);
      if (requested !== next) window.history.replaceState({ view: next }, '', viewPaths[next]);
      setView(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [user]);
  const navigate = key => {
    if (!canVisit(user, key)) return;
    const path = viewPaths[key] || '/';
    if (window.location.pathname !== path) window.history.pushState({ view: key }, '', path);
    setView(key);
  };
  const menu=useMemo(()=>[
    {type:'group',label:'业务管理',children:[
      {key:'dashboard',icon:<DashboardOutlined/>,label:'经营总览'},
      ...(admin?[{key:'gam',icon:<SafetyOutlined/>,label:'账号管理'},{key:'links',icon:<LinkOutlined/>,label:'链接管理'},{key:'ad-units',icon:<PlusOutlined/>,label:'广告单元创建'}]:[]),
      {key:'reports',icon:<BarChartOutlined/>,label:'数据报告'},
      ...(admin?[{key:'regression',icon:<ReloadOutlined/>,label:'数据回退监测'},
        {key:'bot-report',icon:<ApiOutlined/>,label:'机器人汇报'}]:[])
    ]},
    ...(admin?[{type:'group',label:'平台管理',children:[{key:'channels',icon:<TeamOutlined/>,label:'渠道管理'},{key:'settlement',icon:<DollarOutlined/>,label:'结算配置'},{key:'admins',icon:<UserSwitchOutlined/>,label:'管理员账户'},{key:'report-keys',icon:<KeyOutlined/>,label:'账户日报 API Key'}]}]:[]),
    {type:'group',label:'开发能力',children:[{key:'api',icon:<ApiOutlined/>,label:'渠道 API'}]}
  ].map(group=>({...group,children:group.children.filter(item=>canVisit(user,item.key))})).filter(group=>group.children.length),[user]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin} user={user} initialDashboard={initialDashboard}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin} user={user}/>:view==='links'?<LinkManager/>:view==='regression'?<RegressionMonitor/>:view==='bot-report'?<BotReport/>:<AdminPages view={view} user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={238}><div className="side-brand"><span>AX</span>{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key})=>navigate(key)}/></Sider><Layout><Header><div><Text strong>{user.name||user.email}</Text><Tag color={admin?'blue':'cyan'}>{user.isSuperAdmin?'最高管理员':admin?'平台管理员':'渠道账号'}</Tag></div><Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm></Header><Content><PageErrorBoundary key={view}><React.Suspense fallback={<Card className="route-loading">正在加载页面…</Card>}>{body}</React.Suspense></PageErrorBoundary></Content></Layout></Layout>;
}

function Root({ initialUser, initialView, initialDashboard, onReady }) {
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearCachedUser(initialUser);
    window.location.reload();
  };
  return <Shell user={initialUser} onLogout={logout} initialView={initialView} initialDashboard={initialDashboard} onReady={onReady} />;
}

let appRootInstance;
export function mountApp(initialUser, initialView, initialDashboard) {
  const loginRoot = document.getElementById('root');
  const appRoot = document.getElementById('app-root');
  return new Promise((resolve, reject) => {
    const onReady = () => {
      appRoot.hidden = false;
      loginRoot.hidden = true;
      resolve();
    };
    const onError = error => {
      appRoot.hidden = true;
      loginRoot.hidden = false;
      document.getElementById('boot-status').textContent = '后台页面加载失败，请刷新重试。';
      document.getElementById('boot-retry').hidden = false;
      reject(error);
    };
    if (!appRootInstance) appRootInstance = createRoot(appRoot);
    appRootInstance.render(<AppErrorBoundary onError={onError}><AntApp><Root initialUser={initialUser} initialView={initialView} initialDashboard={initialDashboard} onReady={onReady}/></AntApp></AppErrorBoundary>);
  });
}
