import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const boot = (await readFile(new URL('../src/boot.js', import.meta.url), 'utf8'))
  .replace("import { readCached, rememberRead } from './readCache.js';", '')
  .replace("import('./main.jsx')", 'globalThis.__loadApp()')
  .replace("import('./RevenueChart.jsx')", 'globalThis.__loadChart()');

function start({ loginResponse, loadApp, dashboardResponse }) {
  const listeners = {};
  const button = { disabled: true, textContent: '登录' };
  const form = {
    querySelector: () => button,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    elements: { namedItem: name => ({ value: name === 'email' ? 'admin@example.test' : 'secret' }) }
  };
  const makeNode = () => ({ hidden: false, textContent: '',
    classList: { add() {}, remove() {} }, addEventListener() {} });
  const status = makeNode();
  const retry = { ...makeNode(), hidden: true };
  const loginPage = makeNode();
  const calls = [];
  const nodes = new Map([['boot-login', form], ['boot-status', status], ['boot-retry', retry]]);
  const document = { getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  }, querySelector: () => loginPage };
  const context = {
    document, URLSearchParams, console, readCached: () => null, rememberRead() {},
    window: { location: { hostname: 'adx.geekforest.ai', search: '', reload() {} }, setTimeout() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/auth/me') return { ok: false };
      if (path.startsWith('/api/dashboard')) return dashboardResponse || { ok: true,
        json: async () => ({ summary: { revenue: 12, impressions: 34 }, trend: [], topUrls: [] }) };
      return loginResponse;
    },
    __loadApp: loadApp,
    __loadChart: async () => ({})
  };
  vm.runInNewContext(boot, context);
  return { listeners, button, status, retry, calls, loginPage };
}

test('login waits for the full application bundle before it can submit', async () => {
  assert.match(html, /<button type="submit" disabled>登录<\/button>/);
  assert.doesNotMatch(html, /boot-workspace|quick-page-preview|页面正在打开/);
  let resolveApp;
  const page = start({ loginResponse: { ok: false, json: async () => ({ error: 'invalid_credentials' }) },
    loadApp: () => new Promise(resolve => { resolveApp = resolve; }) });
  assert.equal(page.button.disabled, true);
  await page.listeners.submit({ preventDefault() {} });
  assert.equal(page.calls.some(call => call.path === '/api/auth/login'), false);
  resolveApp({ mountApp: async () => {} });
  await new Promise(setImmediate);
  assert.equal(page.button.disabled, false);
  await page.listeners.submit({ preventDefault() {} });
  assert.equal(page.calls.some(call => call.path === '/api/auth/login'), true);
  assert.equal(page.status.textContent, '账号或密码错误');
  assert.equal(page.loginPage.hidden, false);
  assert.equal(page.button.disabled, false);
});

test('successful login switches directly to the real application', async () => {
  let finishMount;
  let mountedUser;
  const page = start({ loginResponse: { ok: true, json: async () => ({ user: { role: 'admin' } }) },
    loadApp: async () => ({ mountApp: async (user, view, initialDashboard) => {
      mountedUser = user;
      assert.equal(view, 'dashboard');
      assert.ok(initialDashboard.promise);
      await new Promise(resolve => { finishMount = resolve; });
      page.loginPage.hidden = true;
    } }) });
  await new Promise(setImmediate);
  const submit = page.listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(page.calls.some(call => call.path === '/api/auth/login'), true);
  assert.equal(page.loginPage.hidden, false);
  assert.equal(page.button.textContent, '正在登录…');
  assert.doesNotMatch(boot, /正在进入后台/);
  finishMount();
  await submit;
  assert.equal(mountedUser.role, 'admin');
  assert.equal(page.loginPage.hidden, true);
  assert.equal(page.calls.some(call => call.path.startsWith('/api/dashboard?')), true);
});

test('application load failure leaves a retryable login page', async () => {
  const page = start({ loginResponse: { ok: true, json: async () => ({ user: { role: 'admin' } }) },
    loadApp: async () => { throw new Error('asset_failed'); } });
  await new Promise(setImmediate);
  assert.equal(page.loginPage.hidden, false);
  assert.equal(page.button.disabled, true);
  assert.equal(page.retry.hidden, false);
  assert.match(page.status.textContent, /后台资源加载失败/);
});
