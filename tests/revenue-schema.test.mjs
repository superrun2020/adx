import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensureAdUnitIdDimension } from '../server/revenue-schema.mjs';

test('legacy revenue keys migrate without losing facts and allow same-name IDs', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE channels(id INTEGER PRIMARY KEY)");
  db.exec("INSERT INTO channels(id) VALUES(1)");
  db.exec("CREATE TABLE revenue_facts(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER, url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, raw_json TEXT NOT NULL DEFAULT '{}', UNIQUE(channel_id,report_date,hour,url,account,ad_unit,country))");
  db.exec("INSERT INTO revenue_facts(channel_id,report_date,hour,url,account,ad_unit,country,revenue,source_file) VALUES(1,'2026-10-31',13,'site','acct','Same name','US',10,'legacy')");
  assert.equal(ensureAdUnitIdDimension(db), true);
  assert.equal(ensureAdUnitIdDimension(db), false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revenue_facts').get().n, 1);
  assert.equal(db.prepare('SELECT ad_unit_id FROM revenue_facts').get().ad_unit_id, '');
  const insert = db.prepare("INSERT INTO revenue_facts(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country,revenue,source_file) VALUES(1,'2026-10-31',13,'site','acct','Same name',?,'US',20,'rest')");
  insert.run('unit-1'); insert.run('unit-2');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revenue_facts').get().n, 3);
  db.close();
});
