import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  const root = path.resolve(import.meta.dirname, '..');
  const goBinary = process.env.ADX_TEST_GO_BINARY;
  child = spawn(goBinary || process.execPath, goBinary ? [] : ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ADX_SITE_ROOT: root, ADX_GAM_WORKER_DISABLED: 'true', ADX_DB_PATH: path.join(dir, 'test.sqlite'), ADX_ADMIN_EMAIL: 'admin@example.test', ADX_ADMIN_PASSWORD: 'AdminPass123!' },
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

test('regression settings are admin-only and never expose the Feishu webhook', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const initial = await request('/api/admin/regression/settings');
  assert.equal(initial.body.settings.minRevenue, 50);
  assert.equal(initial.body.settings.minDropPercent, 2);
  const invalid = await request('/api/admin/regression/settings', { method: 'PUT', body: JSON.stringify({ feishuEnabled: true, minRevenue: 50, minDropPercent: 2, webhook: 'http://127.0.0.1/hook' }) });
  assert.equal(invalid.response.status, 400);
  const saved = await request('/api/admin/regression/settings', { method: 'PUT', body: JSON.stringify({ feishuEnabled: false, minRevenue: 75, minDropPercent: 3, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' }) });
  assert.equal(saved.body.settings.minRevenue, 75);
  assert.equal(saved.body.settings.webhookConfigured, true);
  assert.equal(JSON.stringify(saved.body).includes('/hook/test'), false);
  const records = await request('/api/admin/regression/events?cadence=day');
  assert.equal(records.response.status, 200);
  assert.deepEqual(records.body.items, []);
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
  assert.equal(dashboard.body.topUrls[0].impressions, 800);
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

test('REST dashboard settlement excludes legacy facts', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
  const insert = db.prepare('INSERT INTO revenue_facts(channel_id,report_date,url,domain,ad_unit,revenue,source_file) VALUES(?,?,?,?,?,?,?)');
  insert.run(channelId, '2026-10-23', 'legacy.example.test', 'legacy.example.test', 'legacy-only', 100, 'manual:legacy');
  insert.run(channelId, '2026-10-23', 'rest.example.test', 'rest.example.test', 'rest-only', 20, 'gam-rest:123456789:report');
  db.close();
  const refreshed = await request('/api/admin/ad-unit-domains', { method: 'POST', body: JSON.stringify({ adUnit: 'rest-only', domain: 'https://rest.example.test' }) });
  assert.equal(refreshed.response.status, 201);
  const result = await request('/api/dashboard?start=2026-10-23&end=2026-10-23&source=rest');
  assert.equal(result.body.summary.revenue, 20);
  assert.equal(result.body.summary.channelRevenue, 15);
  assert.equal(result.body.topUrls[0].url, 'rest.example.test');
});

test('upstream account and ad unit rules calculate layered settlement and mapped domain', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  assert.equal((await request('/api/admin/upstream-accounts', { method: 'POST', body: JSON.stringify({ accountKey: 'acct-layered', name: '上游账户', sharePercent: 60 }) })).response.status, 201);
  assert.equal((await request('/api/admin/ad-unit-domains', { method: 'POST', body: JSON.stringify({ adUnit: 'unit-layered', domain: 'https://mapped.example.com/path' }) })).response.status, 201);
  assert.equal((await request('/api/admin/share-rules', { method: 'POST', body: JSON.stringify({ channelId, scopeType: 'ad_unit', scopeValue: 'unit-layered', sharePercent: 50, effectiveFrom: '2026-10-10' }) })).response.status, 201);
  const imported = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'layered.json', payload: [{ date: '2026-10-10', account: 'acct-layered', ad_unit: 'unit-layered', url: '', revenue: 100 }] }) });
  assert.equal(imported.body.accepted, 1);
  const report = await request('/api/reports?start=2026-10-10&end=2026-10-10&dimensions=adUnit,url');
  assert.equal(report.body.items[0].url, 'mapped.example.com');
  assert.equal(report.body.items[0].revenue, 100);
  assert.equal(report.body.items[0].upstreamRevenue, 60);
  assert.equal(report.body.items[0].channelRevenue, 30);
});

