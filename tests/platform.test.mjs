import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4191;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adx-platform-'));
let child;
let cookie = '';

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), ADX_DB_PATH: path.join(dir, 'test.sqlite'), ADX_ADMIN_EMAIL: 'admin@example.test', ADX_ADMIN_PASSWORD: 'AdminPass123!' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server_not_ready');
});
after(() => child?.kill('SIGTERM'));

test('admin creates channel, previews/imports JSON, and channel API receives settled revenue', async () => {
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const created = await request('/api/admin/channels', { method: 'POST', body: JSON.stringify({ name: 'Publisher A', email: 'publisher@example.test', password: 'PublisherPass123!', sharePercent: 75, status: 'active' }) });
  assert.equal(created.response.status, 201);
  const channelId = created.body.channel.id;
  const payload = [{ date: '2026-10-08', url: 'https://example.com/a', ad_unit: 'Banner', country: 'US', requests: 1000, matched_requests: 900, impressions: 800, clicks: 10, revenue: 20, 'Demand channel': 'Ad Exchange' }];
  const preview = await request('/api/admin/imports/preview', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'report.json', payload }) });
  assert.equal(preview.body.accepted, 1);
  const imported = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'report.json', payload }) });
  assert.deepEqual({ accepted: imported.body.accepted, rejected: imported.body.rejected }, { accepted: 1, rejected: 0 });
  const secret = await request(`/api/admin/channels/${channelId}/api-secret`, { method: 'POST' });
  const publicResult = await fetch(`http://127.0.0.1:${port}/api/public/channel/revenue?start_date=2026-10-08&end_date=2026-10-08`, { headers: { Authorization: `Bearer ${secret.body.secret}` } }).then(r => r.json());
  assert.equal(publicResult.data[0].revenue, 15);
  assert.equal(publicResult.meta.total, 1);
});

test('channel account cannot access administration endpoints', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'publisher@example.test', password: 'PublisherPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal(login.body.user.role, 'channel');
  assert.equal((await request('/api/admin/channels')).response.status, 403);
  const report = await request('/api/reports?start=2026-10-08&end=2026-10-08&dimensions=date,url');
  assert.equal(report.body.items[0].channelRevenue, 15);
});

test('Google Ad Manager API-style field names are mapped during preflight and import', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channels = await request('/api/admin/channels');
  const channelId = channels.body.items[0].id;
  const payload = [{ DATE: '2026-10-09', DIMENSION_URL_CHANNEL: 'https://example.com/api', DIMENSION_AD_UNIT_NAME: 'Interstitial', DIMENSION_COUNTRY_CODE: 'US', METRIC_TOTAL_AD_REQUESTS: 500, METRIC_TOTAL_MATCHED_REQUESTS: 450, METRIC_TOTAL_IMPRESSIONS: 400, METRIC_TOTAL_CLICKS: 8, METRIC_TOTAL_REVENUE: 12.5, CUSTOM_API_FIELD: 'preserved' }];
  const preview = await request('/api/admin/imports/preview', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'google-api.json', payload }) });
  assert.deepEqual({ accepted: preview.body.accepted, rejected: preview.body.rejected }, { accepted: 1, rejected: 0 });
  assert.equal(preview.body.fieldMappings.find(item => item.field === 'revenue').source, 'METRIC_TOTAL_REVENUE');
  assert.deepEqual(preview.body.missingRequiredFields, []);
  assert.deepEqual(preview.body.preservedFields, ['CUSTOM_API_FIELD']);
  const imported = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'google-api.json', payload }) });
  assert.equal(imported.body.accepted, 1);
});

test('admin and channel accounts are restricted to their own domains', async () => {
  cookie = '';
  const deniedAdmin = await request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Host': 'adxpub.geekforest.ai' }, body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  assert.equal(deniedAdmin.response.status, 401);
  const allowedAdmin = await request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Host': 'adx.geekforest.ai' }, body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  assert.equal(allowedAdmin.response.status, 200);
  cookie = '';
  const allowedChannel = await request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Host': 'adxpub.geekforest.ai' }, body: JSON.stringify({ email: 'publisher@example.test', password: 'PublisherPass123!' }) });
  assert.equal(allowedChannel.response.status, 200);
  cookie = allowedChannel.response.headers.get('set-cookie').split(';')[0];
  const crossedPortal = await request('/api/auth/me', { headers: { 'X-Forwarded-Host': 'adx.geekforest.ai' } });
  assert.equal(crossedPortal.response.status, 403);
});

test('channel dashboard and reports expose only settled revenue', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Host': 'adxpub.geekforest.ai' }, body: JSON.stringify({ email: 'publisher@example.test', password: 'PublisherPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const dashboard = await request('/api/dashboard?start=2026-10-08&end=2026-10-08', { headers: { 'X-Forwarded-Host': 'adxpub.geekforest.ai' } });
  assert.equal(dashboard.body.summary.revenue, 15);
  assert.equal(dashboard.body.trend[0].revenue, 15);
  assert.equal(dashboard.body.topUrls[0].revenue, 15);
  const report = await request('/api/reports?start=2026-10-08&end=2026-10-08&dimensions=date,url', { headers: { 'X-Forwarded-Host': 'adxpub.geekforest.ai' } });
  assert.equal(report.body.items[0].revenue, 15);
  assert.equal(report.body.items[0].channelRevenue, 15);
});

test('missing required revenue is rejected instead of becoming zero', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channels = await request('/api/admin/channels');
  const preview = await request('/api/admin/imports/preview', { method: 'POST', body: JSON.stringify({ channelId: channels.body.items[0].id, fileName: 'missing.json', payload: [{ date: '2026-10-09', url: 'https://example.com/missing' }] }) });
  assert.deepEqual({ accepted: preview.body.accepted, rejected: preview.body.rejected }, { accepted: 0, rejected: 1 });
  const imported = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId: channels.body.items[0].id, fileName: 'missing.json', payload: [{ date: '2026-10-09' }] }) });
  assert.equal(imported.response.status, 422);
});

test('administrator dashboard uses each channel share for settlement totals', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const dashboard = await request('/api/dashboard?start=2026-10-08&end=2026-10-08');
  assert.equal(dashboard.body.summary.revenue, 20);
  assert.equal(dashboard.body.summary.channelRevenue, 15);
});
