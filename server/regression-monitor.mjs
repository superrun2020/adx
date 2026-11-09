import crypto from 'node:crypto';
import { localDate } from './gam-sync.mjs';

const cadences = [
  { name: 'day', days: 1, interval: 15 * 60_000 },
  { name: 'three_days', days: 3, interval: 24 * 3600_000 },
  { name: 'week', days: 7, interval: 72 * 3600_000 },
  { name: 'month', days: 30, interval: 168 * 3600_000 }
];

export function regressionWindow(timeZone, cadence, instant = new Date()) {
  const item = cadences.find(row => row.name === cadence);
  if (!item) throw new Error('invalid_regression_cadence');
  const endOffset = item.days === 1 ? 0 : -1;
  return {
    cadence, start: localDate(timeZone, endOffset - item.days + 1, instant),
    end: localDate(timeZone, endOffset, instant),
    baselineStart: item.days === 1 ? '' : localDate(timeZone, endOffset - item.days * 2 + 1, instant),
    baselineEnd: item.days === 1 ? '' : localDate(timeZone, endOffset - item.days, instant),
    interval: item.interval
  };
}

export function alertQualified(before, after, settings) {
  return before.revenue > settings.min_revenue && before.revenue > 0 &&
    (before.revenue - after.revenue) * 100 / before.revenue >= settings.min_drop_percent - 1e-9;
}

export function firstDropDate(domain, dailyRows, previous) {
  let first = null;
  const current = new Map(dailyRows.map(row => [row.reportDate + '\0' + row.domain, row]));
  const coveredDates = new Set(dailyRows.map(row => row.reportDate));
  for (const [key, prior] of previous) {
    const separator = key.indexOf('\0');
    if (key.slice(separator + 1) !== domain) continue;
    const date = key.slice(0, separator);
    if (!coveredDates.has(date)) continue;
    if (prior.revenue - (current.get(key)?.revenue || 0) > 1e-6 && (first === null || date < first)) first = date;
  }
  return first;
}

function validWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/open-apis\/bot\/v2\/hook\/.+/.test(url.pathname);
  } catch { return false; }
}

