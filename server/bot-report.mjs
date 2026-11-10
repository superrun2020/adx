import { localDate } from './gam-sync.mjs';

function validWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/open-apis\/bot\/v2\/hook\/.+/.test(url.pathname);
  } catch { return false; }
}

export function botReportDate(instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(instant).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 23 * 60 + 45) return localDate('Asia/Shanghai', 0, instant);
  if (minutes < 6 * 60) return localDate('Asia/Shanghai', -1, instant);
  return '';
}

function reportMessage(date, instant, totals) {
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(instant);
  const lines = ['【AdX 每日经营汇报】', '汇报批次：' + date + '（北京时间）',
    '统计时间：' + stamp + '（Asia/Shanghai）'];
  if (!totals.rows) lines.push('暂无已同步的 GAM REST 明细，流水和利润暂不可确认。');
  else {
    const profit = totals.upstreamRevenue * 0.85 - totals.channelRevenue;
    lines.push('流水（GAM REST 原始收入）：$' + totals.grossRevenue.toFixed(2),
      '利润（上游分成后收入 × 85% − 渠道结算）：$' + profit.toFixed(2),
      '已同步明细：' + totals.rows + ' 条');
    if (totals.lastImport) lines.push('最近入库（UTC）：' + totals.lastImport);
  }
  for (const account of totals.accounts) lines.push('账号：' + account.name + '（Network ' + account.networkCode + '） · ' +
    account.date + '（' + account.timeZone + '） · 流水 $' + account.revenue.toFixed(2) +
    ' · 利润 $' + account.profit.toFixed(2));
  lines.push('当天数值为截至统计时间的快照；GAM 后续修订以数据报告为准。');
  return lines.join('\n');
}

async function postFeishu(webhook, content) {
  if (!validWebhook(webhook)) throw new Error('invalid_feishu_webhook');
  let response;
  try {
    response = await fetch(webhook, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ msg_type:'text', content:{ text:content } }),
      redirect:'manual', signal:AbortSignal.timeout(10_000) });
  } catch { throw new Error('feishu_transport_failed'); }
  if (!response.ok) throw new Error('feishu_http_' + response.status);
  const body = await response.json();
  if (body.code !== 0) throw new Error('feishu_rejected_message');
}

