import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { registerGamRoutes } from '../server/gam-routes.mjs';
import { allowedAdminRequest } from '../server/admin-permissions.mjs';
import { normalizeGamFactSite } from '../server/gam-sync.mjs';

const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,status TEXT,enabled INTEGER NOT NULL DEFAULT 1,account_email TEXT,advertiser_share_percent REAL,notes TEXT,rest_channel_id INTEGER,rest_network_timezone TEXT DEFAULT "UTC");' +
  'CREATE TABLE revenue_facts(url TEXT,domain TEXT,ad_unit TEXT,source_file TEXT,raw_json TEXT DEFAULT \'{}\');' +
  'CREATE TABLE gam_ad_unit_creations(' +
  'id INTEGER PRIMARY KEY,gam_account_id INTEGER,network_code TEXT,site_name TEXT,site_url TEXT,domain TEXT,' +
  'parent_ad_unit TEXT,display_name TEXT,ad_unit_code TEXT COLLATE NOCASE,sizes_json TEXT,description TEXT,' +
  "adsense_enabled INTEGER,target_window TEXT,status TEXT DEFAULT 'planned',provider_id TEXT,publish_error TEXT DEFAULT ''," +
  'created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,published_at TEXT,UNIQUE(network_code,ad_unit_code));'
);
db.prepare("INSERT INTO soap_accounts(id,name,network_code,status) VALUES(1,'A','123456','active')").run();
db.prepare("INSERT INTO soap_accounts(id,name,network_code,status) VALUES(2,'B','999999','active')").run();
db.prepare("UPDATE soap_accounts SET account_email='private@example.test',advertiser_share_percent=65,notes='private note' WHERE id=1").run();
for (const [url, adUnit, source, reportSite = ''] of [
  ['news.123456.example.com', '261104-news.example.com-banner1', 'gam-rest:123456:2026-11-01_2026-11-01', 'https://news.123456.example.com'],
  ['sports.123456.example.com', '261104-sports.example.com-INT', 'gam-rest:123456:2026-11-01_2026-11-01', 'https://sports.123456.example.com'],
  ['shop.999999.example.com', '261104-shop.example.com-banner1', 'gam-rest:999999:2026-11-01_2026-11-01', 'https://shop.999999.example.com'],
  ['fake.123456.example.com', 'Manual import', 'manual-import'],
  ['leak.123456.example.com', 'Wrong network', 'gam-rest:1234567:2026-11-01_2026-11-01'],
  // Historical rows might have copied the ad-unit name into url without SITE provenance.
  ['261104-finance.example.com', '261104-finance.example.com-banner1', 'gam-rest:123456:2026-11-01_2026-11-01'],
  // A fact whose url differs from its original SITE value is not a domain source.
  ['261104-sports.example.com', '261104-sports.example.com-banner1', 'gam-rest:123456:2026-11-01_2026-11-01', 'https://sports.123456.example.com']
]) {
  const rawJson = reportSite ? JSON.stringify({ dimensionValues: [
    { stringValue: '20261101' }, { intValue: '13' }, { stringValue: reportSite }
  ] }) : '{}';
  db.prepare('INSERT INTO revenue_facts(url,domain,ad_unit,source_file,raw_json) VALUES(?,?,?,?,?)').run(url, url, adUnit, source, rawJson);
}
db.prepare("INSERT INTO gam_ad_unit_creations(gam_account_id,network_code,site_name,site_url,domain,parent_ad_unit,display_name,ad_unit_code,sizes_json,created_by) VALUES(1,'123456','networks/123456/sites/1','https://example.com','creation-only.example.com','networks/123456/adUnits/9','Manual','manual','[]','test')").run();

const app = express();
app.use(express.json());
const auth = (req, _res, next) => { req.user = { email: 'admin@example.test', role: 'admin', sidebar_permissions: '["links"]' }; next(); };
registerGamRoutes(app, { db, requireAuth: auth, requireAdmin: (_req, _res, next) => next(),
  tokenFor: async () => 'test-token', audit: () => {}, gamSync: {}, encryptCredential: () => '' });

const realFetch = globalThis.fetch;
const remoteUnits = new Map();
const posts = [];
const patches = [], archives = [];
const listFilters = [];
let server, base, failAfterCreate = false;
const response = (payload, status = 200) => new Response(JSON.stringify(payload),
  { status, headers: { 'Content-Type': 'application/json' } });

