const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button[type="submit"]');
const retryButton = document.getElementById('boot-retry');
const loginPage = document.querySelector('.boot-page');
const workspace = document.getElementById('boot-workspace');
const quickError = document.getElementById('quick-error');
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道收益与流量数据工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '使用平台分配的渠道账号登录，查看本渠道数据。';
}

let mounted = false;
let opening = false;
let submitted = false;
let appPromise;
let currentView = 'dashboard';
const retryKey = 'adx_asset_retry_once';
const pageTitles = { dashboard: '经营总览', reports: '数据报告', channels: '渠道管理', gam: 'Ad Manager REST', settlement: '结算配置', 'ad-units': '广告单元创建', admins: '管理员账户', 'report-keys': '账户日报 API Key', api: '渠道 API' };
const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = value => Number(value || 0).toLocaleString('zh-CN');
const dateText = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const today = new Date();
const start = dateText(new Date(today.getFullYear(), today.getMonth(), 1));
const end = dateText(today);
const dashboardKey = start + ':' + end;

function loadApp() {
  // Login and session checks do not depend on the React bundle or other pages.
  if (!appPromise) appPromise = import('./main.jsx').catch(error => {
    appPromise = null;
    throw error;
  });
  return appPromise;
}

function retryAutomatically() {
  try {
    if (sessionStorage.getItem(retryKey)) return false;
    sessionStorage.setItem(retryKey, '1');
  } catch { return false; }
  window.setTimeout(() => window.location.reload(), 400);
  return true;
}

function showError(text) {
  quickError.firstChild.textContent = text;
  quickError.hidden = false;
}

function renderDashboard(data) {
  const summary = data.summary || {};
  document.getElementById('quick-revenue').textContent = money(summary.revenue);
  document.getElementById('quick-channel-revenue').textContent = money(summary.channelRevenue);
  document.getElementById('quick-impressions').textContent = number(summary.impressions);
  document.getElementById('quick-match-rate').textContent = Number(summary.matchRate || 0).toFixed(2) + '%';
  const chart = document.getElementById('quick-chart');
  chart.replaceChildren();
  const trend = Array.isArray(data.trend) ? data.trend : [];
  const max = Math.max(1, ...trend.map(row => Number(row.revenue) || 0));
  if (!trend.length) chart.textContent = '暂无趋势数据';
  for (const row of trend) {
    const bar = document.createElement('span');
    bar.style.height = Math.max(2, Math.round((Number(row.revenue) || 0) / max * 220)) + 'px';
    bar.title = (row.date || '') + '  ' + money(row.revenue);
    chart.append(bar);
  }
  const urls = document.getElementById('quick-top-urls');
  urls.replaceChildren();
  const rows = Array.isArray(data.topUrls) ? data.topUrls : [];
  if (!rows.length) urls.textContent = '暂无链接数据';
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'quick-top-row';
    const url = document.createElement('span');
    const revenue = document.createElement('span');
    url.textContent = row.url || '—';
    revenue.textContent = money(row.revenue);
    line.append(url, revenue);
    urls.append(line);
  }
}

function showView(view) {
  currentView = view;
  for (const item of workspace.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  document.getElementById('quick-page-title').textContent = pageTitles[view] || '工作台';
  document.getElementById('quick-page-hint').textContent = view === 'dashboard' ? '收入、流量质量与渠道结算一屏掌握' : '页面已就绪，正在载入详细内容';
  document.getElementById('quick-dashboard').hidden = view !== 'dashboard';
  document.getElementById('quick-page-preview').hidden = view === 'dashboard';
}

function showWorkspace(user) {
  const admin = user.role === 'admin';
  loginPage.hidden = true;
  workspace.hidden = false;
  workspace.classList.toggle('publisher', !admin);
  document.getElementById('quick-user').textContent = user.name || user.email || '当前用户';
  document.getElementById('quick-role').textContent = admin ? '平台管理员' : '渠道账号';
  document.getElementById('quick-brand').textContent = admin ? 'AdX Control' : 'AdX Publisher';
  document.getElementById('quick-brand-hint').textContent = admin ? '平台管理端' : '渠道工作台';
  document.getElementById('quick-revenue-label').textContent = admin ? '总流水（收入）' : '渠道结算收入';
  for (const item of workspace.querySelectorAll('[data-admin-only]')) item.hidden = !admin;
  document.getElementById('quick-range').textContent = start + ' 至 ' + end;
  showView(currentView);
}

async function requestDashboard() {
  const response = await fetch('/api/dashboard?start=' + start + '&end=' + end, { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  renderDashboard(data);
  return data;
}

async function openApp(user) {
  if (mounted || opening) return;
  opening = true;
  showWorkspace(user);
  const initialDashboard = { key: dashboardKey };
  initialDashboard.promise = requestDashboard().then(data => {
    initialDashboard.data = data;
    return { data };
  }, error => {
    showError('数据暂时无法加载：' + error.message + '。');
    return { error };
  });
  try {
    const app = await loadApp();
    app.mountApp(user, currentView, initialDashboard);
    mounted = true;
    try { sessionStorage.removeItem(retryKey); } catch {}
  } catch (error) {
    console.error('app_load_failed', error);
    showError('后台资源连接失败，当前工作台仍可查看。');
    retryAutomatically();
  } finally {
    opening = false;
  }
}

retryButton.addEventListener('click', () => window.location.reload());
document.getElementById('quick-retry').addEventListener('click', () => window.location.reload());
document.getElementById('quick-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  window.location.reload();
});
workspace.querySelector('.quick-nav').addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (view && Object.hasOwn(pageTitles, view)) showView(view);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled || mounted || opening) return;
  submitted = true;
  button.disabled = true;
  button.textContent = '正在登录…';
  status.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.elements.namedItem('email').value,
        password: form.elements.namedItem('password').value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false || !result.user) throw new Error(result.error || 'login_failed');
    await openApp(result.user);
  } catch (error) {
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    if (!mounted) {
      button.disabled = false;
      button.textContent = '登录';
    }
  }
});

// Restore an existing session in parallel; a fresh login is usable immediately.
fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
  .then(async response => {
    if (!response.ok || submitted) return;
    const result = await response.json();
    if (result.user && !submitted) await openApp(result.user);
  })
  .catch(() => {});

// Download the complete interface as soon as the login handlers are ready.
void loadApp().catch(() => {});
