import test from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import { reportPresetRange, selectedReportPreset } from '../src/reportDatePresets.js';

test('report shortcuts include today and keep rolling ranges through yesterday', () => {
  const now = dayjs('2026-11-05T16:00:00');
  const expected = {
    today: ['2026-11-05', '2026-11-05'],
    monthToDate: ['2026-11-01', '2026-11-05'],
    yesterday: ['2026-11-04', '2026-11-04'],
    last7: ['2026-10-29', '2026-11-04'],
    lastMonth: ['2026-10-05', '2026-11-04'],
    last3Months: ['2026-08-05', '2026-11-04'],
    lastYear: ['2025-11-05', '2026-11-04']
  };
  for (const [key, dates] of Object.entries(expected)) {
    const range = reportPresetRange(key, now);
    assert.deepEqual(range.map(value => value.format('YYYY-MM-DD')), dates);
    assert.equal(selectedReportPreset(range, now), key);
  }
});

test('manual dates and empty monitor filters remain distinct', () => {
  const now = dayjs('2026-11-05');
  assert.equal(selectedReportPreset(null, now), 'all');
  assert.equal(selectedReportPreset([dayjs('2026-10-01'), dayjs('2026-10-31')], now), 'custom');
  assert.equal(reportPresetRange('custom', now), null);
});
