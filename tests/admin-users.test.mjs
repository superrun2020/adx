import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adx-admin-auth-'));
const port = 20000 + Math.floor(Math.random() * 30000);
const base = `http://127.0.0.1:${port}`;
let child;
let stderr = '';

async function request(route, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login(email, password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.cookie);
  return result;
}

before(async () => {
  const goBinary = process.env.ADX_TEST_GO_BINARY;
  child = spawn(goBinary || process.execPath, goBinary ? [] : ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ADX_SITE_ROOT: root, ADX_GAM_WORKER_DISABLED: 'true',
      ADX_DB_PATH: path.join(dir, 'admin.sqlite'), ADX_ADMIN_EMAIL: 'admin@example.test', ADX_ADMIN_PASSWORD: 'AdminPass123!' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode != null) break;
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('admin_test_server_not_ready: ' + stderr.slice(-2000));
});
after(async () => {
  if (child && child.exitCode == null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('super administrator grants menus, revokes sessions and deletes another account', async () => {
  const owner = await login('admin@example.test', 'AdminPass123!');
  assert.equal(owner.data.user.isSuperAdmin, true);
  const created = await request('/api/admin/users', { cookie: owner.cookie, method: 'POST', body: {
    name: 'Restricted', email: 'restricted@example.test', password: 'RestrictedPass123!',
    isSuperAdmin: false, sidebarPermissions: ['reports']
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const list = await request('/api/admin/users', { cookie: owner.cookie });
  const target = list.data.items.find(item => item.email === 'restricted@example.test');
  assert.deepEqual(target.sidebarPermissions, ['reports']);
  assert.equal(target.isSuperAdmin, false);

  const restricted = await login('restricted@example.test', 'RestrictedPass123!');
  assert.deepEqual(restricted.data.user.sidebarPermissions, ['reports']);
  assert.equal((await request('/api/reports?start=2026-11-01&end=2026-11-01', { cookie: restricted.cookie })).status, 200);
  assert.equal((await request('/api/dashboard', { cookie: restricted.cookie })).status, 403);
  assert.equal((await request('/api/admin/gam-accounts', { cookie: restricted.cookie })).status, 403);
  assert.equal((await request('/api/admin/users', { cookie: restricted.cookie })).status, 403);
  assert.equal((await request('/api/admin/users/' + target.id, { cookie: restricted.cookie, method: 'DELETE' })).status, 403);

  const updated = await request('/api/admin/users/' + target.id, { cookie: owner.cookie, method: 'PUT', body: {
    name: 'Restricted', status: 'active', isSuperAdmin: false, sidebarPermissions: ['dashboard', 'reports']
  } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal((await request('/api/auth/me', { cookie: restricted.cookie })).status, 401);
  const relogged = await login('restricted@example.test', 'RestrictedPass123!');
  assert.deepEqual(relogged.data.user.sidebarPermissions, ['dashboard', 'reports']);
  assert.equal((await request('/api/dashboard', { cookie: relogged.cookie })).status, 200);
  assert.equal((await request('/api/admin/users', { cookie: relogged.cookie })).status, 403);

  const ownerId = owner.data.user.id;
  assert.equal((await request('/api/admin/users/' + ownerId, { cookie: owner.cookie, method: 'DELETE' })).status, 400);
  assert.equal((await request('/api/admin/users/' + ownerId, { cookie: owner.cookie, method: 'PUT', body: {
    name: 'Owner', status: 'active', isSuperAdmin: false, sidebarPermissions: ['reports']
  } })).status, 400);
  assert.equal((await request('/api/admin/users/' + target.id, { cookie: owner.cookie, method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: relogged.cookie })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'restricted@example.test', password: 'RestrictedPass123!' } })).status, 401);
});
