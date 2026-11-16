import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assignChannelAccounts, parseChannelAccountIds } from '../server/channel-accounts.mjs';

test('channel account selection transfers current REST facts and links while preserving history', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,network_code TEXT,status TEXT,enabled INTEGER,rest_report_name TEXT,rest_channel_id INTEGER,rest_upstream_account_id INTEGER,channel_locked_to_account INTEGER DEFAULT 0,updated_at TEXT); CREATE TABLE upstream_accounts(id INTEGER PRIMARY KEY,soap_account_id INTEGER,account_key TEXT,status TEXT); CREATE TABLE gam_channel_assignments(soap_account_id INTEGER,channel_id INTEGER,effective_from TEXT,created_by TEXT,PRIMARY KEY(soap_account_id,effective_from)); CREATE TABLE revenue_facts(channel_id INTEGER,account TEXT,report_date TEXT,source_file TEXT,revenue REAL); CREATE TABLE link_metadata(network_code TEXT,domain TEXT,channel_id INTEGER,updated_by TEXT,updated_at TEXT)");
  db.exec("INSERT INTO soap_accounts(id,network_code,status,enabled,rest_report_name,rest_channel_id,rest_upstream_account_id) VALUES(1,'123456','active',1,'networks/123456/reports/1',1,1); INSERT INTO upstream_accounts VALUES(1,1,'upstream','active'); INSERT INTO revenue_facts VALUES(1,'upstream','2026-11-15','gam-rest:123456:old',10),(1,'upstream','2026-11-16','gam-rest:123456:new',20); INSERT INTO link_metadata(network_code,domain,channel_id) VALUES('123456','site.test',1)");
  assert.deepEqual(parseChannelAccountIds([1]), [1]);
  assert.throws(() => parseChannelAccountIds([1, 1]), /invalid_channel_account/);
  const affected = assignChannelAccounts(db, 2, [1], '2026-11-16', 'test');
  assert.deepEqual([...affected], [[1, '2026-11-16'], [2, '2026-11-16']]);
  assert.deepEqual(db.prepare('SELECT report_date date,channel_id channel FROM revenue_facts ORDER BY report_date').all().map(row=>({...row})),
    [{ date:'2026-11-15', channel:1 }, { date:'2026-11-16', channel:2 }]);
  assert.equal(db.prepare('SELECT channel_locked_to_account locked FROM soap_accounts WHERE id=1').get().locked, 1);
  assert.equal(db.prepare('SELECT channel_id channel FROM link_metadata').get().channel, 2);
  assert.deepEqual(db.prepare('SELECT effective_from date,channel_id channel FROM gam_channel_assignments ORDER BY effective_from').all().map(row=>({...row})),
    [{ date:'1900-01-01', channel:1 }, { date:'2026-11-16', channel:2 }]);
  db.close();
});
