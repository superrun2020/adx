import test from 'node:test';
import assert from 'node:assert/strict';
import { domainInUnit, indexCreationRecords, mainDomainOf, resolveAdUnitDomain,
  activatableSubdomainUnit, archivableSubdomainUnit, bulkUnitSignature, parseSubdomainLines,
  scanGamUnits, unitActionBatches } from '../src/gam-unit-domains.mjs';

const unit = (code, name = code, status = 'ACTIVE') => ({
  name: 'networks/123/adUnits/9', networkCode: '123', adUnitCode: code,
  displayName: name, status, parentAdUnit: 'networks/123/adUnits/1', accountEnabled: true
});

test('extracts exact website from legacy and generated GAM codes', () => {
  assert.equal(domainInUnit('at_c1_aut_lb-news.youxiglobal.xyz_inst'), 'news.youxiglobal.xyz');
  assert.equal(domainInUnit('261104-news.youxiglobal.xyz-banner1'), 'news.youxiglobal.xyz');
  assert.equal(mainDomainOf('news.youxiglobal.xyz'), 'youxiglobal.xyz');
  assert.equal(mainDomainOf('news.example.co.uk'), 'example.co.uk');
  assert.equal(mainDomainOf('news.example.invalid'), 'example.invalid');
  assert.equal(mainDomainOf('deep.news.example.com'), 'example.com');
  assert.equal(mainDomainOf('news.example.github.io'), 'example.github.io');
});

test('matches only the complete subdomain and excludes main, similar and archived units', () => {
  const target = 'news.youxiglobal.xyz';
  assert.equal(archivableSubdomainUnit(unit('at_c1_aut_lb-news.youxiglobal.xyz_inst'), target), true);
  assert.equal(archivableSubdomainUnit(unit('261104-youxiglobal.xyz-INT'), target), false);
  assert.equal(archivableSubdomainUnit(unit('at_c1_aut_lb-anews.youxiglobal.xyz_inst'), target), false);
  assert.equal(archivableSubdomainUnit(unit('at_c1_aut_lb-news.youxiglobal.xyz.evil.net_inst'), target), false);
  assert.equal(archivableSubdomainUnit(unit('at_c1_aut_lb-news.youxiglobal.xyz_inst', undefined, 'ARCHIVED'), target), false);
  assert.equal(archivableSubdomainUnit({ ...unit('at_c1_aut_lb-news.youxiglobal.xyz_inst'), parentAdUnit: '' }, target), false);
  assert.equal(archivableSubdomainUnit(unit('at_c1_aut_lb-news.youxiglobal.xyz_inst'), new Set([target, 'finance.youxiglobal.xyz'])), true);
});