test('REST account setup links upstream settlement without exposing credentials', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const created = await request('/api/admin/gam-accounts', { method: 'POST', body: JSON.stringify({
    name: 'Test REST Network', networkCode: '123456789',
    credentials: { client_email: 'test@example.test', private_key: 'dummy-key', token_uri: 'https://oauth2.googleapis.com/token' }
  }) });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.item.status, 'untested');
  assert.equal(Object.hasOwn(created.body.item, 'credential_ciphertext'), false);
  const gamAccountId = created.body.item.id;
  const upstream = await request('/api/admin/upstream-accounts', { method: 'POST', body: JSON.stringify({
    accountKey: 'gam-test-upstream', name: 'REST Upstream', sharePercent: 100, gamAccountId
  }) });
  assert.equal(upstream.response.status, 201);
  assert.equal(upstream.body.item.gamAccountId, gamAccountId);
  const listed = await request('/api/admin/upstream-accounts');
  assert.equal(listed.body.items.find(item => item.accountKey === 'gam-test-upstream').gamAccountName, 'Test REST Network');
  assert.equal((await request('/api/admin/gam-accounts/' + gamAccountId + '/activate', { method: 'POST' })).response.status, 400);
  assert.equal((await request('/api/admin/soap-accounts')).response.status, 404);
});

