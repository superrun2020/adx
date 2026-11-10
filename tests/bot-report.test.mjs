import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { botReportDate, registerBotReport } from '../server/bot-report.mjs';

test('daily bot report uses REST profit, validates webhook and sends once', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE revenue_facts(report_date TEXT,revenue REAL,source_file TEXT,imported_at TEXT);");
  db.exec("CREATE TABLE soap_accounts(id INTEGER PRIMARY KEY,name TEXT,network_code TEXT,rest_network_timezone TEXT,status TEXT,rest_sync_enabled INTEGER,enabled INTEGER);");
  db.exec("INSERT INTO soap_accounts VALUES(1,'Shanghai GAM','123','Asia/Shanghai','active',1,1);");
  db.exec("INSERT INTO soap_accounts VALUES(2,'Kiritimati GAM','456','Pacific/Kiritimati','active',1,1);");
  db.exec("INSERT INTO revenue_facts VALUES('2026-11-10',100,'gam-rest:123:2026-11-10','2026-11-10 15:30:00');");
  db.exec("INSERT INTO revenue_facts VALUES('2026-11-11',50,'gam-rest:456:2026-11-11','2026-11-10 15:30:00');");
  db.exec("INSERT INTO revenue_facts VALUES('2026-11-10',50,'manual-import','2026-11-10 15:30:00');");
  const routes = new Map();
  const app = Object.fromEntries(['get','put','post'].map(method => [method,
    (path, ...handlers) => routes.set(method.toUpperCase() + ' ' + path, handlers.at(-1))]));
  let sends = 0, sentText = '';
  const report = registerBotReport(app, { db, requireAuth:()=>{}, requireAdmin:()=>{},
    encryptCredential:JSON.stringify, decryptCredential:JSON.parse,
    upstreamShareSql:()=> '80', settledRevenueSql:alias => alias + '.revenue*0.4', audit:()=>{},
    send:async (_url, text) => { sends++; sentText = text; } });
  const invoke = async (method, path, body = {}) => {
    const response = { statusCode:200, status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; } };
    await routes.get(method + ' ' + path)({ body, user:{email:'admin@example.test'}, ip:'test' }, response);
    return response;
  };
  const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test';
  assert.equal((await invoke('PUT','/api/admin/bot-report/settings', {enabled:true,webhook:'https://example.test/hook'})).statusCode,400);
  assert.equal((await invoke('PUT','/api/admin/bot-report/settings', {enabled:true,webhook})).statusCode,200);
  const visible = await invoke('GET','/api/admin/bot-report/settings');
  assert.equal(visible.body.settings.webhookConfigured,true);
  assert.equal(JSON.stringify(visible.body).includes(webhook),false);
  const before = new Date('2026-11-10T15:44:00Z'), due = new Date('2026-11-10T15:45:00Z');
  const preview = report.previewFor(due);
  assert.equal(preview.date,'2026-11-10');
  assert.equal(preview.rows,2); assert.equal(preview.revenue,150); assert.equal(preview.profit,42);
  assert.deepEqual(preview.accounts.map(account => account.date),['2026-11-10','2026-11-11']);
  assert.equal(botReportDate(before),'');
  assert.equal(botReportDate(due),'2026-11-10');
  assert.equal(botReportDate(new Date('2026-11-10T16:05:00Z')),'2026-11-10');
  for (const instant of [before,due,new Date('2026-11-10T15:46:00Z'),new Date('2026-11-10T16:05:00Z')]) await report.runAt(instant);
  assert.equal(sends,1);
  assert.match(sentText,/流水（GAM REST 原始收入）：\$150\.00/);
  assert.match(sentText,/利润（上游分成后收入 × 85% − 渠道结算）：\$42\.00/);
  assert.match(sentText,/2026-11-11（Pacific\/Kiritimati）/);
  assert.equal(db.prepare("SELECT status FROM bot_report_deliveries WHERE report_date='2026-11-10'").get().status,'sent');
  assert.equal((await invoke('POST','/api/admin/bot-report/test')).statusCode,200);
  assert.equal(sends,2);
  assert.match(sentText,/【手动测试】/);
  db.close();
});