function validDate(value) {
  const date = new Date(value + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function accountTimestamp(timeZone, instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function registerRegressionMonitor(app, { db, requireAuth, requireAdmin, encryptCredential, decryptCredential, transaction, gamSync, audit }) {
  db.exec("CREATE TABLE IF NOT EXISTS regression_settings (id INTEGER PRIMARY KEY CHECK(id=1), feishu_enabled INTEGER NOT NULL DEFAULT 0, min_revenue REAL NOT NULL DEFAULT 50, min_drop_percent REAL NOT NULL DEFAULT 2, webhook_ciphertext TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("CREATE TABLE IF NOT EXISTS regression_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, soap_account_id INTEGER NOT NULL, cadence TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, baseline_start TEXT NOT NULL DEFAULT '', baseline_end TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE)");
  db.exec("CREATE TABLE IF NOT EXISTS regression_snapshots (run_id INTEGER NOT NULL, domain TEXT NOT NULL, revenue REAL NOT NULL, requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, PRIMARY KEY(run_id,domain), FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE)");
  db.exec("CREATE TABLE IF NOT EXISTS regression_daily_snapshots (run_id INTEGER NOT NULL, soap_account_id INTEGER NOT NULL, report_date TEXT NOT NULL, domain TEXT NOT NULL, revenue REAL NOT NULL, requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, PRIMARY KEY(run_id,report_date,domain), FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE, FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE)");
  db.exec("CREATE TABLE IF NOT EXISTS regression_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, soap_account_id INTEGER NOT NULL, cadence TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, domain TEXT NOT NULL, old_revenue REAL NOT NULL, new_revenue REAL NOT NULL, old_requests INTEGER NOT NULL, new_requests INTEGER NOT NULL, old_impressions INTEGER NOT NULL, new_impressions INTEGER NOT NULL, old_clicks INTEGER NOT NULL, new_clicks INTEGER NOT NULL, alert_status TEXT NOT NULL DEFAULT 'not_triggered', alert_error TEXT NOT NULL DEFAULT '', notified_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE, FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE)");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('regression_events') WHERE name='drop_start_date'").get())
    db.exec('ALTER TABLE regression_events ADD COLUMN drop_start_date TEXT');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('regression_events') WHERE name='send_attempts'").get())
    db.exec('ALTER TABLE regression_events ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('regression_events') WHERE name='last_attempt_at'").get())
    db.exec('ALTER TABLE regression_events ADD COLUMN last_attempt_at TEXT');
  db.exec('INSERT OR IGNORE INTO regression_settings(id) VALUES(1)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_regression_runs_due ON regression_runs(soap_account_id,cadence,finished_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_regression_runs_retention ON regression_runs(cadence,finished_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_regression_events_filter ON regression_events(created_at,soap_account_id,cadence,domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_regression_daily_lookup ON regression_daily_snapshots(soap_account_id,report_date,domain,run_id DESC)');

  const settings = () => db.prepare('SELECT * FROM regression_settings WHERE id=1').get();
  const publicSettings = row => ({ feishuEnabled: !!row.feishu_enabled, minRevenue: row.min_revenue,
    minDropPercent: row.min_drop_percent, webhookConfigured: !!row.webhook_ciphertext });

  app.get('/api/admin/regression/settings', requireAuth, requireAdmin, (_req, res) =>
    res.json({ ok: true, settings: publicSettings(settings()) }));
  app.put('/api/admin/regression/settings', requireAuth, requireAdmin, (req, res) => {
    const input = req.body || {};
    const minRevenue = Number(input.minRevenue), minPercent = Number(input.minDropPercent);
    if (typeof input.feishuEnabled !== 'boolean') return res.status(400).json({ ok: false, error: 'invalid_regression_enabled' });
    if (input.minRevenue === '' || input.minRevenue == null || input.minDropPercent === '' || input.minDropPercent == null || !Number.isFinite(minRevenue) || !Number.isFinite(minPercent) || minRevenue < 0 || minRevenue > 1e9 || minPercent <= 0 || minPercent > 100)
      return res.status(400).json({ ok: false, error: 'invalid_regression_threshold' });
    const current = settings();
    let saved = current.webhook_ciphertext ? decryptCredential(current.webhook_ciphertext) : { url: '', secret: '' };
    if (input.clearWebhook === true) saved = { url: '', secret: '' };
    if (input.webhook != null && input.webhook !== '') {
      if (typeof input.webhook !== 'string' || !validWebhook(input.webhook.trim())) return res.status(400).json({ ok: false, error: 'invalid_feishu_webhook' });
      saved.url = input.webhook.trim();
    }
    if (input.signingSecret != null && (typeof input.signingSecret !== 'string' || input.signingSecret.length > 500))
      return res.status(400).json({ ok: false, error: 'invalid_feishu_secret' });
    if (input.clearSigningSecret === true) saved.secret = '';
    else if (input.signingSecret?.trim()) saved.secret = input.signingSecret.trim();
    if (saved.url && !validWebhook(saved.url)) return res.status(400).json({ ok: false, error: 'invalid_feishu_webhook' });
    if (input.feishuEnabled && !saved.url) return res.status(400).json({ ok: false, error: 'invalid_feishu_webhook_required' });
    const cipher = saved.url ? encryptCredential(saved) : '';
    db.prepare('UPDATE regression_settings SET feishu_enabled=?,min_revenue=?,min_drop_percent=?,webhook_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=1')
      .run(input.feishuEnabled ? 1 : 0, minRevenue, minPercent, cipher);
    audit(req.user.email, 'regression.settings_update', 'regression_settings', 1,
      JSON.stringify({ feishuEnabled: input.feishuEnabled, minRevenue, minDropPercent: minPercent, webhookConfigured: !!saved.url }), req.ip);
    res.json({ ok: true, settings: publicSettings(settings()) });
  });

  app.get('/api/admin/regression/events', requireAuth, requireAdmin, (req, res) => {
    const { start = '', end = '', cadence = '', accountId = '', domain = '', alertsOnly = '' } = req.query;
    if ((start && !validDate(String(start))) || (end && !validDate(String(end))) || (start && end && start > end))
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    if (cadence && !cadences.some(item => item.name === cadence)) return res.status(400).json({ ok: false, error: 'invalid_regression_cadence' });
    if (accountId && (!/^\d+$/.test(String(accountId)) || Number(accountId) < 1)) return res.status(400).json({ ok: false, error: 'invalid_account_id' });
    if (String(domain).length > 200) return res.status(400).json({ ok: false, error: 'invalid_domain_filter' });
    const where = ['1=1'], args = [];
    if (start) { where.push('e.period_end>=?'); args.push(start); }
    if (end) { where.push('e.period_end<=?'); args.push(end); }
    if (cadence) { where.push('e.cadence=?'); args.push(cadence); }
    if (accountId) { where.push('e.soap_account_id=?'); args.push(Number(accountId)); }
    if (String(domain).trim()) { where.push('e.domain LIKE ?'); args.push('%' + String(domain).trim() + '%'); }
    if (alertsOnly === '1') where.push("e.alert_status IN ('sent','failed','duplicate','disabled','pending')");
    const clause = where.join(' AND ');
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const total = db.prepare('SELECT COUNT(*) total FROM regression_events e WHERE ' + clause).get(...args).total;
    const items = db.prepare(`SELECT e.id,e.cadence,e.period_start periodStart,e.period_end periodEnd,e.domain,s.name accountName,s.network_code networkCode,s.rest_network_timezone timeZone,e.old_revenue oldRevenue,e.new_revenue newRevenue,(e.new_revenue-e.old_revenue) revenueDelta,CASE WHEN e.old_revenue>0 THEN ROUND((e.new_revenue-e.old_revenue)*100.0/e.old_revenue,4) ELSE 0 END differencePercent,(e.new_requests-e.old_requests) requestsDelta,(e.new_impressions-e.old_impressions) impressionsDelta,(e.new_clicks-e.old_clicks) clicksDelta,COALESCE(e.drop_start_date,CASE WHEN e.cadence='day' AND e.alert_status<>'not_triggered' THEN e.period_start END) dropStartDate,e.alert_status alertStatus,e.alert_error alertError,e.notified_at notifiedAt,e.created_at createdAt FROM regression_events e JOIN soap_accounts s ON s.id=e.soap_account_id WHERE ` + clause + ' ORDER BY e.id DESC LIMIT 100 OFFSET ?').all(...args, (page-1)*100);
    res.json({ ok: true, items, total, page, pageSize: 100 });
  });
  app.get('/api/admin/regression/runs', requireAuth, requireAdmin, (_req, res) => {
    const items = db.prepare('SELECT r.id,r.cadence,r.period_start periodStart,r.period_end periodEnd,r.baseline_start baselineStart,r.baseline_end baselineEnd,r.status,r.detail,r.started_at startedAt,r.finished_at finishedAt,s.name accountName,s.rest_network_timezone timeZone FROM regression_runs r JOIN soap_accounts s ON s.id=r.soap_account_id ORDER BY r.id DESC LIMIT 60').all();
    res.json({ ok: true, items });
  });

  const empty = () => ({ revenue: 0, requests: 0, impressions: 0, clicks: 0 });
  const facts = (account, start, end) => {
    const upstream = db.prepare("SELECT account_key FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'").get(account.rest_upstream_account_id, account.id);
    if (!upstream) throw new Error('rest_report_mapping_inactive');
    const rows = db.prepare("SELECT domain,SUM(revenue) revenue,SUM(requests) requests,SUM(impressions) impressions,SUM(clicks) clicks FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ? GROUP BY domain")
      .all(account.rest_channel_id, upstream.account_key, start, end, 'gam-rest:' + account.network_code + ':%');
    return new Map(rows.map(({ domain, ...row }) => [domain, row]));
  };
  const dailyFacts = (account, start, end) => {
    const upstream = db.prepare("SELECT account_key FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'").get(account.rest_upstream_account_id, account.id);
    if (!upstream) throw new Error('rest_report_mapping_inactive');
    return db.prepare("SELECT report_date reportDate,domain,SUM(revenue) revenue,SUM(requests) requests,SUM(impressions) impressions,SUM(clicks) clicks FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ? GROUP BY report_date,domain ORDER BY report_date,domain")
      .all(account.rest_channel_id, upstream.account_key, start, end, 'gam-rest:' + account.network_code + ':%');
  };
  const previousDaily = (account, start, end, priorRunCutoff) => {
    const rows = db.prepare('SELECT report_date reportDate,domain,revenue FROM regression_daily_snapshots WHERE soap_account_id=? AND report_date BETWEEN ? AND ? AND run_id<=? ORDER BY run_id DESC')
      .all(account.id, start, end, priorRunCutoff);
    const latest = new Map();
    for (const row of rows) {
      const key = row.reportDate + '\0' + row.domain;
      if (!latest.has(key)) latest.set(key, row);
    }
    return latest;
  };
  const coveredDays = (account, start, end) => {
    const upstream = db.prepare("SELECT account_key FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'").get(account.rest_upstream_account_id, account.id);
    if (!upstream) throw new Error('rest_report_mapping_inactive');
    return db.prepare("SELECT COUNT(DISTINCT report_date) days FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ?")
      .get(account.rest_channel_id, upstream.account_key, start, end, 'gam-rest:' + account.network_code + ':%').days;
  };
  const saveRun = (account, window, status, detail = '', old = null, newer = new Map(), dailyRows = [], priorDaily = new Map()) => transaction(() => {
    const runId = Number(db.prepare('INSERT INTO regression_runs(soap_account_id,cadence,period_start,period_end,baseline_start,baseline_end,status,detail) VALUES(?,?,?,?,?,?,?,?)')
      .run(account.id, window.cadence, window.start, window.end, window.baselineStart, window.baselineEnd, status, detail).lastInsertRowid);
    const alerts = [];
    if (status !== 'success') return alerts;
    for (const [domain, row] of newer) db.prepare('INSERT INTO regression_snapshots(run_id,domain,revenue,requests,impressions,clicks) VALUES(?,?,?,?,?,?)')
      .run(runId, domain, row.revenue, row.requests, row.impressions, row.clicks);
    const insertDaily = db.prepare('INSERT INTO regression_daily_snapshots(run_id,soap_account_id,report_date,domain,revenue,requests,impressions,clicks) VALUES(?,?,?,?,?,?,?,?)');
    for (const row of dailyRows) insertDaily.run(runId, account.id, row.reportDate, row.domain, row.revenue, row.requests, row.impressions, row.clicks);
    if (!old) return alerts;
    const config = settings();
    for (const domain of [...new Set([...old.keys(), ...newer.keys()])].sort()) {
      const before = old.get(domain) || empty(), after = newer.get(domain) || empty();
      if (Math.abs(before.revenue-after.revenue) < 1e-6 && before.requests === after.requests && before.impressions === after.impressions && before.clicks === after.clicks) continue;
      let alertStatus = 'not_triggered';
      if (alertQualified(before, after, config)) {
        if (!config.feishu_enabled || !config.webhook_ciphertext) alertStatus = 'disabled';
        else if (db.prepare("SELECT 1 FROM regression_events WHERE soap_account_id=? AND cadence=? AND period_start=? AND period_end=? AND domain=? AND (alert_status='sent' OR (alert_status IN ('pending','failed') AND send_attempts<5)) LIMIT 1").get(account.id, window.cadence, window.start, window.end, domain)) alertStatus = 'duplicate';
        else alertStatus = 'pending';
      }
      const dropStartDate = alertStatus === 'not_triggered' ? null : window.cadence === 'day' ? window.start : firstDropDate(domain, dailyRows, priorDaily);
      const id = Number(db.prepare('INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks,alert_status,drop_start_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(runId, account.id, window.cadence, window.start, window.end, domain, before.revenue, after.revenue, before.requests, after.requests, before.impressions, after.impressions, before.clicks, after.clicks, alertStatus, dropStartDate).lastInsertRowid);
      if (alertStatus === 'pending') alerts.push({ id, domain, before, after, dropStartDate });
    }
    return alerts;
  });

  const notify = async (account, window, alerts) => {
    const config = settings();
    if (!config.feishu_enabled || !config.webhook_ciphertext) return;
    const { url, secret } = decryptCredential(config.webhook_ciphertext);
    const channelName = db.prepare('SELECT name FROM channels WHERE id=?').get(account.rest_channel_id)?.name || '未关联渠道';
    const timeZone = account.rest_network_timezone || 'UTC';
    const detectedAt = accountTimestamp(timeZone);
    for (let offset = 0; offset < alerts.length; offset += 20) {
      const batch = alerts.slice(offset, offset + 20);
      const lines = ['AdX 数据回退监测（正式触发）', 'GAM 账户：' + account.name + '（' + account.network_code + '）',
        '关联渠道：' + channelName, '监测时间：' + detectedAt + '（' + timeZone + '）',
        '监测周期：' + ({day:'单日快照',three_days:'近 3 天',week:'近 7 天',month:'近 30 天'}[window.cadence] || window.cadence),
        '数据日期：' + window.start + (window.start === window.end ? '' : ' 至 ' + window.end)];
      for (const row of batch) lines.push('域名：' + row.domain + '\n倒扣起始数据日：' + (row.dropStartDate || '无法确定（尚无同日历史快照）') +
        '\n收入：$' + row.before.revenue.toFixed(2) + ' → $' + row.after.revenue.toFixed(2) +
        '；减少 $' + (row.before.revenue-row.after.revenue).toFixed(2) + '（' + ((row.before.revenue-row.after.revenue)*100/row.before.revenue).toFixed(2) + '%）' +
        '；请求 ' + (row.after.requests-row.before.requests) + '，展示 ' + (row.after.impressions-row.before.impressions) + '，点击 ' + (row.after.clicks-row.before.clicks));
      const payload = { msg_type: 'text', content: { text: lines.join('\n') } };
      if (secret) {
        const timestamp = String(Math.floor(Date.now()/1000));
        payload.timestamp = timestamp;
        payload.sign = crypto.createHmac('sha256', timestamp + '\n' + secret).update('').digest('base64');
      }
      let status = 'sent', detail = '';
      try {
        if (!validWebhook(url)) throw new Error('invalid_feishu_webhook');
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('feishu_http_' + response.status);
        const body = await response.json();
        if (body.code !== 0) throw new Error('feishu_rejected_message');
      } catch (error) { status = 'failed'; detail = String(error.message).slice(0, 500); }
      for (const row of batch) db.prepare("UPDATE regression_events SET alert_status=?,alert_error=?,send_attempts=send_attempts+1,last_attempt_at=CURRENT_TIMESTAMP,notified_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?")
        .run(status, detail, status, row.id);
      if (detail) console.error('regression_feishu_failed', account.id, window.cadence, detail);
    }
  };

  const retryPendingAlerts = async account => {
    const config = settings();
    if (!config.feishu_enabled || !config.webhook_ciphertext) return;
    const rows = db.prepare(`SELECT id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks,drop_start_date
      FROM regression_events WHERE soap_account_id=? AND alert_status IN ('pending','failed') AND send_attempts<5
      AND (last_attempt_at IS NULL OR last_attempt_at<=datetime('now','-15 minutes'))
      ORDER BY id DESC LIMIT 100`).all(account.id);
    const groups = new Map();
    const seen = new Set();
    for (const row of rows) {
      const sent = db.prepare("SELECT 1 FROM regression_events WHERE soap_account_id=? AND cadence=? AND period_start=? AND period_end=? AND domain=? AND alert_status='sent' AND id<>? LIMIT 1")
        .get(account.id, row.cadence, row.period_start, row.period_end, row.domain, row.id);
      if (sent) {
        db.prepare("UPDATE regression_events SET alert_status='duplicate' WHERE id=?").run(row.id);
        continue;
      }
      const alertKey = [row.cadence, row.period_start, row.period_end, row.domain].join('|');
      if (seen.has(alertKey)) {
        db.prepare("UPDATE regression_events SET alert_status='duplicate' WHERE id=?").run(row.id);
        continue;
      }
      seen.add(alertKey);
      const alert = { id: row.id, domain: row.domain, dropStartDate: row.drop_start_date || (row.cadence === 'day' ? row.period_start : null),
        before: { revenue: row.old_revenue, requests: row.old_requests, impressions: row.old_impressions, clicks: row.old_clicks },
        after: { revenue: row.new_revenue, requests: row.new_requests, impressions: row.new_impressions, clicks: row.new_clicks } };
      const key = [row.cadence, row.period_start, row.period_end].join('|');
      if (!groups.has(key)) groups.set(key, { window: { cadence: row.cadence, start: row.period_start, end: row.period_end }, alerts: [] });
      groups.get(key).alerts.push(alert);
    }
    for (const group of groups.values()) {
      try { await notify(account, group.window, group.alerts); }
      catch (error) { console.error('regression_retry_failed', account.id, group.window.cadence, error.message); }
    }
  };

  async function runForAccount(account) {
    db.exec("DELETE FROM regression_runs WHERE (cadence='day' AND finished_at<datetime('now','-90 days')) OR (cadence<>'day' AND finished_at<datetime('now','-365 days'))");
    const priorRunCutoff = db.prepare('SELECT COALESCE(MAX(id),0) id FROM regression_runs').get().id;
    await retryPendingAlerts(account);
    for (const cadence of cadences) {
      let networkWindow;
      const instant = new Date();
      try { networkWindow = regressionWindow(account.rest_network_timezone, cadence.name, instant); }
      catch (error) { console.error('regression_timezone_invalid', account.id, error.message); return; }
      const yesterday = localDate(account.rest_network_timezone, -1, instant);
      const windows = cadence.days === 1 ? [networkWindow, { ...networkWindow, start: yesterday, end: yesterday }] : [networkWindow];
      for (const window of windows) {
        if (cadence.days === 1 && !facts(account, window.start, window.end).size) continue;
        const previous = window.cadence === 'day'
          ? db.prepare("SELECT MAX(finished_at) finished_at FROM regression_runs WHERE soap_account_id=? AND cadence=? AND period_start=? AND status IN ('success','skipped')").get(account.id, window.cadence, window.start)
          : db.prepare("SELECT MAX(finished_at) finished_at FROM regression_runs WHERE soap_account_id=? AND cadence=? AND status IN ('success','skipped')").get(account.id, window.cadence);
        if (previous.finished_at && Date.now() - Date.parse(previous.finished_at.replace(' ', 'T') + 'Z') < window.interval - 60_000) continue;
        try {
          let old = null;
          if (cadence.days === 1) {
            const last = db.prepare("SELECT id FROM regression_runs WHERE soap_account_id=? AND cadence='day' AND period_start=? AND status='success' ORDER BY id DESC LIMIT 1").get(account.id, window.start);
            if (last) old = new Map(db.prepare('SELECT domain,revenue,requests,impressions,clicks FROM regression_snapshots WHERE run_id=?').all(last.id).map(({ domain, ...row }) => [domain, row]));
          } else {
            const baseline = await gamSync.execute(account, { start: window.baselineStart, end: window.baselineEnd, write: true });
            if (!baseline.rows || coveredDays(account, window.baselineStart, window.baselineEnd) !== cadence.days) { saveRun(account, window, 'skipped', '基准时间段没有完整的逐日域名数据'); continue; }
            old = facts(account, window.baselineStart, window.baselineEnd);
            if (!old.size) { saveRun(account, window, 'skipped', '基准时间段没有可比较的域名数据'); continue; }
            const current = await gamSync.execute(account, { start: window.start, end: window.end, write: true });
            if (!current.rows || coveredDays(account, window.start, window.end) !== cadence.days) { saveRun(account, window, 'skipped', '当前时间段没有完整的逐日域名数据'); continue; }
          }
          const newer = facts(account, window.start, window.end);
          if (!newer.size) { saveRun(account, window, 'skipped', '当前时间段没有可比较的域名数据'); continue; }
          const dailyRows = dailyFacts(account, window.start, window.end);
          const priorDaily = previousDaily(account, window.start, window.end, priorRunCutoff);
          const alerts = saveRun(account, window, 'success', '', old, newer, dailyRows, priorDaily);
          if (alerts.length) await notify(account, window, alerts);
        } catch (error) {
          console.error('regression_failed', account.id, window.cadence, error.message);
          saveRun(account, window, 'failed', String(error.message).slice(0, 500));
        }
      }
    }
  }
  return { runForAccount };
}
