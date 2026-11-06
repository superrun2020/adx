import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { registerGamRoutes } from '../server/gam-routes.mjs';
import { allowedAdminRequest } from '../server/admin-permissions.mjs';

const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,status TEXT);' +
  'CREATE TABLE channels(id INTEGER PRIMARY KEY,name TEXT,status TEXT);' +
  'CREATE TABLE channel_domains(channel_id INTEGER,domain TEXT);' +
  "CREATE TABLE link_metadata(network_code TEXT,domain TEXT COLLATE NOCASE,is_manual INTEGER DEFAULT 0,monitor_domains_json TEXT DEFAULT '[]',channel_id INTEGER,notes TEXT DEFAULT '',updated_by TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(network_code,domain));"
);
db.exec("INSERT INTO soap_accounts VALUES(1,'First','123456','active'),(2,'Second','999999','active');");
db.exec("INSERT INTO channels VALUES(7,'Channel A','active'),(8,'Channel B','disabled');");
db.exec("INSERT INTO channel_domains VALUES(7,'example.com');");

const app = express();
app.use(express.json());
const user = { email: 'links@example.test', role: 'admin', sidebar_permissions: '["links"]' };
const auth = (req, _res, next) => { req.user = user; next(); };
const authorize = (req, res, next) => allowedAdminRequest(req.user, req.path, req.method)
  ? next() : res.status(403).json({ ok: false, error: 'forbidden' });
registerGamRoutes(app, { db, requireAuth: auth, requireAdmin: authorize,
  tokenFor: async () => 'test-token', audit: () => {}, gamSync: {}, encryptCredential: () => '' });

const realFetch = globalThis.fetch;
let server, base;
const response = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });

before(async () => {
  globalThis.fetch = async target => {
    const url = new URL(target);
    if (url.hostname !== 'admanager.googleapis.com') return realFetch(target);
    if (url.pathname === '/v1/networks/123456/sites/1') return response({
      name: 'networks/123456/sites/1', url: 'https://example.com' });
    return response({ error: { message: 'missing' } }, 404);
  };
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  db.close();
});

async function request(path, method = 'GET', body) {
  const result = await realFetch(base + path, { method,
    headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: result.status, body: await result.json() };
}

test('links-only role can list channels and create a scoped local subdomain', async () => {
  const initial = await request('/api/admin/link-metadata');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.channels.map(item => item.id), [7]);
  assert.deepEqual(initial.body.assignments.map(item => item.domain), ['example.com']);
  const created = await request('/api/admin/link-metadata', 'POST', {
    gamAccountId: 1, domain: 'https://news.example.com/path',
    monitorDomains: ['example.com', 'example.com'], channelId: 7, notes: 'local link'
  });
  assert.equal(created.status, 201);
  const items = (await request('/api/admin/link-metadata')).body.items;
  assert.deepEqual(items.map(item => item.domain), ['example.com', 'news.example.com']);
  assert.equal(items[1].networkCode, '123456');
  assert.equal(items[1].monitorDomainsJson, '["example.com"]');
  assert.equal(items[1].channelName, 'Channel A');
  assert.equal((await request('/api/admin/link-metadata', 'POST', { gamAccountId: 1, domain: 'news.example.com' })).status, 409);
  assert.equal((await request('/api/admin/link-metadata', 'POST', { gamAccountId: 1, domain: 'bad host' })).status, 400);
  assert.equal((await request('/api/admin/link-metadata', 'POST', { gamAccountId: 1, domain: 'other.com', channelId: 8 })).status, 400);
});

test('manual link can be edited and reassigned without changing a GAM site', async () => {
  const changed = await request('/api/admin/link-metadata', 'PUT', {
    originalNetworkCode: '123456', originalDomain: 'news.example.com',
    gamAccountId: 2, domain: 'blog.example.com', monitorDomains: ['blog.example.com'], notes: 'moved'
  });
  assert.equal(changed.status, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM link_metadata WHERE network_code='123456' AND domain='news.example.com'").get().n, 0);
  assert.equal(db.prepare("SELECT notes FROM link_metadata WHERE network_code='999999' AND domain='blog.example.com'").get().notes, 'moved');
  const duplicate = await request('/api/admin/link-metadata', 'PUT', {
    originalNetworkCode: '999999', originalDomain: 'blog.example.com',
    gamAccountId: 1, domain: 'example.com'
  });
  assert.equal(duplicate.status, 409);
});

test('GAM site edit updates only local metadata after remote identity verification', async () => {
  const body = { originalNetworkCode: '123456', originalDomain: 'example.com',
    gamAccountId: 1, domain: 'example.com', siteName: 'networks/123456/sites/1',
    monitorDomains: ['example.com'], channelId: 7, notes: 'real site' };
  assert.equal((await request('/api/admin/link-metadata', 'PUT', body)).status, 200);
  const row = db.prepare("SELECT is_manual isManual,notes FROM link_metadata WHERE network_code='123456' AND domain='example.com'").get();
  assert.equal(row.isManual, 0);
  assert.equal(row.notes, 'real site');
  assert.equal((await request('/api/admin/link-metadata', 'PUT', { ...body, domain: 'other.com' })).status, 400);
  assert.equal((await request('/api/admin/link-metadata', 'PUT', { ...body, siteName: 'networks/999999/sites/1' })).status, 400);
});
