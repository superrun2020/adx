import useLocale from './useLocale.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  App as AntApp, Alert, Avatar, Button, Card, Col, ConfigProvider, Empty,
  Layout, Menu, Popconfirm, Row, Select, Space, Statistic, Tag, Typography, message
} from 'antd';
import Table from './FitTable.jsx';
import {
  ApiOutlined, BarChartOutlined, DashboardOutlined, DollarOutlined, FileProtectOutlined, KeyOutlined,
  LinkOutlined, LogoutOutlined, PlusOutlined, ReloadOutlined, SafetyOutlined, TeamOutlined,
  UserSwitchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { getLocale } from './i18n.js';
import { clearCachedUser, readCached, rememberRead } from './readCache.js';
import { sessionFetch } from './sessionFetch.js';
import { previewPagePath } from './channelPreview.js';
import { canVisit, shouldNavigateInPlace, viewForPath, viewPaths } from './navigation.js';
import ReportDateFilter from './ReportDateFilter.jsx';
import RevenueChart from './RevenueChart.jsx';
import NumericSortHeader from './NumericSortHeader.jsx';
import './styles.css';
import './enterprise.css';
import { enterpriseTheme } from './enterpriseTheme.js';


const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const Reports = React.lazy(() => import('./ReportExplorer.jsx'));
const AdminPages = React.lazy(() => import('./AdminPages.jsx'));
const LinkManager = React.lazy(() => import('./LinkManager.jsx'));
const RegressionMonitor = React.lazy(() => import('./RegressionMonitor.jsx'));
const BotReport = React.lazy(() => import('./BotReport.jsx'));
const ChannelRegistration = React.lazy(() => import('./ChannelRegistration.jsx'));
const ChannelPortalPage = React.lazy(() => import('./ChannelPortalPage.jsx'));
async function api(path, options = {}) {
  const response = await sessionFetch(path, {
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
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|Failed to load module script|Loading chunk|ChunkLoadError|CSS_CHUNK_LOAD_FAILED|Unable to preload CSS/i.test(detail)) return false;
  try {
    const key = 'adx_route_retry_bundle';
    if (sessionStorage.getItem(key) === import.meta.url) return false;
    sessionStorage.setItem(key, import.meta.url);
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
  const clickRate = pending ? '—' : Number(summary.impressions) > 0
    ? (Number(summary.clicks || 0) * 100 / Number(summary.impressions)).toFixed(2) + '%'
    : '0.00%';
  const items = [
    [admin?'原始流水':'渠道结算收入', pending ? '—' : money(summary.revenue), <DollarOutlined />],
    ...(admin?[
      ['上游应结算金额', summary?.upstreamSettlement == null ? '—' : money(summary.upstreamSettlement), <DollarOutlined />],
      ['平台留存金额', summary?.platformProfit == null ? '—' : money(summary.platformProfit), <DollarOutlined />],
      ['渠道结算金额', pending ? '—' : money(summary.channelRevenue), <TeamOutlined />]
    ]:[]),
    ['展示量', pending ? '—' : number(summary.impressions), <BarChartOutlined />],
    ['匹配率', pending ? '—' : Number(summary.matchRate || 0).toFixed(2) + '%', <SafetyOutlined />],
    ['点击率', clickRate, <BarChartOutlined />]
  ];
  return <Row gutter={[16, 16]}>{items.map(([title, value, icon]) => <Col xs={24} sm={12} xl={admin&&['展示量','匹配率','点击率'].includes(title)?8:6} key={title}><Card className="metric"><Statistic title={title} value={value} prefix={icon} /></Card></Col>)}</Row>;
}

function DashboardTopLinks({ user, refreshKey }) {
  const path = '/api/dashboard/highlights';
  const [data, setData] = useState(() => readCached(user, path)?.data || null);
  const [sorts, setSorts] = useState({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let request;
    const load = () => {
      const cached = readCached(user, path);
      if (cached) setData(cached.data);
      if (cached && Date.now() - cached.savedAt < 10000 && refreshKey === 0) {
        setLoading(false);
        return;
      }
      request?.abort();
      const controller = new AbortController();
      request = controller;
      setLoading(true);
      api(path, {signal:controller.signal}).then(result => {
        if (controller.signal.aborted) return;
        rememberRead(user, path, result);
        setData(result);
      }).catch(error => { if (!controller.signal.aborted) message.error('收益榜加载失败：' + error.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    };
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 15 * 60 * 1000);
    return () => { request?.abort(); window.clearInterval(timer); };
  }, [user.id, refreshKey]);
  const columnsFor = period => [
    { title:'排名', width:64, render:(_, row) => <span className={'rank-badge rank-' + row.rank}>{row.rank}</span> },
    { title:'链接', dataIndex:'url', ellipsis:true, render:value => <strong className="rank-url" title={value}>{value || '—'}</strong> },
    { title:<NumericSortHeader label="展示" direction={sorts[period]?.key === 'impressions' ? sorts[period].direction : ''}
      onSort={direction => setSorts(previous => ({ ...previous, [period]: { key:'impressions', direction } }))}/>,
      dataIndex:'impressions', align:'right', className:'numeric-sort-column', width:110, render:number },
    { title:<NumericSortHeader label="收益" direction={sorts[period]?.key === 'revenue' ? sorts[period].direction : ''}
      onSort={direction => setSorts(previous => ({ ...previous, [period]: { key:'revenue', direction } }))}/>,
      dataIndex:'revenue', align:'right', className:'numeric-sort-column', width:120, render:value => <strong>{money(value)}</strong> }
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
      {[['当日链接收益 Top 10', 'daily', data?.daily], ['当月链接收益 Top 10', 'monthly', data?.monthly]].map(([title, period, rows]) => <Col xs={24} xl={12} key={title}><Card className="highlight-ranking" title={title} extra="USD"><Table size="small" rowKey="url" pagination={false} columns={columnsFor(period)} dataSource={sortedRows(period, rows)} loading={loading && !data} scroll={{x:520}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已同步数据"/>}}/></Card></Col>)}
    </Row>
  </Space>;
}

function MatchBreakdown({ summary, formatCount, formatPercent }) {
  const requests = Number(summary?.requests);
  const matched = Number(summary?.matched);
  if (!(requests > 0) || !Number.isFinite(matched) || matched < 0 || matched > requests) {
    return <div className="revenue-empty">所选区间暂无请求构成数据</div>;
  }

  const share = matched / requests;
  return <div className="dashboard-breakdown" data-chart-type="donut">
    <div className="dashboard-donut" style={{'--match-share': formatPercent(share)}} aria-hidden="true">
      <div className="dashboard-donut-center"><strong>{formatPercent(share)}</strong><span>匹配率</span></div>
    </div>
    <dl className="dashboard-breakdown-legend">
      <div><dt><i className="dashboard-dot" aria-hidden="true"/>已匹配请求</dt><dd>{formatCount(matched)} <span>{formatPercent(share)}</span></dd></div>
      <div><dt><i className="dashboard-dot is-unmatched" aria-hidden="true"/>未匹配请求</dt><dd>{formatCount(requests - matched)} <span>{formatPercent(1 - share)}</span></dd></div>
      <div><dt>总请求量</dt><dd>{formatCount(requests)}</dd></div>
    </dl>
  </div>;
}

function DashboardCharts({ data, admin }) {
  const [barMetric, setBarMetric] = useState('matchRate');
  const locale = useLocale();
  const countFormatter = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {maximumFractionDigits:0});
  const formatCount = value => countFormatter.format(value);
  const formatPercent = value => (value * 100).toFixed(2) + '%';
  const barOptions = [
    {value:'matchRate',label:'匹配率',format:value => formatPercent(value / 100)},
    {value:'requests',label:'请求量',format:formatCount},
    {value:'impressions',label:'展示量',format:formatCount},
    {value:'clicks',label:'点击量',format:formatCount},
    {value:'clickRate',label:'点击率',format:value => formatPercent(value / 100)},
    {value:'ecpm',label:'eCPM',format:money}
  ];
  const selectedMetric = barOptions.find(option => option.value === barMetric) || barOptions[0];
  const revenueLabel = admin ? '原始流水' : '渠道结算收入';
  return <Space direction="vertical" size={16} className="dashboard-charts">
    <Card title="每日收入趋势" extra={<Text type="secondary">{revenueLabel}</Text>}>
      <div className="chart"><RevenueChart data={data?.trend} formatMoney={money} label={revenueLabel} color="#3159b8"/></div>
    </Card>
    <Row gutter={[16,16]}>
      <Col xs={24} xl={13}><Card title="每日指标对比" extra={<Select aria-label="柱状图指标" value={barMetric}
        onChange={setBarMetric} options={barOptions} style={{minWidth:115}}/>}>
        <div className="chart"><RevenueChart data={data?.trend} type="bar" metric={selectedMetric.value} formatMoney={selectedMetric.format}
          label={selectedMetric.label} color="#358c9d"/></div>
      </Card></Col>
      <Col xs={24} xl={11}><Card title="请求匹配分布">
        <div className="chart"><MatchBreakdown summary={data?.summary} formatCount={formatCount} formatPercent={formatPercent}/></div>
      </Card></Col>
    </Row>
    <div className="dashboard-chart-notes">
      <Text type="secondary">图表跟随顶部日期筛选；匹配率＝匹配请求 ÷ 请求量，点击率＝点击量 ÷ 展示量。eCPM 按当前可见收入计算，每千次展示的收入以 USD 计。缺失日期不补零；当天数据尚未完整。</Text>
      <Text type="secondary">{data?.lastSync ? '最近同步 ' + data.lastSync : '尚未同步'}</Text>
    </div>
  </Space>;
}

function Dashboard({ range, setRange, admin, user, initialDashboard }) {
  const rangeKey = range[0].format('YYYY-MM-DD') + ':' + range[1].format('YYYY-MM-DD');
  const path = '/api/dashboard?start=' + range[0].format('YYYY-MM-DD') + '&end=' + range[1].format('YYYY-MM-DD') + '&source=rest';
  const saved = readCached(user, path);
  const [data, setData] = useState(saved?.data || null);
  const [dataKey, setDataKey] = useState(rangeKey);
  const currentData = dataKey === rangeKey ? data : saved?.data || null;
  const [showingCached, setShowingCached] = useState(Boolean(saved));
  const [loading, setLoading] = useState(false);
  const [highlightRefresh, setHighlightRefresh] = useState(0);
  const request = useRef(null);
  const load = async (force = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      let result;
      if (!force && initialDashboard?.key === rangeKey && !initialDashboard.used) {
        initialDashboard.used = true;
        const cached = await initialDashboard.promise;
        if (cached.error) throw cached.error;
        result = cached.data;
      } else {
        result = await api(path, {signal:controller.signal});
      }
      if (!controller.signal.aborted) { rememberRead(user, path, result); setData(result); setDataKey(rangeKey); setShowingCached(false); }
    } catch (e) { if (!controller.signal.aborted) message.error(e.message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    const latest = readCached(user, path);
    setData(latest?.data || null);
    setDataKey(rangeKey);
    setShowingCached(Boolean(latest));
    load();
    const timer = admin || user.readOnlyPreview ? null : window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15 * 60 * 1000);
    return () => { request.current?.abort(); window.clearInterval(timer); };
  }, [range[0].valueOf(), range[1].valueOf()]);
  return <Space direction="vertical" size={16} className="page-stack report-dashboard">
    <div className="page-heading"><div><Title level={2}>经营总览</Title><Text type="secondary">收入、流量质量与渠道结算一屏掌握</Text>{showingCached && <Tag color="gold" style={{marginLeft:10}}>{loading ? '已显示缓存，正在更新' : '已显示缓存数据'}</Tag>}</div><Space wrap><ReportDateFilter value={range} onChange={setRange}/><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { load(true); setHighlightRefresh(value => value + 1); }}>刷新</Button></Space></div>
    <Text type="secondary">所选区间：{range[0].format('YYYY-MM-DD')} 至 {range[1].format('YYYY-MM-DD')}</Text>
    <MetricCards summary={currentData?.summary} admin={admin} />
    {admin && <Text type="secondary">对账链路：原始流水 → 上游应结算 → 平台留存（上游应结算减渠道结算）→ 渠道结算。结算金额按配置计算，不代表实际到账。</Text>}
    <DashboardTopLinks user={user} refreshKey={highlightRefresh}/>
    <PageErrorBoundary><DashboardCharts data={currentData} admin={admin}/></PageErrorBoundary>
  </Space>;
}

function Shell({ user, onLogout, initialView = 'dashboard', initialDashboard, onReady }) {
  const admin=user.role==='admin';
  const [view,setView]=useState(() => viewForPath(window.location.pathname, initialView, user)); const [collapsed,setCollapsed]=useState(false); const [range,setRange]=useState([dayjs().startOf('month'),dayjs()]);
  useEffect(() => { onReady(); }, []);
  useEffect(() => {
    if (window.location.pathname !== viewPaths[view]) window.history.replaceState({ view }, '', previewPagePath(viewPaths[view]));
  }, [view]);
  useEffect(() => {
    const onPopState = () => {
      const next = viewForPath(window.location.pathname, 'dashboard', user);
      if (window.location.pathname !== viewPaths[next]) window.history.replaceState({ view: next }, '', previewPagePath(viewPaths[next]));
      setView(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [user]);
  const navigate = key => {
    if (!canVisit(user, key)) return;
    const path = viewPaths[key] || '/';
    if (window.location.pathname !== path) window.history.pushState({ view: key }, '', previewPagePath(path));
    setView(key);
  };
  const sidebarItem = (key, icon, title) => ({ key, title,
    icon: <a className="sidebar-icon-link" href={previewPagePath(viewPaths[key])} tabIndex={-1} aria-hidden="true">{icon}</a>,
    label: <a className="sidebar-route-link" href={previewPagePath(viewPaths[key])}>{title}</a> });
  const menu=useMemo(()=>[
    {type:'group',label:'业务管理',children:[
      sidebarItem('dashboard',<DashboardOutlined/>,'经营总览'),
      ...(admin?[sidebarItem('gam',<SafetyOutlined/>,'账号管理'),sidebarItem('links',<LinkOutlined/>,'链接管理'),sidebarItem('ad-units',<PlusOutlined/>,'广告单元创建')]:[]),
      sidebarItem('reports',<BarChartOutlined/>,'数据报告'),
      ...(admin?[sidebarItem('regression',<ReloadOutlined/>,'数据回退监测'),
        sidebarItem('bot-report',<ApiOutlined/>,'机器人汇报')]:[
        sidebarItem('channel-regression',<ReloadOutlined/>,'数据回退'),
        sidebarItem('channel-links',<LinkOutlined/>,'我的链接'),
        sidebarItem('channel-contract',<FileProtectOutlined/>,'合同管理')])
    ]},
    ...(admin?[{type:'group',label:'平台管理',children:[sidebarItem('channels',<TeamOutlined/>,'渠道管理'),sidebarItem('settlement',<DollarOutlined/>,'结算配置'),sidebarItem('admins',<UserSwitchOutlined/>,'管理员账户'),sidebarItem('report-keys',<KeyOutlined/>,'账户日报 API Key')]}]:[]),
    {type:'group',label:'开发能力',children:[sidebarItem('api',<ApiOutlined/>,'渠道 API')]}
  ].map(group=>({...group,children:group.children.filter(item=>canVisit(user,item.key))})).filter(group=>group.children.length),[user]);
  const body=view==='dashboard'?<Dashboard range={range} setRange={setRange} admin={admin} user={user} initialDashboard={initialDashboard}/>:view==='reports'?<Reports range={range} setRange={setRange} admin={admin} user={user}/>:view==='links'?<LinkManager key={user?.id} user={user}/>:view==='regression'?<RegressionMonitor/>:view==='channel-regression'?<RegressionMonitor channelMode/>:view==='channel-links'||view==='channel-contract'?<ChannelPortalPage view={view} user={user}/>:view==='bot-report'?<BotReport/>:<AdminPages view={view} user={user}/>;
  return <Layout className="app-shell"><Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={248}><div className="side-brand"><img src="/google-g.png" alt="Google" />{!collapsed&&<div><b>{admin?'AdX Control':'AdX Publisher'}</b><small>{admin?'平台管理端':'渠道工作台'}</small></div>}</div><Menu theme="dark" mode="inline" selectedKeys={[view]} items={menu} onClick={({key,domEvent})=>{if(!shouldNavigateInPlace(domEvent))return;domEvent?.preventDefault();navigate(key);}}/><div className={'sidebar-profile'+(collapsed?' sidebar-profile-collapsed':'')} title={user.name||user.email}>
      <Avatar size={36} className="sidebar-avatar">{Array.from(user.name||user.email||'?')[0].toUpperCase()}</Avatar>
      {!collapsed&&<div className="sidebar-profile-text"><strong>{user.name||user.email}</strong><span>{user.isSuperAdmin?'最高管理员':admin?'平台管理员':user.status==='pending'?'待完成签约':'渠道账号'}</span></div>}
    </div></Sider><Layout><Header><div className="workspace-location"><span>{admin?'运营工作台':'渠道工作台'}</span><i aria-hidden="true">/</i><strong>{menu.flatMap(group=>group.children).find(item=>item.key===view)?.title}</strong></div><div className="header-actions"><LanguageSwitcher/>{user.readOnlyPreview ? <Button href="/channels">返回渠道管理</Button> : <Popconfirm title="确认退出登录？" onConfirm={onLogout}><Button icon={<LogoutOutlined/>}>退出</Button></Popconfirm>}</div></Header><Content>{user.readOnlyPreview && <Alert type="info" showIcon style={{marginBottom:16}} message={<><span>渠道后台只读预览</span> · {user.companyName || user.name} · {user.email}</>}/>}<PageErrorBoundary key={view}><React.Suspense fallback={<Card className="route-loading">正在加载页面…</Card>}>{body}</React.Suspense></PageErrorBoundary></Content></Layout></Layout>;
}

function Root({ initialUser, initialView, initialDashboard, onReady }) {
  const locale = useLocale();
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearCachedUser(initialUser);
    window.location.reload();
  };
  return <ConfigProvider theme={enterpriseTheme} locale={locale === 'en' ? enUS : zhCN}><Shell user={initialUser} onLogout={logout} initialView={initialView} initialDashboard={initialDashboard} onReady={onReady} /></ConfigProvider>;
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