test('bulk activation matches only exact subdomain units that GAM can reactivate', () => {
  const target = new Set(['news.youxiglobal.xyz', 'finance.youxiglobal.xyz']);
  assert.equal(activatableSubdomainUnit(unit('261104-news.youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), target), true);
  assert.equal(activatableSubdomainUnit(unit('261104-finance.youxiglobal.xyz-ANC', undefined, 'INACTIVE'), target), true);
  assert.equal(activatableSubdomainUnit(unit('261104-news.youxiglobal.xyz-banner1', undefined, 'ACTIVE'), target), false);
  assert.equal(activatableSubdomainUnit(unit('261104-youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), target), false);
  assert.equal(activatableSubdomainUnit(unit('261104-anews.youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), target), false);
  assert.equal(activatableSubdomainUnit({ ...unit('261104-news.youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), parentAdUnit: '' }, target), false);
  assert.equal(activatableSubdomainUnit({ ...unit('261104-news.youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), accountEnabled: false }, target), false);
  const record = { networkCode: '123', providerId: 'networks/123/adUnits/9', status: 'created',
    domain: 'finance.youxiglobal.xyz', siteUrl: 'https://youxiglobal.xyz' };
  assert.equal(activatableSubdomainUnit(unit('261104-news.youxiglobal.xyz-banner1', undefined, 'ARCHIVED'), target, record), false);
});

test('batch activation groups accounts, deduplicates and respects GAM limit', () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ gamAccountId: 1, name: 'networks/123/adUnits/' + index }));
  rows.push(rows[0], { gamAccountId: 2, name: 'networks/456/adUnits/1' });
  const batches = unitActionBatches(rows);
  assert.deepEqual(batches.map(([account, names]) => [account, names.length]), [[1, 100], [1, 1], [2, 1]]);
  assert.deepEqual(batches[2][1], ['networks/456/adUnits/1']);
});

test('confirmation signature changes with account, status, domain or unit membership', () => {
  const row = { gamAccountId: 1, name: 'networks/123/adUnits/9', subdomain: 'news.example.com', status: 'ARCHIVED' };
  const preview = { action: 'activate', targets: ['news.example.com'], rows: [row] };
  const signature = bulkUnitSignature(preview);
  assert.notEqual(bulkUnitSignature({ ...preview, rows: [{ ...row, status: 'INACTIVE' }] }), signature);
  assert.notEqual(bulkUnitSignature({ ...preview, rows: [{ ...row, gamAccountId: 2 }] }), signature);
  assert.notEqual(bulkUnitSignature({ ...preview, rows: [{ ...row, subdomain: 'other.example.com' }] }), signature);
  assert.notEqual(bulkUnitSignature({ ...preview, rows: [] }), signature);
  assert.notEqual(bulkUnitSignature({ ...preview, action: 'archive' }), signature);
});

test('newline bulk input normalizes, deduplicates and rejects invalid or main domains', () => {
  assert.deepEqual(parseSubdomainLines('news.example.com\r\nhttps://finance.example.com/path\nnews.example.com\n'),
    ['news.example.com', 'finance.example.com']);
  assert.throws(() => parseSubdomainLines('example.com\nnews.example.com'), /第 1 行/);
  assert.throws(() => parseSubdomainLines('news.example.com\nnot a domain'), /第 2 行/);
  assert.throws(() => parseSubdomainLines('\n  '), /每行输入/);
  assert.throws(() => parseSubdomainLines(Array(101).fill('news.example.com').join('\n')), /最多输入 100/);
});

test('creation records are scoped to GAM network and conflicting evidence is excluded', () => {
  const record = { networkCode: '123', providerId: 'networks/123/adUnits/9', status: 'created',
    siteUrl: 'https://youxiglobal.xyz', domain: 'news.youxiglobal.xyz' };
  assert.equal(resolveAdUnitDomain(unit('custom-code'), record).subdomain, 'news.youxiglobal.xyz');
  assert.equal(resolveAdUnitDomain(unit('custom-code'), { ...record, networkCode: '456' }).domain, '');
  assert.equal(resolveAdUnitDomain(unit('at_c1_aut_lb-finance.youxiglobal.xyz_inst'), record).domain, '');
  assert.equal(resolveAdUnitDomain(unit('custom-code'), { ...record, siteUrl: 'https://other.net' }).domain, '');
  const conflicting = indexCreationRecords([record, { ...record, domain: 'finance.youxiglobal.xyz' }]);
  assert.equal(resolveAdUnitDomain(unit('custom-code'), conflicting.get('123:networks/123/adUnits/9')).domain, '');
});

test('scans every account page and fails closed on incomplete pagination', async () => {
  const accounts = [
    { id: 1, name: 'A', networkCode: '123', enabled: true },
    { id: 2, name: 'B', networkCode: '456', enabled: true }
  ];
  const calls = [];
  const rows = await scanGamUnits(accounts, async (account, token) => {
    calls.push([account.id, token]);
    return account.id === 1 && !token
      ? { items: [unit('261104-news.youxiglobal.xyz-banner1')], nextPageToken: 'second' }
      : { items: [unit('261104-news.youxiglobal.xyz-banner2')], nextPageToken: '' };
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.gamAccountId).sort(), [1, 1, 2]);
  assert.deepEqual(calls.sort(), [[1, ''], [1, 'second'], [2, '']].sort());
  await assert.rejects(() => scanGamUnits(accounts.slice(0, 1), async () =>
    ({ items: [], nextPageToken: 'again' })), /分页重复/);
});