test('reports keep distinct ad unit IDs, page safely, and drill into exact rows', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method:'POST', body:JSON.stringify({ email:'admin@example.test', password:'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const account = (await request('/api/admin/upstream-accounts')).body.items.find(item => item.accountKey === 'acct-layered');
  const updated = await request('/api/admin/upstream-accounts/' + account.id, { method:'PUT',
    body:JSON.stringify({ name:account.name, sharePercent:account.sharePercent, advertiser:'Acme', bd:'Alice' }) });
  assert.equal(updated.response.status, 200);
  const payload = [
    { date:'2026-10-12', hour:12, account:'acct-layered', ad_unit:'Same name', ad_unit_id:'unit-1',
      url:'https://report.example.test', country:'US', requests:100, matched_requests:80, impressions:60, clicks:3, revenue:10 },
    { date:'2026-10-12', hour:13, account:'acct-layered', ad_unit:'Same name', ad_unit_id:'unit-2',
      url:'https://report.example.test', country:'US', requests:200, matched_requests:180, impressions:150, clicks:8, revenue:20 },
    { date:'2026-10-13', hour:12, account:'acct-layered', ad_unit:'Same name', ad_unit_id:'unit-1',
      url:'https://report.example.test', country:'US', requests:50, matched_requests:40, impressions:30, clicks:2, revenue:5 }
  ];
  const imported = await request('/api/admin/imports', { method:'POST',
    body:JSON.stringify({ channelId, fileName:'six-dimensional.json', payload }) });
  assert.equal(imported.body.accepted, 3);
  const period = await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=url,adUnit,adUnitId');
  assert.equal(period.body.total, 2);
  const fuzzy = await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=url&domain=report.example&domainMatch=contains');
  assert.equal(fuzzy.body.total, 1);
  assert.equal(fuzzy.body.items[0].url, 'report.example.test');
  assert.equal((await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=url&domain=report.example&domainMatch=exact')).body.total, 0);
  assert.equal((await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=url&domainMatch=wildcard')).response.status, 400);
  const unitOne = period.body.items.find(item => item.adUnitId === 'unit-1');
  assert.equal(unitOne.revenue, 15);
  assert.equal(unitOne.requests, 150);
  assert.equal(unitOne.date, undefined);
  const byDay = await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=date,url,adUnit,adUnitId');
  assert.equal(byDay.body.total, 3);
  assert.deepEqual([...new Set(byDay.body.items.map(item => item.date))].sort(), ['2026-10-12','2026-10-13']);
  const selectedDay = await request('/api/reports?start=2026-10-12&end=2026-10-13&dimensions=date,url,adUnit,adUnitId&drill=' +
    encodeURIComponent(JSON.stringify({ date:'2026-10-12' })));
  assert.equal(selectedDay.body.total, 2);
  assert.ok(selectedDay.body.items.every(item => item.date === '2026-10-12'));
  const query = new URLSearchParams({ start:'2026-10-12', end:'2026-10-12',
    dimensions:'date,adUnit,adUnitId,channel,advertiser,bd', page:'1', pageSize:'1' });
  const first = await request('/api/reports?' + query);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].advertiser, 'Acme');
  assert.equal(first.body.items[0].bd, 'Alice');
  query.set('page','2');
  const second = await request('/api/reports?' + query);
  assert.equal(second.body.items.length, 1);
  assert.notEqual(second.body.items[0].adUnitId, first.body.items[0].adUnitId);
  const drill = new URLSearchParams({ start:'2026-10-12', end:'2026-10-12',
    dimensions:'date,hour,adUnit,adUnitId,country', drill:JSON.stringify({ adUnitId:'unit-1' }) });
  const detail = await request('/api/reports?' + drill);
  assert.equal(detail.body.total, 1);
  assert.equal(detail.body.items[0].hour, 12);
  assert.equal(detail.body.items[0].matchRate, 80);
  drill.set('minMatchRate','85');
  assert.equal((await request('/api/reports?' + drill)).body.total, 0);
  const restOnly = await request('/api/reports?start=2026-10-12&end=2026-10-12&source=rest');
  assert.equal(restOnly.body.total, 0);
  const exported = await fetch('http://127.0.0.1:' + port + '/api/reports/export?' + query,
    { headers:{ Cookie:cookie } });
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /unit-1|unit-2/);
  const formulaName = await request('/api/admin/imports', { method:'POST', body:JSON.stringify({
    channelId, fileName:'csv-safety.json', payload:[{ date:'2026-10-13', ad_unit:'=1+1', revenue:1 }]
  }) });
  assert.equal(formulaName.body.accepted, 1);
  const csvQuery = new URLSearchParams({ start:'2026-10-13', end:'2026-10-13', dimensions:'adUnit' });
  const csvResponse = await fetch('http://127.0.0.1:' + port + '/api/reports/export?' + csvQuery,
    { headers:{ Cookie:cookie } });
  assert.match(await csvResponse.text(), /"'=1\+1"/);
  cookie = '';
  const channelLogin = await request('/api/auth/login', { method:'POST',
    headers:{ 'X-Forwarded-Host':'adxpub.geekforest.ai' },
    body:JSON.stringify({ email:'publisher@example.test', password:'PublisherPass123!' }) });
  cookie = channelLogin.response.headers.get('set-cookie').split(';')[0];
  const channelReport = await request('/api/reports?start=2026-10-12&end=2026-10-12&dimensions=adUnitId',
    { headers:{ 'X-Forwarded-Host':'adxpub.geekforest.ai' } });
  assert.equal(channelReport.body.items.length, 2);
  assert.equal(channelReport.body.items[0].upstreamRevenue, undefined);
  assert.equal((await request('/api/reports?dimensions=advertiser',
    { headers:{ 'X-Forwarded-Host':'adxpub.geekforest.ai' } })).response.status, 403);
});

test('report cache is user scoped and invalidates after an import', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const route = '/api/dashboard?start=2026-10-20&end=2026-10-20';
  const payload = revenue => [{ date: '2026-10-20', url: 'https://cache-check.example/a', ad_unit: 'cache', revenue }];
  const firstImport = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'cache-check.json', payload: payload(10) }) });
  assert.equal(firstImport.response.status, 200);
  const first = await request(route);
  assert.equal(first.body.summary.revenue, 10);
  assert.match(first.response.headers.get('server-timing'), /miss/);
  const cached = await request(route);
  assert.equal(cached.body.summary.revenue, 10);
  assert.match(cached.response.headers.get('server-timing'), /hit/);
  const secondImport = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({ channelId, fileName: 'cache-check.json', payload: payload(25) }) });
  assert.equal(secondImport.response.status, 200);
  const refreshed = await request(route);
  assert.equal(refreshed.body.summary.revenue, 25);
  assert.match(refreshed.response.headers.get('server-timing'), /miss/);
});

test('dashboard daily totals rebuild after domain and share changes', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const adUnit = 'dashboard-rule-unique';
  const imported = await request('/api/admin/imports', { method: 'POST', body: JSON.stringify({
    channelId, fileName: 'dashboard-rule.json', payload: [{ date: '2026-10-21', url: 'https://original.example.test/p', ad_unit: adUnit, revenue: 20 }]
  }) });
  assert.equal(imported.response.status, 200);
  const route = '/api/dashboard?start=2026-10-21&end=2026-10-21';
  assert.equal((await request(route)).body.topUrls[0].url, 'original.example.test');
  const mapped = await request('/api/admin/ad-unit-domains', { method: 'POST', body: JSON.stringify({ adUnit, domain: 'https://mapped.example.test/p' }) });
  assert.equal(mapped.response.status, 201);
  assert.equal((await request(route)).body.topUrls[0].url, 'mapped.example.test');
  const rule = await request('/api/admin/share-rules', { method: 'POST', body: JSON.stringify({
    channelId, scopeType: 'ad_unit', scopeValue: adUnit, sharePercent: 50, effectiveFrom: '2026-10-21'
  }) });
  assert.equal(rule.response.status, 201);
  const refreshed = await request(route);
  assert.equal(refreshed.body.summary.revenue, 20);
  assert.equal(refreshed.body.summary.channelRevenue, 10);
});

