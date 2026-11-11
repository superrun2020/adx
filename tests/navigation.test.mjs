import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canVisit, shouldNavigateInPlace, viewForPath, viewPaths } from '../src/navigation.js';
import { allowedAdminRequest } from '../server/admin-permissions.mjs';

test('each sidebar view has a refreshable browser path', () => {
  for (const [view, path] of Object.entries(viewPaths)) {
    assert.equal(viewForPath(path), view);
    assert.equal(viewForPath(path + '/'), view);
  }
});

test('unknown paths resolve to the dashboard', () => {
  assert.equal(viewForPath('/unknown'), 'dashboard');
  assert.equal(viewForPath('/unknown', 'reports'), 'reports');
});

test('channel accounts cannot open administrator routes directly', () => {
  assert.equal(viewForPath('/gam-accounts', 'dashboard', 'channel'), 'dashboard');
  assert.equal(viewForPath('/links', 'dashboard', 'channel'), 'dashboard');
  assert.equal(viewForPath('/bot-report', 'dashboard', 'channel'), 'dashboard');
  assert.equal(viewForPath('/reports', 'dashboard', 'channel'), 'reports');
});

test('restricted administrators see only granted sidebar routes', () => {
  const user = { role: 'admin', isSuperAdmin: false, sidebarPermissions: ['reports', 'links'] };
  assert.equal(canVisit(user, 'reports'), true);
  assert.equal(canVisit(user, 'links'), true);
  assert.equal(canVisit(user, 'admins'), false);
  assert.equal(canVisit(user, 'dashboard'), false);
  assert.equal(viewForPath('/admins', 'dashboard', user), 'reports');
  assert.equal(viewForPath('/links', 'dashboard', user), 'links');
  assert.equal(canVisit(user, 'bot-report'), false);
  const botAdmin = { role:'admin', sidebar_permissions:'["bot-report"]' };
  assert.equal(allowedAdminRequest(botAdmin, '/api/admin/bot-report/settings', 'GET'), true);
  assert.equal(allowedAdminRequest(botAdmin, '/api/admin/regression/settings', 'GET'), false);
});

test('sidebar keeps ordinary clicks in place and leaves browser new-tab gestures alone', () => {
  assert.equal(shouldNavigateInPlace({ button: 0 }), true);
  assert.equal(shouldNavigateInPlace({ button: 0, ctrlKey: true }), false);
  assert.equal(shouldNavigateInPlace({ button: 0, metaKey: true }), false);
  assert.equal(shouldNavigateInPlace({ button: 0, shiftKey: true }), false);
  assert.equal(shouldNavigateInPlace({ button: 0, altKey: true }), false);
  assert.equal(shouldNavigateInPlace({ button: 1 }), false);
  assert.equal(shouldNavigateInPlace({ button: 2 }), false);
});
