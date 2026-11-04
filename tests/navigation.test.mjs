import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewForPath, viewPaths } from '../src/navigation.js';

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
  assert.equal(viewForPath('/reports', 'dashboard', 'channel'), 'reports');
});
