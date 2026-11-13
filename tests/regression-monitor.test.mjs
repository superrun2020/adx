import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { regressionWindow, regressionCycleWindow, alertQualified, firstDropDate, regressionAlertMessage, pausedAdUnitIds, excludePausedRevenue, registerRegressionMonitor } from '../server/regression-monitor.mjs';

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

test('three and seven day comparisons advance only after a full local period', () => {
  const instant = new Date('2026-11-13T01:30:00Z');
  const three = regressionCycleWindow('Asia/Shanghai', 'three_days', instant, '2026-11-11');
  assert.deepEqual([three.window.start, three.window.end, three.window.baselineStart, three.window.baselineEnd, three.ready],
    ['2026-11-12', '2026-11-14', '2026-11-09', '2026-11-11', false]);
  const complete = regressionCycleWindow('Asia/Shanghai', 'three_days', new Date('2026-11-15T00:30:00Z'), '2026-11-11');
  assert.equal(complete.ready, true);
  const next = regressionCycleWindow('Asia/Shanghai', 'three_days', new Date('2026-11-16T00:30:00Z'), complete.window.end);
  assert.deepEqual([next.window.start, next.window.end, next.ready], ['2026-11-15', '2026-11-17', false]);
  const la = regressionCycleWindow('America/Los_Angeles', 'week', new Date('2026-11-16T01:00:00Z'), '2026-11-08');
  assert.deepEqual([la.window.start, la.window.end, la.window.baselineStart, la.window.baselineEnd, la.ready],
    ['2026-11-09', '2026-11-15', '2026-11-02', '2026-11-08', false]);
  assert.equal(regressionCycleWindow('America/Los_Angeles', 'week', new Date('2026-11-16T08:00:00Z'), '2026-11-08').ready, true);
});

test('Feishu threshold requires both original revenue and drop percentage', () => {
  const settings = { min_revenue: 50, min_drop_percent: 2 };
  assert.equal(alertQualified({ revenue: 100 }, { revenue: 98 }, settings), true);
  assert.equal(alertQualified({ revenue: 50 }, { revenue: 30 }, settings), false);
  assert.equal(alertQualified({ revenue: 100 }, { revenue: 98.01 }, settings), false);
});

test('paused ad units suppress only their own loss, respecting account and timezone', () => {
  const window = { baselineStart: '2026-11-01', end: '2026-11-06' };
  const archive = (id, date, network = '123') => ({ action: 'gam.ad_unit_archive', created_at: date, detail: JSON.stringify({ names: ['networks/' + network + '/adUnits/' + id] }) });
  const activate = (id, date) => ({ action: 'gam.ad_unit_activate', created_at: date, detail: JSON.stringify({ names: ['networks/123/adUnits/' + id] }) });
  const audits = [archive('11','2026-11-05 02:00:00'), archive('12','2026-11-05 02:00:00'), activate('12','2026-11-06 02:00:00'), archive('13','2026-11-06 17:00:00'), archive('14','2026-11-05 02:00:00','456')];
  assert.deepEqual([...pausedAdUnitIds(audits, '123', 'Asia/Shanghai', window)], ['11']);
  assert.deepEqual([...pausedAdUnitIds(audits, '456', 'Asia/Shanghai', window)], ['14']);
  const pure = excludePausedRevenue({ revenue: 160 }, { revenue: 100 }, { before: 60, after: 0 });
  assert.equal(pure.excluded, true);
  assert.equal(alertQualified(pure.before, pure.after, { min_revenue: 50, min_drop_percent: 2 }), false);
  const mixed = excludePausedRevenue({ revenue: 150 }, { revenue: 70 }, { before: 50, after: 0 });
  assert.equal(mixed.excluded, true);
  assert.equal(alertQualified(mixed.before, mixed.after, { min_revenue: 50, min_drop_percent: 2 }), true);
});

