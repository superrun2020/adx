const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button[type="submit"]');
const retryButton = document.getElementById('boot-retry');
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道收益与流量数据工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '使用平台分配的渠道账号登录，查看本渠道数据。';
}

let mounted = false;
let submitted = false;
let appPromise;
const retryKey = 'adx_asset_retry_once';

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
  status.textContent = '正在重新连接后台资源…';
  window.setTimeout(() => window.location.reload(), 400);
  return true;
}

async function openApp(user) {
  if (mounted) return;
  form.hidden = true;
  status.classList.add('loading');
  status.textContent = '正在进入工作台…';
  retryButton.hidden = true;
  try {
    const app = await loadApp();
    if (mounted) return;
    app.mountApp(user);
    mounted = true;
    try { sessionStorage.removeItem(retryKey); } catch {}
  } catch (error) {
    console.error('app_load_failed', error);
    if (retryAutomatically()) return;
    form.hidden = false;
    button.disabled = false;
    status.classList.remove('loading');
    status.textContent = '后台资源暂时无法加载，请刷新页面重试。';
    retryButton.hidden = false;
  }
}

retryButton.addEventListener('click', () => window.location.reload());

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled || mounted) return;
  submitted = true;
  button.disabled = true;
  button.textContent = '正在登录…';
  status.classList.remove('loading');
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

// Warm only the core shell after first paint. Reports and admin pages load on demand.
if (window.requestIdleCallback) {
  window.requestIdleCallback(() => { void loadApp().catch(() => {}); }, { timeout: 2500 });
} else {
  window.setTimeout(() => { void loadApp().catch(() => {}); }, 250);
}
