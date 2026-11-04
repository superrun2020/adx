import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { registerGamRoutes } from '../server/gam-routes.mjs';

const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,status TEXT);' +
  'CREATE TABLE gam_ad_unit_creations(' +
  'id INTEGER PRIMARY KEY,gam_account_id INTEGER,network_code TEXT,site_name TEXT,site_url TEXT,domain TEXT,' +
  'parent_ad_unit TEXT,display_name TEXT,ad_unit_code TEXT COLLATE NOCASE,sizes_json TEXT,description TEXT,' +
  "adsense_enabled INTEGER,target_window TEXT,status TEXT DEFAULT 'planned',provider_id TEXT,publish_error TEXT DEFAULT ''," +
  'created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,published_at TEXT,UNIQUE(network_code,ad_unit_code));'
);
db.prepare("INSERT INTO soap_accounts(id,name,network_code,status) VALUES(1,'A','123456','active')").run();
db.prepare("INSERT INTO soap_accounts(id,name,network_code,status) VALUES(2,'B','999999','active')").run();

const app = express();
app.use(express.json());
const auth = (req, _res, next) => { req.user = { email: 'admin@example.test' }; next(); };
registerGamRoutes(app, { db, requireAuth: auth, requireAdmin: (_req, _res, next) => next(),
  tokenFor: async () => 'test-token', audit: () => {}, gamSync: {}, encryptCredential: () => '' });

const realFetch = globalThis.fetch;
const remoteUnits = new Map();
const posts = [];
const listFilters = [];
let server, base, failAfterCreate = false;
const response = (payload, status = 200) => new Response(JSON.stringify(payload),
  { status, headers: { 'Content-Type': 'application/json' } });

before(async () => {
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname !== 'admanager.googleapis.com') return realFetch(target, options);
    const network = url.pathname.split('/')[3];
    const path = url.pathname.split('/').slice(4).join('/');
    if (path === '') return response({ name: 'networks/' + network,
      effectiveRootAdUnit: 'networks/' + network + '/adUnits/9' });
    if (path === 'sites') return response({ sites: [
      { name: 'networks/' + network + '/sites/1', url: 'https://' + network + '.example.com', approvalStatus: 'APPROVED' }
    ] });
    if (path === 'sites/1') return response({ name: 'networks/' + network + '/sites/1', url: 'https://' + network + '.example.com' });
    if (path === 'adUnits/9') return response({ name: 'networks/' + network + '/adUnits/9' });
    if (path === 'adUnits' && options.method === 'POST') {
      const unit = JSON.parse(options.body);
      posts.push({ network, unit });
      const created = { ...unit, name: 'networks/' + network + '/adUnits/' + (10 + posts.length) };
      remoteUnits.set(network + '/' + unit.adUnitCode, created);
      if (unit.adUnitCode === 'flaky' && failAfterCreate) {
        failAfterCreate = false;
        return response({ error: { message: 'temporary failure after create' } }, 503);
      }
      return response(created);
    }
    if (path === 'adUnits') {
      const filter = url.searchParams.get('filter');
      if (filter?.startsWith('adUnitCode = ')) {
        const code = JSON.parse(filter.slice('adUnitCode = '.length));
        return response({ adUnits: remoteUnits.has(network + '/' + code) ? [remoteUnits.get(network + '/' + code)] : [] });
      }
      if (filter) {
        listFilters.push(filter);
        return response({ adUnits: [...remoteUnits.values()].filter(unit => unit.name.startsWith('networks/' + network + '/')) });
      }
      return response({ adUnits: [{ name: 'networks/' + network + '/adUnits/9', displayName: 'Root' }] });
    }
    throw new Error('unexpected GAM request: ' + url.pathname);
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

test('batch creates real REST resources, isolates networks, and reconciles a failed response', async () => {
  const sites = await request('/api/admin/gam-accounts/1/sites');
  assert.equal(sites.status, 200);
  assert.equal(sites.body.items[0].url, 'https://123456.example.com');
  const parent = 'networks/123456/adUnits/9', site = 'networks/123456/sites/1';
  const batch = await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1, items: [
    { siteName: site, name: 'Banner A', code: 'banner-a', sizes: ['300x250', '336x280'] },
    { siteName: site, name: 'Inter', code: 'inter', sizes: ['out-of-page', 'fluid'] }
  ] });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.created, 2);
  assert.equal(batch.body.failed, 0);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].unit.parentAdUnit, parent);
  assert.equal(posts[1].unit.parentAdUnit, parent);
  assert.deepEqual(posts[0].unit.adUnitSizes.map(item => item.size.sizeType), ['PIXEL', 'PIXEL']);
  assert.deepEqual(posts[1].unit.adUnitSizes.map(item => item.size.sizeType), ['INTERSTITIAL', 'FLUID']);
  assert.equal(batch.body.results[0].item.domain, '123456.example.com');
  const listing = await request('/api/admin/gam-accounts/1/ad-units?search=Banner&statuses=ACTIVE,INACTIVE');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.items[0].adUnitSizes.length, 2);
  assert.equal(listFilters.at(-1), 'displayName = "*Banner*" AND status != ARCHIVED');
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units?statuses=INVALID')).status, 400);
  assert.equal((await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1, items: Array(101).fill({}) })).status, 400);

  const duplicate = await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1,
    items: [{ siteName: site, name: 'Banner A', code: 'banner-a', sizes: ['300x250'] }] });
  assert.equal(duplicate.body.failed, 1);
  assert.equal(posts.length, 2);
  const wrongSite = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 2,
    siteName: site, name: 'Wrong', code: 'wrong', size: '300x250' });
  assert.equal(wrongSite.status, 400);
  assert.equal(posts.length, 2);
  const nested = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, parentAdUnit: 'networks/123456/adUnits/8', name: 'Nested', code: 'nested', size: '300x250' });
  assert.equal(nested.status, 400);
  assert.equal(posts.length, 2);

  const other = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 2,
    siteName: 'networks/999999/sites/1',
    name: 'Banner A', code: 'banner-a', sizes: ['300x250'] });
  assert.equal(other.status, 201);
  assert.equal(other.body.item.networkCode, '999999');

  failAfterCreate = true;
  const failed = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, name: 'Flaky', code: 'flaky', sizes: ['320x50'] });
  assert.equal(failed.status, 502);
  const listed = await request('/api/admin/gam-ad-units');
  const row = listed.body.items.find(item => item.adUnitCode === 'flaky');
  assert.equal(row.status, 'failed');
  const postsBeforeRetry = posts.length;
  const retried = await request('/api/admin/gam-ad-units/' + row.id + '/retry', 'POST');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.item.status, 'created');
  assert.equal(posts.length, postsBeforeRetry);
});
