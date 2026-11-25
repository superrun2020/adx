import { viewForPath } from './navigation.js';
import { sessionFetch } from './sessionFetch.js';
import { previewApiPath, previewUserId } from './channelPreview.js';
import { getLocale, setLocale, startI18n } from './i18n.js';

const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button[type="submit"]');
const retryButton = document.getElementById('boot-retry');
const registerButton = document.getElementById('boot-register');
const sessionReauthKey = 'adx_session_reauth';
let sessionReauth = false;
try {
  sessionReauth = sessionStorage.getItem(sessionReauthKey) === '1';
  if (sessionReauth) {
    sessionStorage.removeItem(sessionReauthKey);
    status.textContent = '登录已过期，请重新登录。';
  }
} catch { /* Storage may be disabled. */ }
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道工作台';
  document.getElementById('boot-portal-label').textContent = '渠道工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '登录后可在合同管理完善资料并签署；审核通过并关联数据后开放。';
  registerButton.hidden = false;
}
const preview = previewUserId() !== null;
if (preview) {
  document.getElementById('boot-title').textContent = '渠道后台只读预览';
  document.getElementById('boot-hint').textContent = '';
  form.hidden = true;
  form.style.display = 'none';
  const back = document.createElement('a');
  back.href = '/channels';
  back.textContent = '返回渠道管理';
  status.after(back);
}
const languageTrigger = document.getElementById('boot-language-trigger');
const languageMenu = document.getElementById('boot-language-menu');
document.getElementById('boot-language-label').textContent = getLocale() === 'en' ? 'EN' : '中文';
languageTrigger.addEventListener('click', () => {
  languageMenu.hidden = !languageMenu.hidden;
  languageTrigger.setAttribute('aria-expanded', String(!languageMenu.hidden));
});
document.getElementById('boot-language-zh').addEventListener('click', () => setLocale('zh'));
document.getElementById('boot-language-en').addEventListener('click', () => setLocale('en'));
void startI18n().catch(error => console.error('language_load_failed', error));

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
async function requestDashboard() {
  const response = await sessionFetch(dashboardPath, { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'http_' + response.status);
  return data;
}

async function openApp(user) {
  if (mounted || opening) return;
  opening = true;
  button.disabled = true;
  const fallback = user.role === 'admin' && !user.isSuperAdmin && user.sidebarPermissions?.length && !user.sidebarPermissions.includes('dashboard')
    ? user.sidebarPermissions[0] : 'dashboard';
  const view = viewForPath(window.location.pathname, fallback, user);
  let initialDashboard = null;
  try {
    if (view === 'dashboard') {
      initialDashboard = { key: dashboardKey };
      initialDashboard.promise = requestDashboard().then(data => ({ data }), error => ({ error }));
    }
    const app = await prepareApp();
    await app.mountApp(user, view, initialDashboard);
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
    if (!response.ok || result.ok === false || !result.user) {
      const error = new Error(result.error || 'login_failed');
      error.status = response.status;
      throw error;
    }
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

registerButton.addEventListener('click', async () => {
  if (registerButton.disabled) return;
  registerButton.disabled = true;
  status.textContent = '';
  try {
    const module = await import('./ChannelRegistration.jsx');
    module.mountChannelRegistration(() => window.location.reload(), user => openApp(user));
  } catch (error) {
    console.error('channel_registration_load_failed', error);
    status.textContent = '注册表单加载失败，请刷新后重试。';
    registerButton.disabled = false;
  }
});

// Begin loading when the browser is idle; credentials can be submitted immediately.
const warmApp = () => { void prepareApp().catch(error => {
  console.error('app_preload_failed', error);
}); };
if ('requestIdleCallback' in window) window.requestIdleCallback(warmApp, { timeout: 500 });
else window.setTimeout(warmApp, 0);
if (preview || !sessionReauth) fetch(previewApiPath('/api/auth/me'), { credentials: 'include', cache: 'no-store' })
  .then(async response => {
    if (submitted) return;
    if (!response.ok) {
      if (preview) status.textContent = response.status === 401 ? '请先登录运营后台，再打开只读预览。' : '该渠道当前无法预览，请返回渠道管理。';
      return;
    }
    const result = await response.json();
    if (result.user && !submitted) await openApp(preview ? { ...result.user, readOnlyPreview:true } : result.user);
  })
  .catch(() => { if (preview) status.textContent = '渠道后台预览加载失败，请刷新页面。'; });
