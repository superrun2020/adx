import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGamAdUnit, createGamAdUnit, findGamAdUnitByCode, gamApiRequest, getGamAdUnit, getGamSite, listGamSites } from '../server/gam-beta.mjs';
import { buildReportDefinition, fetchRestReport, normalizeRestReportRows, setReportRange, validateReportDefinition } from '../server/gam-reports.mjs';
import { localDate } from '../server/gam-sync.mjs';

const network = '123456';
const parent = 'networks/123456/adUnits/9';

test('scheduled GAM dates follow each account timezone', () => {
  const instant = new Date('2026-11-04T01:30:00Z');
  assert.equal(localDate('America/Los_Angeles', 0, instant), '2026-11-03');
  assert.equal(localDate('America/Los_Angeles', -1, instant), '2026-11-02');
  assert.equal(localDate('Asia/Tokyo', 0, instant), '2026-11-04');
  assert.equal(localDate('Asia/Tokyo', -1, instant), '2026-11-03');
  assert.throws(() => localDate('', 0, instant), /invalid_network_timezone/);
});

test('GAM retries throttled reads but never duplicates writes', async () => {
  let reads = 0, writes = 0;
  const delays = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') { writes += 1; return json({ error: { message: 'throttled' } }, 429); }
    reads += 1;
    return reads === 1 ? json({ error: { message: 'throttled' } }, 429) : json({ name: 'networks/123456' });
  };
  const result = await gamApiRequest(network, 'token', 'networks/123456', {
    fetchImpl, sleep: async ms => { delays.push(ms); }
  });
  assert.equal(result.name, 'networks/123456');
  assert.equal(reads, 2);
  assert.deepEqual(delays, [250]);
  await assert.rejects(() => gamApiRequest(network, 'token', 'networks/123456/reports', {
    method: 'POST', body: {}, fetchImpl, sleep: async () => {}
  }), /gam_http_429/);
  assert.equal(writes, 1);
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

test('REST ad unit creation validates the plan and uses the v1 endpoint', async () => {
  const adUnit = buildGamAdUnit({ name: 'Banner', code: 'banner-300x250', size: '300x250', description: 'Site banner', adsense_enabled: 1, target_window: '_BLANK' }, network, parent);
  assert.equal(adUnit.parentAdUnit, parent);
  assert.deepEqual(adUnit.adUnitSizes[0].size, { width: 300, height: 250, sizeType: 'PIXEL' });
  assert.equal(adUnit.appliedAdsenseEnabled, true);
  assert.throws(() => buildGamAdUnit({ name: 'X', code: 'x', size: 'unsupported' }, network, parent), /unsupported_ad_unit_size/);
  assert.throws(() => buildGamAdUnit({ name: 'X', code: 'x', size: '300x250' }, network, 'networks/999999/adUnits/9'), /invalid_parent_ad_unit/);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: url.pathname, search: url.search, method: options.method, headers: options.headers, body: options.body });
    if (options.method === 'POST') return json({ name: 'networks/123456/adUnits/10' });
    if (url.searchParams.has('filter')) return json({ adUnits: [{ name: 'networks/123456/adUnits/10', adUnitCode: 'banner-300x250' }] });
    return json({ name: parent });
  };
  assert.equal((await getGamAdUnit(network, 'token', parent, fetchImpl)).name, parent);
  assert.equal((await findGamAdUnitByCode(network, 'token', 'banner-300x250', fetchImpl)).adUnitCode, 'banner-300x250');
  assert.equal((await createGamAdUnit(network, 'token', adUnit, fetchImpl)).name, 'networks/123456/adUnits/10');
  assert.equal(calls[2].path, '/v1/networks/123456/adUnits');
  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[2].body), adUnit);
});

test('GAM Sites stay within the selected network and template sizes map to REST types', async () => {
  const adUnit = buildGamAdUnit({ name: 'Interstitial', code: 'inter', sizes: [
    '1x1', 'out-of-page', 'native', 'fluid', '320x480'
  ] }, network, parent);
  assert.deepEqual(adUnit.adUnitSizes.map(item => item.size.sizeType),
    ['PIXEL', 'INTERSTITIAL', 'NATIVE', 'FLUID', 'PIXEL']);
  assert.throws(() => buildGamAdUnit({ name: 'X', code: 'x', sizes: ['300x250', '300×250'] }, network, parent), /duplicate_ad_unit_size/);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url.pathname + url.search);
    assert.equal(options.headers.Authorization, 'Bearer token');
    return url.pathname.endsWith('/sites') ? json({ sites: [{ name: 'networks/123456/sites/7', url: 'example.com' }] })
      : json({ name: 'networks/123456/sites/7', url: 'example.com' });
  };
  assert.equal((await listGamSites(network, 'token', {}, fetchImpl)).sites.length, 1);
  assert.equal((await getGamSite(network, 'token', 'networks/123456/sites/7', fetchImpl)).url, 'example.com');
  assert.deepEqual(calls, ['/v1/networks/123456/sites?pageSize=100', '/v1/networks/123456/sites/7']);
  assert.throws(() => getGamSite(network, 'token', 'networks/999999/sites/7', fetchImpl), /invalid_gam_site/);
});