test('Ad Manager account edit preserves credentials and pauses disabled sync', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const credentials = { client_email: 'service@example.iam.gserviceaccount.com', private_key: 'test-private-key' };
  const created = await request('/api/admin/gam-accounts', { method: 'POST', body: JSON.stringify({
    name: 'Network A', networkCode: '2331234567', accountEmail: 'owner@example.com',
    advertiser: 'Advertiser A', bd: 'BD A', advertiserSharePercent: 12.5,
    operationStatus: 'normal', enabled: true, notes: 'first', credentials
  }) });
  assert.equal(created.response.status, 200);
  const id = created.body.item.id;
  assert.equal(created.body.item.credentialConfigured, 1);
  assert.equal(created.body.item.accountEmail, 'owner@example.com');
  assert.equal(created.body.item.credentials, undefined);
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
  const original = db.prepare('SELECT credential_ciphertext FROM soap_accounts WHERE id=?').get(id).credential_ciphertext;
  db.prepare("UPDATE soap_accounts SET status='active',rest_sync_enabled=1,rest_report_name='networks/2331234567/reports/1' WHERE id=?").run(id);
  const updated = await request('/api/admin/gam-accounts/' + id, { method: 'PUT', body: JSON.stringify({
    name: 'Network A edited', networkCode: '2331234567', accountEmail: 'owner@example.com',
    advertiser: 'Advertiser B', bd: 'BD B', advertiserSharePercent: 15,
    operationStatus: 'limited', enabled: false, notes: 'paused'
  }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.item.enabled, 0);
  assert.equal(updated.body.item.operationStatus, 'limited');
  assert.equal(updated.body.item.advertiser, 'Advertiser B');
  const paused = db.prepare('SELECT credential_ciphertext,rest_sync_enabled,rest_report_name,status FROM soap_accounts WHERE id=?').get(id);
  assert.equal(paused.credential_ciphertext, original);
  assert.equal(paused.rest_sync_enabled, 0);
  assert.equal(paused.rest_report_name, 'networks/2331234567/reports/1');
  assert.equal(paused.status, 'active');
  const invalid = await request('/api/admin/gam-accounts/' + id, { method: 'PUT', body: JSON.stringify({
    name: 'Invalid', networkCode: '2331234567', advertiserSharePercent: 101, enabled: true
  }) });
  assert.equal(invalid.response.status, 400);
  assert.equal(db.prepare('SELECT name FROM soap_accounts WHERE id=?').get(id).name, 'Network A edited');
  const changedNetwork = await request('/api/admin/gam-accounts/' + id, { method: 'PUT', body: JSON.stringify({
    name: 'Network A edited', networkCode: '2331234568', advertiserSharePercent: 15, enabled: true
  }) });
  assert.equal(changedNetwork.response.status, 400);
  assert.equal(db.prepare('SELECT network_code FROM soap_accounts WHERE id=?').get(id).network_code, '2331234567');
  const replaced = await request('/api/admin/gam-accounts/' + id, { method: 'PUT', body: JSON.stringify({
    name: 'Network A edited', networkCode: '2331234567', accountEmail: 'owner@example.com',
    advertiser: 'Advertiser B', bd: 'BD B', advertiserSharePercent: 15,
    operationStatus: 'limited', enabled: true, notes: 'new key',
    credentials: { ...credentials, private_key: 'replacement-private-key' }
  }) });
  assert.equal(replaced.response.status, 200);
  const reset = db.prepare('SELECT credential_ciphertext,rest_sync_enabled,rest_report_name,status FROM soap_accounts WHERE id=?').get(id);
  assert.notEqual(reset.credential_ciphertext, original);
  assert.equal(reset.rest_sync_enabled, 0);
  assert.equal(reset.rest_report_name, '');
  assert.equal(reset.status, 'untested');
  db.close();
});

test('daily interval summary pages through dates and returns detailed metrics', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method:'POST', body:JSON.stringify({ email:'admin@example.test', password:'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const payload = Array.from({ length:7 }, (_, index) => ({
    date:'2026-10-' + String(24 + index), url:'https://daily-' + index + '.example.test',
    ad_unit:'daily-unit-' + index, requests:100, matched_requests:80,
    impressions:40, clicks:4, revenue:10
  }));
  payload.push({ date:'2026-10-30', url:'https://daily-extra.example.test',
    ad_unit:'daily-extra-unit', requests:50, matched_requests:40,
    impressions:20, clicks:2, revenue:5 });
  const imported = await request('/api/admin/imports', { method:'POST',
    body:JSON.stringify({ channelId, fileName:'daily-pages.json', payload }) });
  assert.equal(imported.body.accepted, 8);
  const route = '/api/reports?start=2026-10-24&end=2026-10-30&dimensions=date&pageSize=5';
  const first = await request(route + '&page=1');
  const second = await request(route + '&page=2');
  assert.equal(first.body.total, 7);
  assert.equal(second.body.total, 7);
  assert.deepEqual(first.body.items.map(item => item.date),
    ['2026-10-30','2026-10-29','2026-10-28','2026-10-27','2026-10-26']);
  assert.deepEqual(second.body.items.map(item => item.date), ['2026-10-25','2026-10-24']);
  assert.equal(first.body.items[0].matchedRequests, 120);
  assert.equal(first.body.items[0].clicks, 6);
  assert.equal(first.body.items[0].matchRate, 80);
  assert.equal(first.body.items[0].impressionRate, 50);
  assert.equal(first.body.items[0].clickRate, 10);
  assert.equal(first.body.items[0].ecpm, 250);
  const byDomain = await request(route.replace('dimensions=date', 'dimensions=date,url') + '&page=2');
  assert.equal(byDomain.body.total, 8);
  assert.equal(byDomain.body.items.length, 3);
  assert.ok(byDomain.body.items.every(item => item.url.endsWith('.example.test')));
});

