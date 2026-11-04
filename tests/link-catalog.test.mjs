import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedLinksForAccount, catalogLinksForAccount, hostname } from '../src/link-catalog.mjs';

const account = { id: 7, name: 'GAM A', networkCode: '123456' };
const site = (url, approvalStatus, id = 1) => ({ name: 'networks/123456/sites/' + id, url, approvalStatus });

test('normalizes domains from GAM URLs and rejects invalid hosts', () => {
  assert.equal(hostname('HTTPS://News.Example.com/path'), 'news.example.com');
  assert.equal(hostname('example.com'), 'example.com');
  assert.equal(hostname('localhost'), '');
});

test('shows approved root and known child with distinct approval labels', () => {
  const rows = catalogLinksForAccount(account, [site('https://example.com', 'APPROVED')],
    ['example.com', 'news.example.com', 'news.example.com']);
  assert.deepEqual(rows.map(row => [row.domain, row.type, row.approval]), [
    ['example.com', 'main', 'APPROVED'],
    ['news.example.com', 'sub', 'PARENT_APPROVED']
  ]);
  assert.equal(rows[1].parentDomain, 'example.com');
  assert.equal(rows[1].networkCode, '123456');
  assert.deepEqual(approvedLinksForAccount(account, [site('example.com', 'APPROVED')], ['news.example.com'])
    .map(row => row.domain), ['example.com']);
});

test('excludes rejected Sites and their descendants even under an approved root', () => {
  const rows = approvedLinksForAccount(account, [
    site('example.com', 'APPROVED'), site('rejected.example.com', 'DISAPPROVED', 2)
  ], ['rejected.example.com', 'sub.rejected.example.com', 'good.example.com']);
  assert.deepEqual(rows.map(row => row.domain), ['example.com']);
});

test('separately approved subsite keeps its own GAM approval and account scope', () => {
  const sites = [site('example.com', 'APPROVED'), site('news.example.com', 'APPROVED', 2)];
  const first = catalogLinksForAccount(account, sites, ['m.news.example.com']);
  const second = approvedLinksForAccount({ id: 8, name: 'GAM B', networkCode: '789012' }, sites, []);
  assert.equal(first.find(row => row.domain === 'news.example.com').approval, 'APPROVED');
  assert.equal(first.find(row => row.domain === 'm.news.example.com').parentDomain, 'news.example.com');
  assert.notEqual(first[0].key, second[0].key);
});

test('catalog still shows draft Sites without labeling them approved', () => {
  const rows = catalogLinksForAccount(account, [site('example.com', 'DRAFT')], ['news.example.com']);
  assert.deepEqual(rows.map(row => row.approval), ['DRAFT', 'PARENT_DRAFT']);
  assert.deepEqual(approvedLinksForAccount(account, [site('example.com', 'DRAFT')], ['news.example.com']), []);
});

test('unmatched account domains remain visible without invented approval', () => {
  const rows = catalogLinksForAccount(account, [], ['finance.nextvisiona.com']);
  assert.deepEqual(rows.map(row => [row.domain, row.type, row.parentDomain, row.approval]), [
    ['finance.nextvisiona.com', 'sub', 'nextvisiona.com', 'NO_SITE']
  ]);
  assert.deepEqual(approvedLinksForAccount(account, [], ['finance.nextvisiona.com']), []);
});