export function registerBotReport(app, { db, requireAuth, requireAdmin, encryptCredential, decryptCredential,
  upstreamShareSql, settledRevenueSql, audit, send = postFeishu }) {
  db.exec("CREATE TABLE IF NOT EXISTS bot_report_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, webhook_ciphertext TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("CREATE TABLE IF NOT EXISTS bot_report_deliveries (report_date TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, sent_at TEXT, error TEXT NOT NULL DEFAULT '')");
  db.exec('INSERT OR IGNORE INTO bot_report_settings(id) VALUES(1)');
  const config = () => db.prepare('SELECT enabled,webhook_ciphertext FROM bot_report_settings WHERE id=1').get();
  const last = () => db.prepare('SELECT report_date reportDate,status,attempts,last_attempt_at lastAttemptAt,sent_at sentAt,error FROM bot_report_deliveries ORDER BY report_date DESC LIMIT 1').get() || null;
  const accountTotalsFor = (date, source) => db.prepare('SELECT COUNT(*) rows,COALESCE(SUM(rf.revenue),0) grossRevenue,' +
    'COALESCE(SUM(rf.revenue*(' + upstreamShareSql('rf') + ')/100.0),0) upstreamRevenue,' +
    'COALESCE(SUM(' + settledRevenueSql('rf') + '),0) channelRevenue,MAX(rf.imported_at) lastImport ' +
    'FROM revenue_facts rf WHERE rf.report_date=? AND rf.source_file LIKE ?').get(date, source);
  const totalsAt = (now = new Date()) => {
    const accounts = db.prepare("SELECT name,network_code,rest_network_timezone FROM soap_accounts WHERE status='active' AND rest_sync_enabled=1 AND enabled=1 ORDER BY id").all();
    const result = { rows:0, grossRevenue:0, upstreamRevenue:0, channelRevenue:0, lastImport:null, accounts:[] };
    for (const account of accounts) {
      let zone = account.rest_network_timezone || 'UTC';
      try { new Intl.DateTimeFormat('en-US', { timeZone:zone }); } catch { zone = 'UTC'; }
      const date = localDate(zone, 0, now);
      const row = accountTotalsFor(date, 'gam-rest:' + account.network_code + ':%');
      for (const key of ['rows','grossRevenue','upstreamRevenue','channelRevenue']) result[key] += row[key];
      if (row.lastImport && (!result.lastImport || row.lastImport > result.lastImport)) result.lastImport = row.lastImport;
      result.accounts.push({ name:account.name, networkCode:account.network_code, timeZone:zone, date,
        rows:row.rows, revenue:row.grossRevenue, profit:row.upstreamRevenue * 0.85 - row.channelRevenue });
    }
    return result;
  };
  const previewFor = (instant = new Date()) => {
    const totals = totalsAt(instant);
    return { date:localDate('Asia/Shanghai', 0, instant), rows:totals.rows, lastImport:totals.lastImport,
      accounts:totals.accounts,
      ...(totals.rows ? { revenue:totals.grossRevenue, profit:totals.upstreamRevenue * 0.85 - totals.channelRevenue } : {}) };
  };
  const settings = () => {
    const row = config();
    return { enabled:!!row.enabled, webhookConfigured:!!row.webhook_ciphertext,
      schedule:'23:45 Asia/Shanghai', lastDelivery:last() };
  };
  app.get('/api/admin/bot-report/settings', requireAuth, requireAdmin, (_req, res) =>
    res.json({ ok:true, settings:settings(), preview:previewFor() }));
  app.put('/api/admin/bot-report/settings', requireAuth, requireAdmin, (req, res) => {
    const input = req.body || {};
    if (typeof input.enabled !== 'boolean') return res.status(400).json({ ok:false, error:'invalid_bot_report_enabled' });
    const current = config();
    let credential = current.webhook_ciphertext ? decryptCredential(current.webhook_ciphertext) : { url:'' };
    if (input.clearWebhook === true) credential.url = '';
    if (input.webhook != null && input.webhook !== '') {
      if (typeof input.webhook !== 'string' || !validWebhook(input.webhook.trim()))
        return res.status(400).json({ ok:false, error:'invalid_feishu_webhook' });
      credential.url = input.webhook.trim();
    }
    if (input.enabled && !credential.url) return res.status(400).json({ ok:false, error:'invalid_feishu_webhook_required' });
    const cipher = credential.url ? encryptCredential(credential) : '';
    db.prepare('UPDATE bot_report_settings SET enabled=?,webhook_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=1')
      .run(input.enabled ? 1 : 0, cipher);
    audit(req.user.email, 'bot_report.settings_update', 'bot_report_settings', 1,
      JSON.stringify({ enabled:input.enabled, webhookConfigured:!!credential.url }), req.ip);
    res.json({ ok:true, settings:settings(), preview:previewFor() });
  });
  app.post('/api/admin/bot-report/test', requireAuth, requireAdmin, async (req, res) => {
    const row = config();
    if (!row.webhook_ciphertext) return res.status(400).json({ ok:false, error:'bot_report_webhook_required' });
    try {
      const credential = decryptCredential(row.webhook_ciphertext);
      const now = new Date(), date = localDate('Asia/Shanghai', 0, now);
      await send(credential.url, '【手动测试】\n' + reportMessage(date, now, totalsAt(now)));
      audit(req.user.email, 'bot_report.test', 'bot_report_settings', 1, '', req.ip);
      res.json({ ok:true });
    } catch (error) {
      console.error('bot_report_test_failed', error.message);
      res.status(502).json({ ok:false, error:'bot_report_send_failed' });
    }
  });
  const runAt = async (now = new Date()) => {
    const date = botReportDate(now), row = config();
    if (!date || !row.enabled || !row.webhook_ciphertext) return;
    const clock = now.toISOString().slice(0,19).replace('T',' ');
    const cutoff = new Date(now.valueOf() - 15*60_000).toISOString().slice(0,19).replace('T',' ');
    db.prepare('INSERT OR IGNORE INTO bot_report_deliveries(report_date) VALUES(?)').run(date);
    const claimed = db.prepare("UPDATE bot_report_deliveries SET status='sending',attempts=attempts+1,last_attempt_at=?,error='' WHERE report_date=? AND status<>'sent' AND (last_attempt_at IS NULL OR last_attempt_at<=?)")
      .run(clock, date, cutoff).changes;
    if (!claimed) return;
    try {
      const credential = decryptCredential(row.webhook_ciphertext);
      await send(credential.url, reportMessage(date, now, totalsAt(new Date(date + 'T15:45:00Z'))));
      db.prepare("UPDATE bot_report_deliveries SET status='sent',error='',sent_at=? WHERE report_date=?").run(clock, date);
    } catch (error) {
      db.prepare("UPDATE bot_report_deliveries SET status='failed',error=?,sent_at=NULL WHERE report_date=?")
        .run(String(error.message).slice(0,500), date);
      throw error;
    }
  };
  return { runAt, totalsAt, previewFor };
}
