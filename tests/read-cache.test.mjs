import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearCachedUser, readCached, rememberRead } from '../src/readCache.js';

test('report snapshots remain scoped to one signed-in user', () => {
  const entries = new Map();
  globalThis.sessionStorage = {
    getItem: key => entries.get(key) || null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  const admin = { id: 1, role: 'admin' };
  const channel = { id: 2, role: 'channel', channelId: 4 };
  const path = '/api/reports?start=2026-11-01&end=2026-11-03';
  rememberRead(admin, path, { ok: true, items: [{ revenue: 12 }] });
  assert.equal(readCached(admin, path)?.data.items[0].revenue, 12);
  assert.equal(readCached(channel, path), null);
  rememberRead(channel, path, { ok: true, items: [{ revenue: 3 }] });
  clearCachedUser(admin);
  assert.equal(readCached(admin, path), null);
  assert.equal(readCached(channel, path)?.data.items[0].revenue, 3);
});
