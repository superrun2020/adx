const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button');
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道收益与流量数据工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '使用平台分配的渠道账号登录，仅可查看本渠道分成后数据。';
}

let mounted = false;
let appReady = false;
let retryMode = false;
const retryKey = 'adx_asset_retry_once';
button.disabled = true;
button.textContent = '正在准备完整后台…';
status.classList.add('loading');
status.textContent = '工作区资源加载中，完成后即可登录。';

function retryAutomatically() {
  try {
    if (sessionStorage.getItem(retryKey)) return false;
    sessionStorage.setItem(retryKey, '1');
  } catch { return false; }
  status.classList.add('loading');
  status.textContent = '网络中断，正在自动恢复后台…';
  window.setTimeout(() => window.location.reload(), 800);
  return true;
}
function offerRetry() {
  retryMode = true;
  form.hidden = false;
  button.disabled = false;
  button.textContent = '重新加载';
  status.classList.remove('loading');
  status.textContent = '连接暂时不稳定，点击重新加载继续。';
}

// The core includes the complete layout and styles. Optional pages may recover later.
const appPromise = Promise.allSettled([
  import('./main.jsx'),
  import('./ReportExplorer.jsx'),
  import('./AdminPages.jsx'),
  import('./RevenueChart.jsx')
]).then(([core, ...pages]) => {
  const incomplete = core.status === 'rejected' || pages.some(page => page.status === 'rejected');
  if (incomplete && retryAutomatically()) return new Promise(() => {});
  if (core.status === 'rejected') throw core.reason;
  if (incomplete) console.warn('optional_page_preload_failed');
  else { try { sessionStorage.removeItem(retryKey); } catch {} }
  appReady = true;
  button.disabled = false;
  button.textContent = '登录';
  if (!form.hidden) {
    status.classList.remove('loading');
    status.textContent = '';
  }
  return core.value;
}).catch(error => {
  console.error('app_load_failed', error);
  if (!retryAutomatically()) offerRetry();
  throw error;
});
void appPromise.catch(() => {});

async function openApp(user) {
  const app = await appPromise;
  if (mounted) return;
  app.mountApp(user);
  mounted = true;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (retryMode) { window.location.reload(); return; }
  if (!appReady) return;
  button.disabled = true;
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
    if (!response.ok || result.ok === false) throw new Error(result.error || 'login_failed');
    await openApp(result.user);
  } catch (error) {
    if (retryMode) return;
    status.classList.remove('loading');
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    if (!mounted) button.disabled = !appReady && !retryMode;
  }
});

fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
  .then(async response => {
    if (!response.ok) return;
    const { user } = await response.json();
    form.hidden = true;
    status.classList.add('loading');
    status.textContent = '正在准备完整后台…';
    await openApp(user);
  })
  .catch(() => {
    if (mounted) return;
    if (retryMode) return;
    form.hidden = false;
    if (appReady) {
      status.classList.remove('loading');
      status.textContent = '暂时无法连接服务，请稍后重试。';
    }
  });
