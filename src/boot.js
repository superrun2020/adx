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
button.disabled = true;
button.textContent = '正在准备完整后台…';
status.classList.add('loading');
status.textContent = '工作区资源加载中，完成后即可登录。';

// Load every navigation page and its styles before login is allowed.
const appPromise = Promise.all([
  import('./main.jsx'),
  import('./ReportExplorer.jsx'),
  import('./AdminPages.jsx'),
  import('./RevenueChart.jsx')
]).then(([app]) => {
  appReady = true;
  button.disabled = false;
  button.textContent = '登录';
  if (!form.hidden) {
    status.classList.remove('loading');
    status.textContent = '';
  }
  return app;
}).catch(error => {
  console.error('app_load_failed', error);
  status.classList.remove('loading');
  status.textContent = '工作区资源加载失败，请刷新页面重试。';
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
    status.classList.remove('loading');
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    if (!mounted) button.disabled = !appReady;
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
    form.hidden = false;
    if (appReady) {
      status.classList.remove('loading');
      status.textContent = '暂时无法连接服务，请稍后重试。';
    }
  });
