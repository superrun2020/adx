import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchUnitTemplates, gamBrowserSizes, prepareGamUnitItems } from '../src/gam-unit-plan.mjs';

test('available browser sizes exclude mobile app sizes and duplicates', () => {
  const items = [
    { environmentType:'BROWSER', size:{ sizeType:'PIXEL', width:320, height:50 } },
    { environmentType:'BROWSER', size:{ sizeType:'PIXEL', width:320, height:50 } },
    { environmentType:'MOBILE_APP', size:{ sizeType:'PIXEL', width:300, height:250 } },
    { environmentType:'BROWSER', size:{ sizeType:'FLUID' } }
  ];
  assert.deepEqual(gamBrowserSizes(items), ['320x50', 'fluid']);
});

const siteName = 'networks/23375144983/sites/1';
const rows = () => batchUnitTemplates.map(({ type, bannerNo }) => ({
  type, bannerNo, sizes: ['300x250'], name: 'ignored-batch-name', code: 'ignored-batch-code'
}));
const options = (overrides = {}) => ({
  accountId: 1, siteNames: [siteName],
  sites: [{ name: siteName, url: 'https://dealscoutnest.com' }],
  domainChoices: { [siteName]: ['finance.dealscoutnest.com'] },
  rows: rows(), creationDate: '2026-11-04', ...overrides
});

test('batch creates the five screenshot names and matching codes', () => {
  const items = prepareGamUnitItems(options());
  const expected = ['banner1', 'banner2', 'banner3', 'INT', 'ANC']
    .map(suffix => `261104-finance.dealscoutnest.com-${suffix}`);
  assert.deepEqual(items.map(item => item.name), expected);
  assert.deepEqual(items.map(item => item.code), expected);
  assert.ok(items.every(item => item.domain === 'finance.dealscoutnest.com'));
});

test('changing only date and domain preserves all five suffixes', () => {
  const input = options({ creationDate: '2026-12-31',
    domainChoices: { [siteName]: ['news.dealscoutnest.com'] } });
  assert.deepEqual(prepareGamUnitItems(input).map(item => item.code),
    ['banner1', 'banner2', 'banner3', 'INT', 'ANC']
      .map(suffix => `261231-news.dealscoutnest.com-${suffix}`));
});

test('multiple selected subdomains generate one fixed set per domain', () => {
  const input = options({ domainChoices: { [siteName]:
    ['finance.dealscoutnest.com', 'news.dealscoutnest.com'] } });
  const items = prepareGamUnitItems(input);
  assert.equal(items.length, 10);
  assert.equal(new Set(items.map(item => item.code)).size, 10);
  assert.deepEqual(items.slice(5).map(item => item.code),
    ['banner1', 'banner2', 'banner3', 'INT', 'ANC']
      .map(suffix => `261104-news.dealscoutnest.com-${suffix}`));
});

test('rejects duplicate domains and invalid dates before submission', () => {
  assert.throws(() => prepareGamUnitItems(options({ domainChoices: { [siteName]:
    ['finance.dealscoutnest.com', 'finance.dealscoutnest.com'] } })), /同一域名/);
  assert.throws(() => prepareGamUnitItems(options({ creationDate: '2026-02-30' })), /命名日期无效/);
  assert.throws(() => prepareGamUnitItems(options({ creationDate: '' })), /请选择命名日期/);
});

test('batch cannot replace the fixed five templates', () => {
  const changed = rows();
  changed[3].type = 'banner';
  changed[3].bannerNo = 4;
  assert.throws(() => prepareGamUnitItems(options({ rows: changed })), /批量版位固定/);
});

test('single creation keeps an explicit name and code when provided', () => {
  const input = options({ single: true, rows: [{ type: 'banner', bannerNo: 1,
    sizes: ['300x250'], name: 'custom-name', code: 'custom-code' }] });
  const [item] = prepareGamUnitItems(input);
  assert.equal(item.name, 'custom-name');
  assert.equal(item.code, 'custom-code');
});
