import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const boot = (await readFile(new URL('../src/boot.js', import.meta.url), 'utf8'))
  .replace("import('./main.jsx')", 'globalThis.__loadApp()');

function start({ loginResponse, loadApp }) {
  const listeners = {};
  const button = { disabled: false, textContent: '登录' };
  const form = {
    hidden: false,
    querySelector: () => button,
    addEventListener: (name, handler) => { listeners[name] = handler; },
    elements: { namedItem: name => ({ value: name === 'email' ? 'admin@example.test' : 'secret' }) }
  };
  const status = { textContent: '', classList: { add() {}, remove() {} } };
  const retry = { hidden: true, addEventListener() {} };
  const calls = [];
  const nodes = new Map([['boot-login', form], ['boot-status', status], ['boot-retry', retry]]);
  const document = { getElementById: id => nodes.get(id) || { textContent: '' } };
  const context = {
    document, URLSearchParams, console,
    window: { location: { hostname: 'adx.geekforest.ai', search: '', reload() {} }, requestIdleCallback() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (path, options) => {
      calls.push({ path, options });
      return path === '/api/auth/me' ? { ok: false } : loginResponse;
    },
    __loadApp: loadApp
  };
  vm.runInNewContext(boot, context);
  return { listeners, button, form, status, calls };
}

test('login is enabled before the application bundle loads', async () => {
  assert.equal(html.includes('<button type="submit">登录</button>'), true);
  assert.doesNotMatch(html, /正在准备完整后台/);
  const page = start({ loginResponse: { ok: false, json: async () => ({ error: 'invalid_credentials' }) },
    loadApp: () => new Promise(() => {}) });
  assert.equal(page.button.disabled, false);
  await page.listeners.submit({ preventDefault() {} });
  assert.equal(page.calls.some(call => call.path === '/api/auth/login'), true);
  assert.equal(page.status.textContent, '账号或密码错误');
  assert.equal(page.button.disabled, false);
});

test('successful login opens the shell when its bundle becomes ready', async () => {
  let resolveApp;
  let mountedUser;
  const page = start({ loginResponse: { ok: true, json: async () => ({ user: { role: 'admin' } }) },
    loadApp: () => new Promise(resolve => { resolveApp = resolve; }) });
  const submit = page.listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 10 && !resolveApp; i++) await new Promise(setImmediate);
  assert.equal(page.calls.some(call => call.path === '/api/auth/login'), true);
  assert.equal(page.form.hidden, true);
  resolveApp({ mountApp: user => { mountedUser = user; } });
  await submit;
  assert.equal(mountedUser.role, 'admin');
});
