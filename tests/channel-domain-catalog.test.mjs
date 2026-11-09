import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelGAMDomains, resolveChannelAssignment } from '../src/channel-domain-catalog.mjs';
import { allowedAdminRequest } from '../server/admin-permissions.mjs';

const account = { id: 1, name: 'GAM A', networkCode: '123456', status: 'active', channelId: 7 };
const site = domain => ({ name: 'networks/123456/sites/1', url: 'https://' + domain, approvalStatus: 'APPROVED' });

test('channels-only administrator can read domain sources but cannot modify links or GAM', () => {
  const user = { role: 'admin', sidebar_permissions: '["channels"]' };
  for (const path of ['/api/admin/gam-accounts','/api/admin/gam-accounts/1/sites','/api/admin/gam-accounts/1/site-domains','/api/admin/link-metadata'])
    assert.equal(allowedAdminRequest(user, path, 'GET'), true, path);
  assert.equal(allowedAdminRequest(user, '/api/admin/link-metadata', 'POST'), false);
  assert.equal(allowedAdminRequest(user, '/api/admin/gam-accounts', 'POST'), false);
});

test('channel domains come only from the correct GAM Network and report children', () => {
  const grouped = channelGAMDomains([account], { 1: [site('example.com')] },
    { 1: ['news.example.com', 'other.net'] },
    [{ networkCode: '123456', domain: 'manual.example.com', channelId: 7, isManual: 1 }], []);
  assert.deepEqual(grouped.get(7).map(row => [row.domain, row.source]), [
    ['example.com', 'GAM Sites'], ['news.example.com', 'GAM 报表']
  ]);
  assert.equal(grouped.get(7)[0].assignmentSource, '账号同步映射');
});

test('explicit link and domain assignments override account channel', () => {
  const grouped = channelGAMDomains([account], { 1: [site('example.com'), site('shop.example.com')] }, {},
    [{ networkCode: '123456', domain: 'example.com', channelId: 9 }],
    [{ domain: 'shop.example.com', channelId: 10 }]);
  assert.deepEqual(grouped.get(9).map(row => row.domain), ['example.com']);
  assert.deepEqual(grouped.get(10).map(row => row.domain), ['shop.example.com']);
  assert.equal(grouped.get(7), undefined);
  assert.equal(grouped.get(9)[0].assignmentSource, '链接管理');
  assert.equal(grouped.get(10)[0].assignmentSource, '域名归属');
});

test('link channel resolution matches channel management when metadata has no channel', () => {
  const names = new Map([[7, 'Account channel'], [10, 'Domain channel']]);
  assert.deepEqual(resolveChannelAssignment(account, { channelId: null, notes: 'saved' },
    { channelId: 10, channelName: 'Domain channel' }, names),
    { channelId: 10, channelName: 'Domain channel', assignmentSource: '域名归属' });
  assert.deepEqual(resolveChannelAssignment(account, { channelId: null }, null, names),
    { channelId: 7, channelName: 'Account channel', assignmentSource: '账号同步映射' });
  const grouped = channelGAMDomains([account], { 1: [site('example.com')] }, {},
    [{ networkCode: '123456', domain: 'example.com', channelId: null }],
    [{ domain: 'example.com', channelId: 10, channelName: 'Domain channel' }]);
  assert.equal(grouped.get(10)[0].assignmentSource, '域名归属');
});

test('link assignment is scoped by GAM Network before domain fallback', () => {
  const other = { ...account, id: 2, networkCode: '999999', channelId: 7 };
  const grouped = channelGAMDomains([account, other],
    { 1: [site('example.com')], 2: [{ ...site('example.com'), name: 'networks/999999/sites/1' }] }, {},
    [{ networkCode: '123456', domain: 'example.com', channelId: 9 }],
    [{ domain: 'example.com', channelId: 10 }]);
  assert.equal(grouped.get(9)[0].networkCode, '123456');
  assert.equal(grouped.get(10)[0].networkCode, '999999');
});

test('report-only domains without a GAM parent and disconnected accounts are omitted', () => {
  const grouped = channelGAMDomains([{ ...account, status: 'untested' }],
    { 1: [site('example.com')] }, { 1: ['news.example.com'] }, [], []);
  assert.equal(grouped.size, 0);
  const orphan = channelGAMDomains([account], { 1: [] }, { 1: ['news.example.com'] }, [], []);
  assert.equal(orphan.size, 0);
});
