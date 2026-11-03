const form = document.getElementById('boot-login');
const status = document.getElementById('boot-status');
const button = form.querySelector('button');
const root = document.getElementById('root');
const bootPage = root.querySelector('.boot-page');
const portal = window.location.hostname.toLowerCase() === 'adxpub.geekforest.ai'
  || new URLSearchParams(window.location.search).get('portal') === 'publisher';

if (portal) {
  document.getElementById('boot-brand-name').textContent = 'AdX Publisher';
  document.getElementById('boot-brand-hint').textContent = '渠道收益与流量数据工作台';
  document.getElementById('boot-title').textContent = '渠道登录';
  document.getElementById('boot-hint').textContent = '使用平台分配的渠道账号登录，仅可查看本渠道分成后数据。';
}

let appPromise;
let mounted = false;
let shell;
let requestedView = 'dashboard';
function localDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
async function loadQuickDashboard(user) {
  const now = new Date();
  const start = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const end = localDate(now);
  try {
    const response = await fetch('/api/dashboard?' + new URLSearchParams({ start, end }), { credentials:'include' });
    if (!response.ok) throw new Error('dashboard_unavailable');
    const data = await response.json();
    if (!shell?.isConnected || !data.ok) return;
    const summary = data.summary || {};
    const money = value => '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
    const number = value => Number(value || 0).toLocaleString('zh-CN');
    const metrics = [
      [user.role === 'admin' ? '总流水（收入）' : '渠道结算收入', money(summary.revenue)],
      ['展示量', number(summary.impressions)],
      ['匹配率', Number(summary.matchRate || 0).toFixed(2) + '%']
    ];
    if (user.role === 'admin') metrics.splice(1,0,['渠道结算收益',money(summary.channelRevenue)]);
    const grid = shell.querySelector('.boot-metrics');
    for (const [label, value] of metrics) {
      const item = document.createElement('article');
      const heading = document.createElement('span'); heading.textContent = label;
      const result = document.createElement('strong'); result.textContent = value;
      item.append(heading,result); grid.append(item);
    }
    const urls = shell.querySelector('.boot-top-urls');
    for (const item of (data.topUrls || []).slice(0,5)) {
      const row = document.createElement('li');
      const name = document.createElement('span'); name.textContent = item.url || '未命名链接';
      const revenue = document.createElement('strong'); revenue.textContent = money(item.revenue);
      row.append(name,revenue); urls.append(row);
    }
    shell.querySelector('.boot-data-status').textContent = data.lastSync ? '最近同步 ' + data.lastSync : '尚未同步数据';
  } catch {
    if (shell?.isConnected) shell.querySelector('.boot-data-status').textContent = '数据暂不可用，稍后可在工作区刷新';
  }
}
function showShell(user) {
  if (shell) return;
  bootPage.hidden = true;
  shell = document.createElement('div');
  shell.className = 'boot-shell';
  shell.innerHTML = '<aside><strong>AX</strong><span>' + (portal ? 'AdX Publisher' : 'AdX Control') +
    '</span><nav aria-label="后台菜单"></nav></aside><main><header>后台工作区</header>' +
    '<section><h1>经营总览</h1><p class="boot-shell-status">已登录，完整功能正在加载…</p>' +
    '<p class="boot-data-status">正在读取数据…</p><div class="boot-metrics"></div></section>' +
    '<section><h2>收益最高的链接</h2><ul class="boot-top-urls"></ul></section></main>';
  const pages = [['dashboard', '经营总览'], ['reports', '数据报告'],
    ...(user.role === 'admin' ? [['channels', '渠道管理'], ['gam', 'Ad Manager REST'], ['settlement', '结算配置'], ['ad-units', '广告单元创建'], ['admins', '管理员账户'], ['report-keys', '账户日报 API Key']] : []),
    ['api', '渠道 API']];
  const nav = shell.querySelector('nav');
  for (const [view, label] of pages) {
    const item = document.createElement('button');
    item.type = 'button'; item.dataset.view = view; item.textContent = label;
    item.className = view === requestedView ? 'selected' : '';
    item.addEventListener('click', () => {
      requestedView = view;
      for (const button of nav.querySelectorAll('button')) button.classList.toggle('selected', button === item);
      shell.querySelector('.boot-shell-status').textContent = view === 'dashboard'
        ? '已登录，完整功能正在加载…' : '正在打开' + label + '，完整功能加载后自动切换…';
    });
    nav.append(item);
  }
  root.append(shell);
  void loadQuickDashboard(user);
}
function getApp() {
  if (!appPromise) appPromise = import('./main.jsx').catch(error => { appPromise = null; throw error; });
  return appPromise;
}
async function loadApp(user) {
  if (mounted) return;
  form.hidden = true;
  status.classList.add('loading');
  status.textContent = '正在加载安全工作区…';
  showShell(user);
  try {
    const app = await getApp();
    if (mounted) return;
    mounted = true;
    app.mountApp(user, requestedView);
  } catch (error) {
    console.error('app_load_failed', error);
    mounted = false;
    shell?.remove();
    shell = null;
    bootPage.hidden = false;
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
    await loadApp(result.user);
  } catch (error) {
    status.classList.remove('loading');
    status.textContent = error.message === 'invalid_credentials' ? '账号或密码错误' : '登录失败，请稍后重试。';
  } finally {
    button.disabled = false;
  }
});

fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
  .then(async response => {
    if (response.ok) return loadApp((await response.json()).user);
    getApp().catch(() => {});
  })
  .catch(() => { status.textContent = '暂时无法连接服务，请稍后重试。'; });
