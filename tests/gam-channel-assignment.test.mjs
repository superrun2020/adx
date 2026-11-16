import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { gamChannelAssignments, channelForGamDate, gamChannelForDate } from '../server/gam-channel-assignment.mjs';

test('GAM channel ownership changes on the report date without changing history', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE gam_channel_assignments(soap_account_id INTEGER,channel_id INTEGER,effective_from TEXT)');
  db.prepare('INSERT INTO gam_channel_assignments VALUES(?,?,?)').run(1, 1, '1900-01-01');
  db.prepare('INSERT INTO gam_channel_assignments VALUES(?,?,?)').run(1, 2, '2026-11-16');
  const assignments = gamChannelAssignments(db, 1, 2, '2026-11-16');
  assert.equal(channelForGamDate(assignments, '2026-11-15'), 1);
  assert.equal(channelForGamDate(assignments, '2026-11-16'), 2);
  assert.equal(gamChannelForDate(db, { id: 1, rest_channel_id: 2 }, '2026-11-15'), 1);
  assert.equal(gamChannelForDate(db, { id: 1, rest_channel_id: 2 }, '2026-11-16'), 2);
  db.close();
});