test('Feishu alert text identifies confirmed and unlocated data dates', () => {
  const account = { name: 'GAM Test', network_code: '123456' };
  const window = { cadence: 'day', start: '2026-11-09', end: '2026-11-09' };
  const alert = { domain: 'news.example.com', dropStartDate: '2026-11-09', detectedAtUtc: '2026-11-09 08:29:00',
    before: { revenue: 100, requests: 100, impressions: 80, clicks: 10 },
    after: { revenue: 90, requests: 95, impressions: 85, clicks: 10 } };
  const message = regressionAlertMessage(account, '赵飞', 'Asia/Shanghai', '2026-11-09 16:30', window, [alert]);
  assert.equal(message, [
    '【AdX 收入下降】', '账号：GAM Test（123456）', '渠道：赵飞', '域名：news.example.com',
    '数据日：2026-11-09', '收入：$100.00 → $90.00，少 $10.00（10.00%）', '发现：2026-11-09 16:29（Asia/Shanghai）'
  ].join('\n'));
  const unknown = regressionAlertMessage(account, '赵飞', 'Asia/Shanghai', '2026-11-09 16:30', window,
    [{ ...alert, dropStartDate: null }]);
  assert.match(unknown, /数据日：2026-11-09/);
  assert.doesNotMatch(unknown, /已确认下修日/);
  const multi = regressionAlertMessage(account, '赵飞', 'Asia/Singapore', '2026-11-10 00:43',
    { cadence:'three_days', start:'2026-11-07', end:'2026-11-09', baselineStart:'2026-11-04', baselineEnd:'2026-11-06' }, [alert]);
  assert.match(multi, /区间：2026-11-07 至 2026-11-09（对比 2026-11-04 至 2026-11-06）/);
  assert.match(multi, /发现：2026-11-09 16:29（Asia\/Singapore）/);
  assert.match(multi, /少 \$10\.00/);
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

test('completed three-day comparison runs once and Feishu retries its original alert', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,rest_network_timezone TEXT); CREATE TABLE channels(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE upstream_accounts(id INTEGER PRIMARY KEY,soap_account_id INTEGER,account_key TEXT,status TEXT); CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,action TEXT,target_id TEXT,detail TEXT,created_at TEXT); CREATE TABLE revenue_facts(channel_id INTEGER,account TEXT,report_date TEXT,domain TEXT,ad_unit_id TEXT DEFAULT '',source_file TEXT,revenue REAL,requests INTEGER,impressions INTEGER,clicks INTEGER)");
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
  const first = db.prepare("SELECT id,drop_start_date FROM regression_events WHERE cadence='three_days' ORDER BY id DESC LIMIT 1").get();
  assert.equal(first.drop_start_date, null);
  db.prepare('UPDATE regression_runs SET finished_at=?').run(new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
  db.prepare('UPDATE revenue_facts SET revenue=60 WHERE report_date=?').run(window.end);
  await monitor.runForAccount(account);
  assert.equal(db.prepare("SELECT COUNT(*) total FROM regression_runs WHERE cadence='three_days' AND status='success'").get().total, 1);
  assert.equal(db.prepare("SELECT COUNT(*) total FROM regression_events WHERE cadence='three_days'").get().total, 1);
  let body;
  routes.get('/api/admin/regression/events')({ query: { alertsOnly: '1', cadence: 'three_days' } }, { json: value => { body = value; } });
  assert.equal(body.items[0].dropStartDate, null);

  db.prepare("UPDATE regression_settings SET feishu_enabled=1,webhook_ciphertext='test-ciphertext' WHERE id=1").run();
  db.prepare("UPDATE regression_events SET alert_status='failed',send_attempts=1,last_attempt_at='2000-01-01 00:00:00' WHERE id=?").run(first.id);
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
    assert.match(message, /【AdX 收入下降】/);
    assert.match(message, /账号：GAM（123）/);
    assert.match(message, /渠道：Publisher/);
    assert.match(message, /区间：/);
    assert.match(message, /发现：/);
    assert.doesNotMatch(message, /已确认下修日/);
    const delivered = db.prepare('SELECT alert_status,send_attempts FROM regression_events WHERE id=?').get(first.id);
    assert.equal(delivered.alert_status, 'sent');
    assert.equal(delivered.send_attempts, 2);
    await retryMonitor.runForAccount(account);
    assert.equal(sent, 1);
    db.prepare('UPDATE regression_runs SET finished_at=?').run(new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
    await retryMonitor.runForAccount(account);
    assert.equal(sent, 1);
    assert.equal(db.prepare("SELECT COUNT(*) total FROM regression_events WHERE cadence='three_days'").get().total, 1);
  } finally { globalThis.fetch = originalFetch; }
  db.close();
});
