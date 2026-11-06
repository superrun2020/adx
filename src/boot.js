import { readCached, rememberRead } from './readCache.js';

const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button[type="submit"]');
const retryButton = document.getElementById('boot-retry');
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道工作台';
  document.getElementById('boot-portal-label').textContent = '渠道工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '使用平台分配的渠道账号登录，查看本渠道数据。';
}

let mounted = false;
let opening = false;
let submitted = false;
let appPromise;
let readyPromise;
const retryKey = 'adx_asset_retry_once';
const dateText = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const today = new Date();
const start = dateText(new Date(today.getFullYear(), today.getMonth(), 1));
const end = dateText(today);
const dashboardKey = start + ':' + end;

function loadApp() {
  // Start downloading the complete interface while the user is still on the login page.
  if (!appPromise) appPromise = import('./main.jsx').catch(error => {
    appPromise = null;
    throw error;
  });
  return appPromise;
}

function prepareApp() {
  if (!readyPromise) readyPromise = loadApp().catch(error => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

function retryAutomatically() {
  try {
    if (sessionStorage.getItem(retryKey)) return;
    sessionStorage.setItem(retryKey, '1');
    window.setTimeout(() => window.location.reload(), 400);
  } catch { /* Manual retry remains available. */ }
}

const dashboardPath = '/api/dashboard?start=' + start + '&end=' + end + '&source=rest';
const highlightsPath = '/api/dashboard/highlights';
async function requestDashboard(path = dashboardPath) {
  const response = await fetch(path, { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  return data;
}

async function openApp(user) {
  if (mounted || opening) return;
  opening = true;
  button.disabled = true;
  if (user.role === 'admin' && !user.isSuperAdmin &&
      Array.isArray(user.sidebarPermissions) && !user.sidebarPermissions.includes('dashboard')) {
    try {
      const app = await prepareApp();
      await app.mountApp(user, user.sidebarPermissions[0] || 'api', null);
      mounted = true;
    } catch (error) {
      console.error('app_load_failed', error);
      status.textContent = '后台资源加载失败，请刷新重试。';
      retryButton.hidden = false;
    } finally {
      opening = false;
    }
    return;
  }
  const saved = readCached(user, dashboardPath);
  const highlightsSaved = readCached(user, highlightsPath);
  const initialDashboard = { key: dashboardKey, data: saved?.data };
  initialDashboard.promise = requestDashboard().then(data => {
    initialDashboard.data = data;
    initialDashboard.fresh = true;
    rememberRead(user, dashboardPath, data);
    return { data };
  }, error => ({ error }));
  const highlightsPromise = requestDashboard(highlightsPath).then(data => {
    rememberRead(user, highlightsPath, data);
    return { data };
  }, error => ({ error }));
  try {
    const app = await prepareApp();
    if (!saved?.data || !highlightsSaved?.data) await Promise.all([initialDashboard.promise, highlightsPromise]);
    await app.mountApp(user, 'dashboard', initialDashboard);
    mounted = true;
    // Warm secondary views only after the visible workspace is ready.
    const warmViews = () => { void Promise.allSettled([import('./ReportExplorer.jsx'), import('./AdminPages.jsx')]); };
    if ('requestIdleCallback' in window) window.requestIdleCallback(warmViews, { timeout: 2000 });
    else window.setTimeout(warmViews, 500);
    try { sessionStorage.removeItem(retryKey); } catch { /* Storage may be disabled. */ }
  } catch (error) {
    console.error('app_load_failed', error);
    status.classList.remove('loading');
    status.textContent = '后台资源加载失败，请刷新重试。';
    retryButton.hidden = false;
    retryAutomatically();
  } finally {
    opening = false;
  }
}

retryButton.addEventListener('click', () => window.location.reload());
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled || mounted || opening) return;
  submitted = true;
  button.disabled = true;
  button.textContent = '正在登录…';
  status.textContent = '';
  retryButton.hidden = true;
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
    status.classList.remove('loading');
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    if (!mounted) {
      button.disabled = false;
      button.textContent = '登录';
    }
  }
});

// Begin loading when the browser is idle; credentials can be submitted immediately.
const warmApp = () => { void prepareApp().catch(error => {
  console.error('app_preload_failed', error);
}); };
if ('requestIdleCallback' in window) window.requestIdleCallback(warmApp, { timeout: 500 });
else window.setTimeout(warmApp, 0);
fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
  .then(async response => {
    if (!response.ok || submitted) return;
    const result = await response.json();
    if (result.user && !submitted) await openApp(result.user);
  })
  .catch(() => {});
