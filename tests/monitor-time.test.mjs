import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorTime } from '../src/monitorTime.js';

test('monitor displays SQLite UTC and explicit offsets as the same instant', () => {
  const expected = monitorTime('2026-11-25T08:30:00Z', 'Asia/Shanghai');
  assert.match(expected.text, /16:30:00/);
  assert.deepEqual(monitorTime('2026-11-25 08:30:00', 'Asia/Shanghai'), expected);
  assert.deepEqual(monitorTime('2026-11-25T16:30:00+08:00', 'Asia/Shanghai'), expected);
  assert.equal(monitorTime('2026-11-25 08:30:00', 'unknown').zone, 'UTC');
  assert.equal(monitorTime('', 'UTC').text, '—');
});