test('GAM facts never infer a site domain from an ad-unit name', () => {
  const normalize = value => {
    try { return new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value).hostname.toLowerCase(); }
    catch { return ''; }
  };
  const inferred = normalizeGamFactSite({ url: '', adUnit: '261104-news.example.com-banner1' }, normalize);
  assert.equal(inferred.url, '');
  assert.equal(inferred.domain, '');
  const site = normalizeGamFactSite({ url: 'https://news.example.com/path', adUnit: 'banner1' }, normalize);
  assert.equal(site.domain, 'news.example.com');
});

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
    if (path === 'adUnitSizes') return response({ adUnitSizes: [
      { name:'networks/' + network + '/adUnitSizes/1', environmentType:'BROWSER', size:{sizeType:'PIXEL',width:320,height:50} }
    ] });
    if (path === 'adUnits/9') return response({ name: 'networks/' + network + '/adUnits/9' });
    if (path === 'adUnits:batchArchive' && options.method === 'POST') {
      const { names } = JSON.parse(options.body);
      archives.push(names);
      for (const unit of remoteUnits.values()) if (names.includes(unit.name)) unit.status = 'ARCHIVED';
      return response({});
    }
    if (path.startsWith('adUnits/') && options.method === 'PATCH') {
      const unit = [...remoteUnits.values()].find(value => value.name === 'networks/' + network + '/' + path);
      if (!unit) return response({ error: { message:'not found' } }, 404);
      const body = JSON.parse(options.body);
      patches.push({ name: unit.name, mask: url.searchParams.get('updateMask'), body });
      Object.assign(unit, body);
      return response(unit);
    }
    if (path.startsWith('adUnits/') && (!options.method || options.method === 'GET')) {
      const unit = [...remoteUnits.values()].find(value => value.name === 'networks/' + network + '/' + path);
      return unit ? response(unit) : response({ error: { message:'not found' } }, 404);
    }
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
      if (filter?.startsWith('displayName = ') && !filter.includes(' AND ')) {
        const name = JSON.parse(filter.slice('displayName = '.length));
        return response({ adUnits: [...remoteUnits.values()].filter(unit => unit.name.startsWith('networks/' + network + '/') && unit.displayName.toLowerCase() === name.toLowerCase()) });
      }
      if (filter) {
        listFilters.push(filter);
        return response({ adUnits: [...remoteUnits.values()].filter(unit => unit.name.startsWith('networks/' + network + '/') &&
          (filter !== 'status = ARCHIVED' || unit.status === 'ARCHIVED')) });
      }
      return response({ adUnits: [...remoteUnits.values()].filter(unit => unit.name.startsWith('networks/' + network + '/')) });
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

test('site domains are drawn from the selected account only', async () => {
  const first = await request('/api/admin/gam-accounts/1/site-domains');
  const second = await request('/api/admin/gam-accounts/2/site-domains');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body.items, ['news.123456.example.com', 'sports.123456.example.com']);
  assert.deepEqual(second.body.items, ['shop.999999.example.com']);
});

test('available ad unit sizes use the selected GAM network', async () => {
  const first = await request('/api/admin/gam-accounts/1/ad-unit-sizes');
  const second = await request('/api/admin/gam-accounts/2/ad-unit-sizes');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.items[0].name, 'networks/123456/adUnitSizes/1');
  assert.equal(second.body.items[0].name, 'networks/999999/adUnitSizes/1');
});