test('editing GAM advertiser and BD updates existing REST report dimensions', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method:'POST',
    body:JSON.stringify({ email:'admin@example.test', password:'AdminPass123!' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const channelId = (await request('/api/admin/channels')).body.items[0].id;
  const created = await request('/api/admin/gam-accounts', { method:'POST', body:JSON.stringify({
    name:'Metadata Network', networkCode:'4455667788',
    credentials:{ client_email:'metadata@example.test', private_key:'dummy-key' }
  }) });
  assert.equal(created.response.status, 200);
  const gamAccountId = created.body.item.id;
  const upstream = await request('/api/admin/upstream-accounts', { method:'POST', body:JSON.stringify({
    accountKey:'metadata-upstream', name:'Metadata Upstream', gamAccountId,
    sharePercent:100, advertiser:'Old Advertiser', bd:'Old BD'
  }) });
  assert.equal(upstream.response.status, 201);
  const imported = await request('/api/admin/imports', { method:'POST', body:JSON.stringify({
    channelId, fileName:'metadata-source.json', payload:[{
      date:'2026-11-02', account:'metadata-upstream', ad_unit:'metadata-unit',
      url:'https://metadata.example.test', revenue:10
    }]
  }) });
  assert.equal(imported.body.accepted, 1);
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
  db.prepare('UPDATE revenue_facts SET source_file=? WHERE account=? AND report_date=?')
    .run('gam-rest:4455667788:test', 'metadata-upstream', '2026-11-02');
  db.close();
  const route = '/api/reports?start=2026-11-02&end=2026-11-02&source=rest'
    + '&dimensions=account,advertiser,bd&upstreamAccount=metadata-upstream';
  const before = await request(route);
  assert.equal(before.body.items[0].advertiser, 'Old Advertiser');
  assert.equal(before.body.items[0].bd, 'Old BD');
  const updated = await request('/api/admin/gam-accounts/' + gamAccountId, { method:'PUT', body:JSON.stringify({
    name:'Metadata Network', networkCode:'4455667788', advertiser:'New Advertiser', bd:'New BD', enabled:true
  }) });
  assert.equal(updated.response.status, 200);
  const after = await request(route);
  assert.equal(after.body.items[0].advertiser, 'New Advertiser');
  assert.equal(after.body.items[0].bd, 'New BD');
  assert.equal((await request(route + '&advertiser=New%20Advertiser&bd=New%20BD')).body.total, 1);
  assert.equal((await request(route + '&advertiser=Old%20Advertiser')).body.total, 0);
});
