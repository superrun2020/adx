import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { regressionWindow, alertQualified, firstDropDate, registerRegressionMonitor } from '../server/regression-monitor.mjs';

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

test('drop start is the earliest confirmed same-date decrease only', () => {
  const prior = new Map([
    ['2026-11-07\0example.com', { revenue: 100 }],
    ['2026-11-08\0example.com', { revenue: 200 }],
    ['2026-11-06\0other.com', { revenue: 500 }]
  ]);
  const rows = [
    { reportDate: '2026-11-08', domain: 'example.com', revenue: 150 },
    { reportDate: '2026-11-06', domain: 'example.com', revenue: 10 },
    { reportDate: '2026-11-07', domain: 'example.com', revenue: 90 },
    { reportDate: '2026-11-06', domain: 'other.com', revenue: 0 }
  ];
  assert.equal(firstDropDate('example.com', rows, prior), '2026-11-07');
  assert.equal(firstDropDate('new.com', rows, prior), null);
  assert.equal(firstDropDate('example.com', [{ reportDate: '2026-11-07', domain: 'example.com', revenue: 100 }], prior), null);
});

test('later multi-day run records the earliest revised data day without inventing a date for its first run', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,rest_network_timezone TEXT); CREATE TABLE channels(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE upstream_accounts(id INTEGER PRIMARY KEY,soap_account_id INTEGER,account_key TEXT,status TEXT); CREATE TABLE revenue_facts(channel_id INTEGER,account TEXT,report_date TEXT,domain TEXT,source_file TEXT,revenue REAL,requests INTEGER,impressions INTEGER,clicks INTEGER)");
  db.exec("INSERT INTO soap_accounts(id,name,network_code,rest_network_timezone) VALUES(1,'GAM','123','Asia/Tokyo'); INSERT INTO channels(id,name) VALUES(1,'Publisher'); INSERT INTO upstream_accounts(id,soap_account_id,account_key,status) VALUES(1,1,'upstream','active')");
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)), put() {} };
  const transaction = fn => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const monitor = registerRegressionMonitor(app, { db, requireAuth: () => {}, requireAdmin: () => {}, encryptCredential: () => '', decryptCredential: () => ({}), transaction, gamSync: { execute: async () => ({ rows: 1 }) }, audit: () => {} });
  const account = { id: 1, name: 'GAM', network_code: '123', rest_channel_id: 1, rest_upstream_account_id: 1, rest_network_timezone: 'Asia/Tokyo' };
  const window = regressionWindow(account.rest_network_timezone, 'three_days');
  const insert = db.prepare("INSERT INTO revenue_facts(channel_id,account,report_date,domain,source_file,revenue,requests,impressions,clicks) VALUES(1,'upstream',?,'example.com','gam-rest:123:sample',?,100,80,5)");
  for (let date = new Date(window.baselineStart + 'T00:00:00Z'); date <= new Date(window.end + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    insert.run(day, day < window.start ? 100 : 80);
  }
  insert.run(regressionWindow(account.rest_network_timezone, 'day').start, 90);
  await monitor.runForAccount(account);
  assert.equal(db.prepare("SELECT COUNT(*) total FROM regression_runs WHERE cadence='day' AND status='success'").get().total, 2);
  assert.equal(db.prepare("SELECT drop_start_date FROM regression_events WHERE cadence='three_days' ORDER BY id DESC LIMIT 1").get().drop_start_date, null);
  db.prepare('UPDATE regression_runs SET finished_at=?').run(new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
  db.prepare('UPDATE revenue_facts SET revenue=60 WHERE report_date=?').run(window.end);
  await monitor.runForAccount(account);
  const latest = db.prepare("SELECT id,drop_start_date FROM regression_events WHERE cadence='three_days' ORDER BY id DESC LIMIT 1").get();
  assert.equal(latest.drop_start_date, window.end);
  let body;
  routes.get('/api/admin/regression/events')({ query: { alertsOnly: '1', cadence: 'three_days' } }, { json: value => { body = value; } });
  assert.equal(body.items[0].dropStartDate, window.end);

  db.prepare("UPDATE regression_settings SET feishu_enabled=1,webhook_ciphertext='test-ciphertext' WHERE id=1").run();
  db.prepare("UPDATE regression_events SET alert_status='failed',send_attempts=1,last_attempt_at='2000-01-01 00:00:00' WHERE id=?").run(latest.id);
  const older = db.prepare("SELECT id FROM regression_events WHERE cadence='three_days' AND id<>? ORDER BY id LIMIT 1").get(latest.id);
  db.prepare("UPDATE regression_events SET alert_status='failed',send_attempts=1,last_attempt_at='2000-01-01 00:00:00' WHERE id=?").run(older.id);
  const retryMonitor = registerRegressionMonitor(app, { db, requireAuth: () => {}, requireAdmin: () => {}, encryptCredential: () => '',
    decryptCredential: () => ({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', secret: '' }), transaction,
    gamSync: { execute: async () => ({ rows: 1 }) }, audit: () => {} });
  const originalFetch = globalThis.fetch;
  let sent = 0, message = '';
  globalThis.fetch = async (_url, options) => {
    sent += 1;
    message = JSON.parse(options.body).content.text;
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  try {
    await retryMonitor.runForAccount(account);
    assert.equal(sent, 1);
    assert.match(message, /GAM 账户：GAM/);
    assert.match(message, /关联渠道：Publisher/);
    assert.match(message, new RegExp('倒扣起始数据日：' + window.end));
    const delivered = db.prepare('SELECT alert_status,send_attempts FROM regression_events WHERE id=?').get(latest.id);
    assert.equal(delivered.alert_status, 'sent');
    assert.equal(delivered.send_attempts, 2);
    assert.equal(db.prepare('SELECT alert_status FROM regression_events WHERE id=?').get(older.id).alert_status, 'duplicate');
    await retryMonitor.runForAccount(account);
    assert.equal(sent, 1);
    db.prepare('UPDATE regression_runs SET finished_at=?').run(new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
    await retryMonitor.runForAccount(account);
    assert.equal(sent, 1);
    assert.equal(db.prepare("SELECT alert_status FROM regression_events WHERE cadence='three_days' ORDER BY id DESC LIMIT 1").get().alert_status, 'duplicate');
  } finally { globalThis.fetch = originalFetch; }
  db.close();
});