test('links-only administrator receives discovery fields without private account metadata', async () => {
  const result = await request('/api/admin/gam-accounts');
  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].networkCode, '999999');
  const account = result.body.items.find(item => item.id === 1);
  assert.equal(account.accountEmail, undefined);
  assert.equal(account.advertiserSharePercent, undefined);
  assert.equal(account.notes, undefined);
});

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
  const child = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, domain: 'https://news.123456.example.com/path',
    name: 'Child Banner', code: 'child-banner', size: '300x250' });
  assert.equal(child.status, 201);
  assert.equal(child.body.item.domain, 'news.123456.example.com');
  const existingCode = 'existing-in-gam';
  const existingName = 'Existing in GAM';
  const existingResource = 'networks/123456/adUnits/999';
  remoteUnits.set('123456/' + existingCode, { name: existingResource, parentAdUnit: parent,
    displayName: existingName, adUnitCode: existingCode, adUnitSizes: [
      { size: { width: 300, height: 250, sizeType: 'PIXEL' }, environmentType: 'BROWSER' }
    ] });
  const postsBeforeLink = posts.length;
  const linked = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, domain: 'news.123456.example.com', name: existingName, code: existingCode, size: '300x250' });
  assert.equal(linked.status, 409);
  assert.equal(linked.body.error, 'ad_unit_already_exists_in_gam');
  assert.equal(posts.length, postsBeforeLink);
  const remoteName = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, name: existingName.toLowerCase(), code: 'new-code-for-existing-name', size: '300x250' });
  assert.equal(remoteName.status, 409);
  assert.equal(remoteName.body.error, 'ad_unit_name_already_exists_in_gam');
  const localName = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, name: 'banner a', code: 'new-code-for-local-name', size: '300x250' });
  assert.equal(localName.status, 409);
  assert.equal(localName.body.error, 'ad_unit_name_already_created');
  const localCode = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, name: 'new name for local code', code: 'BANNER-A', size: '300x250' });
  assert.equal(localCode.status, 409);
  assert.equal(localCode.body.error, 'ad_unit_already_created');
  const duplicateNamesInBatch = await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1, items: [
    { siteName: site, name: 'Repeated', code: 'unique-one', size: '300x250' },
    { siteName: site, name: 'repeated', code: 'unique-two', size: '300x250' }
  ] });
  assert.equal(duplicateNamesInBatch.status, 400);
  assert.equal(duplicateNamesInBatch.body.error, 'duplicate_ad_unit_name');
  assert.equal(posts.length, postsBeforeLink);
  remoteUnits.set('123456/conflicting-in-gam', { name: 'networks/123456/adUnits/1000',
    parentAdUnit: parent, displayName: 'Different name', adUnitCode: 'conflicting-in-gam',
    adUnitSizes: [{ size: { width: 300, height: 250, sizeType: 'PIXEL' }, environmentType: 'BROWSER' }] });
  const conflict = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, name: 'Requested name', code: 'conflicting-in-gam', size: '300x250' });
  assert.equal(conflict.status, 409);
  assert.equal(posts.length, postsBeforeLink);
  const beforeInvalid = posts.length;
  const external = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, domain: 'other.example.com', name: 'External', code: 'external', size: '300x250' });
  assert.equal(external.status, 400);
  assert.equal(posts.length, beforeInvalid);
  const deceptive = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, domain: '123456.example.com.other.net', name: 'Deceptive', code: 'deceptive', size: '300x250' });
  assert.equal(deceptive.status, 400);
  assert.equal(posts.length, beforeInvalid);
  const listing = await request('/api/admin/gam-accounts/1/ad-units?search=Banner&statuses=ACTIVE,INACTIVE');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.items[0].adUnitSizes.length, 2);
  assert.equal(listFilters.at(-1), 'displayName = "*Banner*" AND status != ARCHIVED');
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units?statuses=INVALID')).status, 400);
  assert.equal((await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1, items: Array(101).fill({}) })).status, 400);

  const duplicate = await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1,
    items: [{ siteName: site, name: 'Banner A', code: 'banner-a', sizes: ['300x250'] }] });
  assert.equal(duplicate.body.failed, 1);
  assert.equal(posts.length, beforeInvalid);
  const wrongSite = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 2,
    siteName: site, name: 'Wrong', code: 'wrong', size: '300x250' });
  assert.equal(wrongSite.status, 400);
  assert.equal(posts.length, beforeInvalid);
  const nested = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, parentAdUnit: 'networks/123456/adUnits/8', name: 'Nested', code: 'nested', size: '300x250' });
  assert.equal(nested.status, 400);
  assert.equal(posts.length, beforeInvalid);

  const other = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 2,
    siteName: 'networks/999999/sites/1',
    name: 'Banner A', code: 'banner-a', sizes: ['300x250'] });
  assert.equal(other.status, 201);
  assert.equal(other.body.item.networkCode, '999999');

  failAfterCreate = true;
  const failed = await request('/api/admin/gam-ad-units', 'POST', { gamAccountId: 1,
    siteName: site, domain: 'retry.123456.example.com', name: 'Flaky', code: 'flaky', sizes: ['320x50'] });
  assert.equal(failed.status, 502);
  const listed = await request('/api/admin/gam-ad-units');
  const row = listed.body.items.find(item => item.adUnitCode === 'flaky');
  assert.equal(row.status, 'failed');
  assert.equal(row.domain, 'retry.123456.example.com');
  const postsBeforeRetry = posts.length;
  const retried = await request('/api/admin/gam-ad-units/' + row.id + '/retry', 'POST');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.item.status, 'created');
  assert.equal(retried.body.item.domain, 'retry.123456.example.com');
  assert.equal(posts.length, postsBeforeRetry);
});