test('REST report definition is fixed and mismatched columns fail closed', () => {
  const definition = buildReportDefinition('2026-10-30', '2026-10-31');
  assert.deepEqual(definition.dateRange.fixed.startDate, { year: 2026, month: 10, day: 30 });
  assert.equal(definition.currencyCode, 'USD');
  assert.equal(validateReportDefinition({ name: 'networks/123456/reports/42', reportDefinition: definition }, network), definition);
  assert.throws(() => validateReportDefinition({ name: 'networks/123456/reports/42', reportDefinition: { ...definition, metrics: ['AD_EXCHANGE_REVENUE'] } }, network), /mismatch/);
  assert.throws(() => buildReportDefinition('2026-11-02', '2026-10-31'), /invalid_report_range/);
});

test('REST report run polls and reads all result pages', async () => {
  const row = {
    dimensionValues: [
      { intValue: '20261031' }, { intValue: '13' }, { stringValue: 'example.com' },
      { stringValue: 'US' }, { stringValue: 'Banner' }
    ],
    metricValueGroups: [{ primaryValues: [
      { intValue: '100' }, { intValue: '90' }, { intValue: '80' }, { intValue: '2' }, { doubleValue: 1250000 }
    ] }]
  };
  const paths = [];
  const fetchImpl = async (url, options) => {
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith(':run')) return json({ name: 'networks/123456/operations/reports/runs/1', done: false });
    if (url.pathname.endsWith('/runs/1')) return json({ name: 'networks/123456/operations/reports/runs/1', done: true, response: { reportResult: 'networks/123456/reports/42/results/7' } });
    if (url.searchParams.get('pageToken') === 'next') return json({ rows: [row] });
    return json({ dateRanges: [{ startDate: { year: 2026, month: 10, day: 31 }, endDate: { year: 2026, month: 10, day: 31 } }], rows: [row], nextPageToken: 'next' });
  };
  const result = await fetchRestReport(network, 'token', 'networks/123456/reports/42', { fetchImpl, sleep: async () => {} });
  assert.equal(result.rows.length, 2);
  assert.equal(paths.length, 4);
  assert.match(paths[3], /pageToken=next/);
  const facts = normalizeRestReportRows(result.rows, { channelId: 1, accountKey: 'upstream-a', sourceFile: 'test', moneyDivisor: 1000000 });
  assert.equal(facts[0].revenue, 1.25);
  assert.equal(facts[0].reportDate, '2026-10-31');
  assert.equal(facts[0].hour, 13);
  assert.equal(facts[0].requests, 100);
  assert.throws(() => normalizeRestReportRows([{ ...row, metricValueGroups: [] }], { channelId: 1, accountKey: 'upstream-a', sourceFile: 'test', moneyDivisor: 1 }), /columns_mismatch/);
  const six = { ...row, dimensionValues: [...row.dimensionValues, { stringValue:'unit-99' }] };
  assert.equal(normalizeRestReportRows([six], { channelId:1, accountKey:'upstream-a', sourceFile:'test', moneyDivisor:1000000 })[0].adUnitId, 'unit-99');
});

test('immutable legacy report is replaced with six-dimensional REST report', async () => {
  const old = { name:'networks/123456/reports/42', reportDefinition:{
    ...buildReportDefinition('2026-10-30','2026-10-31'), dimensions:['DATE','HOUR','SITE','COUNTRY_CODE','AD_UNIT_NAME']
  } };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') return json(old);
    if (options.method === 'PATCH') return json({ error:{ message:'Definition is immutable' } },400);
    if (options.method === 'POST') return json({ name:'networks/123456/reports/43',
      reportDefinition:buildReportDefinition('2026-11-01','2026-11-02') });
    throw new Error('unexpected_method');
  };
  const updated = await setReportRange(network,'token',old.name,'2026-11-01','2026-11-02',fetchImpl);
  assert.equal(updated.name,'networks/123456/reports/43');
  assert.equal(updated.reportDefinition.dimensions.length,6);
  assert.deepEqual(calls,['GET','PATCH','POST']);
});
