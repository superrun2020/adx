import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGamUnitItems } from '../src/gam-unit-plan.mjs';

const siteName = 'networks/23375144983/sites/1';
const options = rows => ({ accountId: 1, siteNames: [siteName],
  sites: [{ name: siteName, url: 'https://nextvisiona.com' }],
  domainChoices: { [siteName]: ['news.nextvisiona.com'] }, rows });
const row = (type, bannerNo, code, name = '') => ({ type, bannerNo, code, name, sizes: ['300x250'] });

test('repeated batch prefixes become distinct GAM codes and names', () => {
  const prefix = '23375144983-news.nextvisiona.com';
  const rows = [row('banner', 1, prefix, prefix), row('banner', 2, prefix, prefix),
    row('banner', 3, prefix, prefix), row('interstitial', 1, prefix, prefix), row('anchor', 1, prefix, prefix)];
  const items = prepareGamUnitItems(options(rows));
  assert.deepEqual(items.map(item => item.code), [prefix + '-banner1', prefix + '-banner2',
    prefix + '-banner3', prefix + '-INT', prefix + '-ANC']);
  assert.equal(new Set(items.map(item => item.name)).size, 5);
  assert.ok(items.every(item => item.domain === 'news.nextvisiona.com'));
});

test('unique explicit codes stay exact; suffix collisions receive a sequence', () => {
  const rows = [row('banner', 1, 'prefix'), row('banner', 1, 'prefix'),
    row('anchor', 1, 'prefix-banner1'), row('interstitial', 1, 'distinct')];
  const items = prepareGamUnitItems(options(rows));
  assert.deepEqual(items.map(item => item.code), ['prefix-banner1-2', 'prefix-banner1-3',
    'prefix-banner1', 'distinct']);
});

test('long repeated prefixes fit the GAM code limit', () => {
  const items = prepareGamUnitItems(options([row('banner', 1, 'x'.repeat(120)), row('banner', 2, 'x'.repeat(120))]));
  assert.equal(items[0].code.length, 120);
  assert.equal(items[1].code.length, 120);
  assert.notEqual(items[0].code, items[1].code);
});

test('repeated default banner numbers receive numeric suffixes', () => {
  const inputs = options([row('banner', 1, ''), row('banner', 1, '')]);
  const items = prepareGamUnitItems(inputs);
  assert.deepEqual(items.map(item => item.code),
    ['news.nextvisiona.com-banner1-2', 'news.nextvisiona.com-banner1-3']);
});

test('multiple sites still require a domain placeholder for a custom code', () => {
  const inputs = options([row('banner', 1, 'prefix')]);
  inputs.domainChoices[siteName] = ['news.nextvisiona.com', 'finance.nextvisiona.com'];
  assert.throws(() => prepareGamUnitItems(inputs), /多网站自定义代码请包含/);
  inputs.rows[0].code = '{domain}-banner1';
  assert.deepEqual(prepareGamUnitItems(inputs).map(item => item.code),
    ['news.nextvisiona.com-banner1', 'finance.nextvisiona.com-banner1']);
});
