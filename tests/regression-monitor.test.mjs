import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regressionWindow, alertQualified } from '../server/regression-monitor.mjs';

test('regression windows use each GAM account timezone and equal-length periods', () => {
  const instant = new Date('2026-11-04T01:30:00Z');
  assert.deepEqual(regressionWindow('America/Los_Angeles', 'day', instant), {
    cadence: 'day', start: '2026-11-03', end: '2026-11-03', baselineStart: '', baselineEnd: '', interval: 15 * 60_000
  });
  const three = regressionWindow('Asia/Tokyo', 'three_days', instant);
  assert.deepEqual([three.start, three.end, three.baselineStart, three.baselineEnd], ['2026-11-01', '2026-11-03', '2026-10-29', '2026-10-31']);
  const month = regressionWindow('Asia/Tokyo', 'month', instant);
  assert.deepEqual([month.start, month.end, month.baselineStart, month.baselineEnd], ['2026-10-05', '2026-11-03', '2026-09-05', '2026-10-04']);
});

test('Feishu threshold requires both original revenue and drop percentage', () => {
  const settings = { min_revenue: 50, min_drop_percent: 2 };
  assert.equal(alertQualified({ revenue: 100 }, { revenue: 98 }, settings), true);
  assert.equal(alertQualified({ revenue: 50 }, { revenue: 30 }, settings), false);
  assert.equal(alertQualified({ revenue: 100 }, { revenue: 98.01 }, settings), false);
});
