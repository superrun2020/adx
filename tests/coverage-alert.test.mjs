import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { coverageQualified, registerCoverageAlert } from '../server/coverage-alert.mjs';

test('coverage alert compares completed local hours, excludes archived units and retries once', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE regression_settings(id INTEGER PRIMARY KEY,feishu_enabled INTEGER,coverage_feishu_enabled INTEGER,coverage_drop_points REAL,coverage_min_requests INTEGER,webhook_ciphertext TEXT)");
  db.exec("CREATE TABLE coverage_alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,soap_account_id INTEGER,report_date TEXT,report_hour INTEGER,domain TEXT,channel_id INTEGER,baseline_requests INTEGER,baseline_matched INTEGER,current_requests INTEGER,current_matched INTEGER,status TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,last_attempt_at TEXT,sent_at TEXT,error TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(soap_account_id,report_date,domain))");
  db.exec("CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT,action TEXT,detail TEXT,created_at TEXT)");
  db.exec("CREATE TABLE upstream_accounts(id INTEGER,soap_account_id INTEGER,account_key TEXT,status TEXT)");
  db.exec("CREATE TABLE channels(id INTEGER,name TEXT)");
  db.exec("CREATE TABLE soap_accounts(id INTEGER,name TEXT,network_code TEXT,rest_network_timezone TEXT)");
  db.exec("CREATE TABLE gam_channel_assignments(soap_account_id INTEGER,channel_id INTEGER,effective_from TEXT)");
  db.exec("CREATE TABLE revenue_facts(account TEXT,report_date TEXT,hour INTEGER,domain TEXT,ad_unit_id TEXT,requests INTEGER,matched_requests INTEGER,source_file TEXT)");
  db.exec("INSERT INTO regression_settings VALUES(1,0,1,30,100,'encrypted')");
  db.exec("INSERT INTO upstream_accounts VALUES(1,1,'acct','active')");
  db.exec("INSERT INTO channels VALUES(1,'Default'),(2,'Rinser')");
  db.exec("INSERT INTO soap_accounts VALUES(1,'GAM','123','Asia/Singapore')");
  db.exec("INSERT INTO audit_logs(target_id,action,detail,created_at) VALUES('123','gam.ad_unit_archive','{\"names\":[\"networks/123/adUnits/200\"]}','2026-11-20 03:00:00')");
  const account = { id:1, name:'GAM', network_code:'123', rest_network_timezone:'Asia/Singapore', rest_channel_id:1, rest_upstream_account_id:1 };
  let sends=0;
  const routes=new Map(), app={get:(path,...handlers)=>routes.set(path,handlers.at(-1))};
  const coverage = registerCoverageAlert({ app, requireAuth:()=>{}, requireAdmin:()=>{}, db,
    decryptCredential:() => ({url:'https://open.feishu.cn/open-apis/bot/v2/hook/test'}),
    send:async (_url,_secret,message) => {
      sends++;
      assert.match(message,/news\.example\.test（渠道：Rinser）：99\.00% → 1\.00%/);
      assert.doesNotMatch(message,/paused\.test|small\.test/);
      if (sends === 1) throw new Error('temporary failure');
    } });
  db.exec("INSERT INTO gam_domain_channel_assignments(root_domain,channel_id,effective_from,created_by) VALUES('example.test',2,'1900-01-01','test')");
  const insert = db.prepare('INSERT INTO revenue_facts VALUES(?,?,?,?,?,?,?,?)');
  for (const [date,domain,id,requests,matched] of [
    ['2026-11-19','news.example.test','100',1000,990],['2026-11-20','news.example.test','100',2000,20],
    ['2026-11-19','paused.test','200',500,500],['2026-11-20','paused.test','200',500,0],
    ['2026-11-19','small.test','300',20,20],['2026-11-20','small.test','300',20,0]
  ]) insert.run('acct',date,11,domain,id,requests,matched,'gam-rest:123:test');
  const now = new Date('2026-11-20T04:15:00Z');
  for (const minutes of [0,1,16,17]) await coverage.runForAccount(account,new Date(now.getTime()+minutes*60_000));
  assert.equal(sends,2);
  assert.deepEqual(db.prepare('SELECT domain,status,attempts FROM coverage_alerts').all().map(row => ({...row})),[
    {domain:'news.example.test',status:'sent',attempts:2}
  ]);
  let body;
  routes.get('/api/admin/regression/coverage-events')({query:{accountId:'1',domain:'news.example.test'}},
    {json(value){body=value;return this},status(){return this}});
  assert.equal(body.items.length,1);
  assert.equal(body.items[0].baselineCoverage,99);
  assert.equal(body.items[0].currentCoverage,1);
  db.close();
});

test('coverage threshold requires enough requests in both matching hours', () => {
  const settings={coverage_drop_points:30,coverage_min_requests:100};
  assert.equal(coverageQualified({before:{requests:100,matched:99},after:{requests:200,matched:2}},settings),true);
  assert.equal(coverageQualified({before:{requests:99,matched:99},after:{requests:200,matched:0}},settings),false);
  assert.equal(coverageQualified({before:{requests:100,matched:99},after:{requests:99,matched:0}},settings),false);
  assert.equal(coverageQualified({before:{requests:100,matched:70},after:{requests:200,matched:100}},settings),false);
});
