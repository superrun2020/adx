import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedLinksForAccount, hostname } from '../src/link-catalog.mjs';

const account = { id: 7, name: 'GAM A', networkCode: '123456' };
const site = (url, approvalStatus, id = 1) => ({ name: 'networks/123456/sites/' + id, url, approvalStatus });

test('normalizes domains from GAM URLs and rejects invalid hosts', () => {
  assert.equal(hostname('HTTPS://News.Example.com/path'), 'news.example.com');
  assert.equal(hostname('example.com'), 'example.com');
  assert.equal(hostname('localhost'), '');
});

test('lists only Sites whose own GAM approval status is APPROVED', () => {
  const rows = approvedLinksForAccount(account, [
    site('https://example.com', 'APPROVED'),
    site('https://news.example.com', 'APPROVED', 2),
    site('https://draft.example.com', 'DRAFT', 3),
    site('https://rejected.example.com', 'DISAPPROVED', 4)
  ]);
  assert.deepEqual(rows.map(row => [row.domain, row.type, row.approval]), [
    ['example.com', 'main', 'APPROVED'],
    ['news.example.com', 'sub', 'APPROVED']
  ]);
  assert.equal(rows[1].parentDomain, 'example.com');
  assert.equal(rows[1].source, 'GAM Sites');
  assert.equal(rows[1].networkCode, '123456');
});

test('does not promote report-only domains or a child of an approved parent', () => {
  const rows = approvedLinksForAccount(account, [site('example.com', 'APPROVED')], [
    'report-only.example.com', 'news.example.com'
  ]);
  assert.deepEqual(rows.map(row => row.domain), ['example.com']);
});

test('approved child remains listed without claiming an unapproved parent Site', () => {
  const rows = approvedLinksForAccount(account, [
    site('news.example.com', 'APPROVED', 2), site('example.com', 'DRAFT')
  ]);
  assert.deepEqual(rows.map(row => [row.domain, row.type, row.parentDomain]), [
    ['news.example.com', 'sub', '']
  ]);
});

test('keeps separate GAM account scope for the same approved domain', () => {
  const first = approvedLinksForAccount(account, [site('example.com', 'APPROVED')]);
  const second = approvedLinksForAccount({ id: 8, name: 'GAM B', networkCode: '789012' }, [
    site('example.com', 'APPROVED')
  ]);
  assert.notEqual(first[0].key, second[0].key);
  assert.equal(second[0].networkCode, '789012');
});