test('existing GAM units can be edited and archived, with immutable codes and account isolation', async () => {
  const name = 'networks/123456/adUnits/777';
  remoteUnits.set('123456/editable', { name, parentAdUnit:'networks/123456/adUnits/9',
    displayName:'Original name', adUnitCode:'editable', status:'ACTIVE', description:'Before',
    adUnitSizes:[
      { environmentType:'BROWSER', size:{ sizeType:'PIXEL', width:320, height:50 } },
      { environmentType:'VIDEO_PLAYER', size:{ sizeType:'PIXEL', width:640, height:360 } }
    ] });
  const detail = await request('/api/admin/gam-accounts/1/ad-units/777');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.item.adUnitCode, 'editable');
  const edited = await request('/api/admin/gam-accounts/1/ad-units/777', 'PATCH', {
    displayName:'Updated name', description:'After', sizes:['300x250']
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.displayName, 'Updated name');
  assert.equal(edited.body.item.adUnitSizes.length, 2);
  assert.equal(edited.body.item.adUnitSizes[1].environmentType, 'VIDEO_PLAYER');
  assert.equal(patches.at(-1).mask, 'displayName,description,adUnitSizes');
  assert.equal(patches.at(-1).body.adUnitCode, undefined);
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units/777', 'PATCH', { adUnitCode:'renamed' })).status, 400);
  assert.equal((await request('/api/admin/gam-accounts/2/ad-units/777', 'PATCH', { displayName:'Wrong network' })).status, 502);
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units/batch-archive', 'POST',
    { names:['networks/999999/adUnits/777'] })).status, 400);
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units/batch-archive', 'POST',
    { names:['networks/123456/adUnits/9'] })).status, 400);
  const archived = await request('/api/admin/gam-accounts/1/ad-units/batch-archive', 'POST', { names:[name] });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.archived, 1);
  assert.deepEqual(archives.at(-1), [name]);
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units?statuses=ARCHIVED')).body.items.find(unit => unit.name === name).status, 'ARCHIVED');
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units')).body.items.find(unit => unit.name === name).status, 'ARCHIVED');
  assert.equal((await request('/api/admin/gam-accounts/1/ad-units/777', 'PATCH', { displayName:'Again' })).status, 400);
});

test('ad-unit edits and archive require the ad-unit sidebar permission', () => {
  const detail = '/api/admin/gam-accounts/1/ad-units/777';
  const archive = '/api/admin/gam-accounts/1/ad-units/batch-archive';
  const gamOnly = { role:'admin', sidebar_permissions:'["gam"]' };
  const unitsOnly = { role:'admin', sidebar_permissions:'["ad-units"]' };
  assert.equal(allowedAdminRequest(gamOnly, detail, 'GET'), true);
  assert.equal(allowedAdminRequest(gamOnly, detail, 'PATCH'), false);
  assert.equal(allowedAdminRequest(gamOnly, archive, 'POST'), false);
  assert.equal(allowedAdminRequest(unitsOnly, detail, 'PATCH'), true);
  assert.equal(allowedAdminRequest(unitsOnly, archive, 'POST'), true);
});

test('disabled account cannot create or retry GAM ad units', async () => {
  db.prepare('UPDATE soap_accounts SET enabled=0 WHERE id=1').run();
  try {
    const before = posts.length;
    const input = { gamAccountId: 1, siteName: 'networks/123456/sites/1', name: 'Blocked', code: 'blocked', size: '300x250' };
    assert.equal((await request('/api/admin/gam-ad-units', 'POST', input)).status, 400);
    assert.equal((await request('/api/admin/gam-ad-units/batch', 'POST', { gamAccountId: 1, items: [input] })).status, 400);
    assert.equal(posts.length, before);
  } finally {
    db.prepare('UPDATE soap_accounts SET enabled=1 WHERE id=1').run();
  }
});
