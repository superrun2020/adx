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

async function loadApp() {
  form.hidden = true;
  status.classList.add('loading');
  status.textContent = '正在加载安全工作区…';
  try {
    await import('./main.jsx');
  } catch (error) {
    console.error('app_load_failed', error);
    form.hidden = false;
    status.classList.remove('loading');
    status.textContent = '工作区加载失败，请刷新页面重试。';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
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
    await loadApp();
  } catch (error) {
    status.classList.remove('loading');
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    button.disabled = false;
  }
});

fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
  .then(response => { if (response.ok) return loadApp(); })
  .catch(() => { status.textContent = '暂时无法连接服务，请稍后重试。'; });
