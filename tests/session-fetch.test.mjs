import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionFetch } from '../src/sessionFetch.js';

test('successful protected requests keep their response', async () => {
  const originalFetch = globalThis.fetch;
  const response = { status: 200, ok: true };
  try {
    globalThis.fetch = async () => response;
    assert.equal(await sessionFetch('/api/dashboard'), response);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a 401 starts one login reload and never passes stale responses to views', async () => {
  const original = { fetch: globalThis.fetch, window: globalThis.window,
    sessionStorage: globalThis.sessionStorage };
  const stored = [];
  let reloads = 0;
  try {
    globalThis.fetch = async () => ({ status: 401 });
    globalThis.window = { location: { reload: () => { reloads++; } } };
    globalThis.sessionStorage = { setItem: (key, value) => stored.push([key, value]) };
    const first = sessionFetch('/api/dashboard');
    const second = sessionFetch('/api/dashboard/highlights');
    await new Promise(setImmediate);
    assert.equal(reloads, 1);
    assert.deepEqual(stored, [['adx_session_reauth', '1']]);
    assert.equal(await Promise.race([first.then(() => 'stale'), Promise.resolve('navigating')]), 'navigating');
    assert.equal(await Promise.race([second.then(() => 'stale'), Promise.resolve('navigating')]), 'navigating');
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.window = original.window;
    globalThis.sessionStorage = original.sessionStorage;
  }
});
