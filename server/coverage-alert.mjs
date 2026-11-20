import crypto from 'node:crypto';
import { localDate } from './gam-sync.mjs';
import { gamChannelForDate } from './gam-channel-assignment.mjs';

export const coveragePercent = ({ requests, matched }) => requests > 0 ? matched * 100 / requests : 0;

export function coverageQualified(pair, settings) {
  return pair.before.requests >= settings.coverage_min_requests &&
    pair.after.requests >= settings.coverage_min_requests &&
    coveragePercent(pair.before) - coveragePercent(pair.after) >= settings.coverage_drop_points - 1e-9;
}

export function coverageAlertMessage(account, channel, date, baseline, timeZone, hour, instant, notices) {
  const found = new Intl.DateTimeFormat('sv-SE', { timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(instant);
  const lines = ['【AdX 覆盖率下降】', '账号：' + account.name + '（' + account.network_code + '）',
    '数据：' + date + ' ' + String(hour).padStart(2,'0') + ':00–' + String(hour).padStart(2,'0') + ':59（' + timeZone + '；对比 ' + baseline + ' 同小时）'];
  for (const item of notices) {
    const before = coveragePercent(item.before), after = coveragePercent(item.after);
    lines.push(item.domain + '（渠道：' + channel + '）：' + before.toFixed(2) + '% → ' + after.toFixed(2) +
      '%（降 ' + (before - after).toFixed(2) + ' 个百分点；请求 ' + item.before.requests + ' → ' + item.after.requests + '）');
  }
  lines.push('发现：' + found);
  return lines.join('\n');
}

async function postCoverageFeishu(webhook, secret, text) {
  const url = new URL(webhook);
  if (url.protocol !== 'https:' || !['open.feishu.cn','open.larksuite.com'].includes(url.hostname) ||
    url.port || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/.+/.test(url.pathname))
    throw new Error('invalid_feishu_webhook');
  const payload = { msg_type:'text', content:{ text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now()/1000));
    payload.timestamp = timestamp;
    payload.sign = crypto.createHmac('sha256', timestamp + '\n' + secret).update('').digest('base64');
  }
  const response = await fetch(webhook, { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload), redirect:'manual', signal:AbortSignal.timeout(10_000) });
  if (!response.ok || (await response.json()).code !== 0) throw new Error('feishu_rejected_message');
}

export function registerCoverageAlert({ db, decryptCredential, app, requireAuth, requireAdmin,
  now = () => new Date(), send = postCoverageFeishu }) {
  db.exec("CREATE TABLE IF NOT EXISTS gam_domain_channel_assignments (root_domain TEXT NOT NULL COLLATE NOCASE, channel_id INTEGER NOT NULL, effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(root_domain,effective_from))");
  if (app) app.get('/api/admin/regression/coverage-events', requireAuth, requireAdmin, (req,res) => {
    const query=req.query || {}, where=['1=1'], args=[];
    if (query.accountId) {
      const id=Number(query.accountId);
      if (!Number.isInteger(id) || id<1) return res.status(400).json({ok:false,error:'invalid_gam_account'});
      where.push('e.soap_account_id=?'); args.push(id);
    }
    if (query.domain) {
      const domain=String(query.domain).trim();
      if (domain.length>253) return res.status(400).json({ok:false,error:'invalid_domain'});
      where.push('e.domain LIKE ?'); args.push('%'+domain+'%');
    }
    for (const [key,op] of [['start','>='],['end','<=']]) if (query[key]) {
      const value=String(query[key]);
      const parsed=new Date(value+'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==value)
        return res.status(400).json({ok:false,error:'invalid_report_date'});
      where.push('e.report_date'+op+'?'); args.push(value);
    }
    if (query.start && query.end && query.start>query.end) return res.status(400).json({ok:false,error:'invalid_report_date'});
    const rows=db.prepare('SELECT e.id,e.report_date reportDate,e.report_hour reportHour,e.domain,s.name accountName,s.network_code networkCode,s.rest_network_timezone timeZone,c.name channelName,e.baseline_requests baselineRequests,e.baseline_matched baselineMatched,e.current_requests currentRequests,e.current_matched currentMatched,e.status,e.attempts,e.sent_at sentAt,e.created_at createdAt FROM coverage_alerts e JOIN soap_accounts s ON s.id=e.soap_account_id LEFT JOIN channels c ON c.id=e.channel_id WHERE '+where.join(' AND ')+' ORDER BY e.id DESC LIMIT 100').all(...args);
    res.json({ok:true,items:rows.map(row=>({...row,
      baselineCoverage:coveragePercent({requests:row.baselineRequests,matched:row.baselineMatched}),
      currentCoverage:coveragePercent({requests:row.currentRequests,matched:row.currentMatched})}))});
  });
  const archivedUnits = (network, instant) => {
    const states = new Map(), prefix = 'networks/' + network + '/adUnits/';
    const stamp = instant.toISOString().slice(0,19).replace('T',' ');
    const logs = db.prepare("SELECT action,detail FROM audit_logs WHERE target_id=? AND created_at<=? AND action IN ('gam.ad_unit_archive','gam.ad_unit_activate') ORDER BY id").all(network,stamp);
    for (const row of logs) {
      let detail;
      try { detail = JSON.parse(row.detail); } catch { continue; }
      for (const name of detail.names || []) {
        if (typeof name === 'string' && name.startsWith(prefix))
          states.set(name.slice(prefix.length), row.action === 'gam.ad_unit_archive');
      }
    }
    return new Set([...states].filter(([, archived]) => archived).map(([id]) => id));
  };
  const ownerFor = (domain, date, fallback, assignments) => {
    let owner = fallback, bestRoot = '', bestDate = '';
    for (const item of assignments) {
      const root = item.root_domain.toLowerCase();
      if (item.effective_from > date || (domain !== root && !domain.endsWith('.' + root))) continue;
      if (root.length > bestRoot.length || (root.length === bestRoot.length && item.effective_from >= bestDate)) {
        bestRoot = root; bestDate = item.effective_from; owner = item.channel_id;
      }
    }
    return owner;
  };
  const runForAccount = async (account, instant = now()) => {
    const config = db.prepare('SELECT * FROM regression_settings WHERE id=1').get();
    if (!config?.coverage_feishu_enabled || !config.webhook_ciphertext) return;
    const zone = account.rest_network_timezone;
    let hour;
    try { hour = Number(new Intl.DateTimeFormat('en-US', { timeZone:zone, hour:'2-digit', hourCycle:'h23' }).format(instant)) - 1; }
    catch { return; }
    if (hour < 0) return;
    const date = localDate(zone, 0, instant), baseline = localDate(zone, -1, instant);
    const upstream = db.prepare("SELECT account_key FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'")
      .get(account.rest_upstream_account_id, account.id);
    if (!upstream) return;
    const archived = archivedUnits(account.network_code, instant);
    const rows = db.prepare("SELECT report_date date,domain,ad_unit_id unitId,SUM(requests) requests,SUM(matched_requests) matched FROM revenue_facts WHERE account=? AND report_date IN (?,?) AND hour=? AND domain<>'' AND source_file LIKE ? GROUP BY report_date,domain,ad_unit_id")
      .all(upstream.account_key, date, baseline, hour, 'gam-rest:' + account.network_code + ':%');
    if (!rows.length) return;
    const pairs = new Map();
    for (const row of rows) {
      if (archived.has(row.unitId)) continue;
      const pair = pairs.get(row.domain) || { before:{ requests:0, matched:0 }, after:{ requests:0, matched:0 } };
      const side = row.date === date ? pair.after : pair.before;
      side.requests += row.requests; side.matched += row.matched;
      pairs.set(row.domain, pair);
    }
    if (![...pairs.values()].some(pair => pair.after.requests > 0)) return;
    const baseChannel = gamChannelForDate(db, account, date);
    const assignments = db.prepare('SELECT root_domain,channel_id,effective_from FROM gam_domain_channel_assignments WHERE effective_from<=? ORDER BY root_domain,effective_from').all(date);
    const qualified = new Set(), byChannel = new Map();
    for (const [domain, pair] of pairs) {
      if (!coverageQualified(pair, config)) continue;
      qualified.add(domain);
      const owner = ownerFor(domain.toLowerCase(), date, baseChannel, assignments);
      if (!owner) continue;
      db.prepare('INSERT OR IGNORE INTO coverage_alerts(soap_account_id,report_date,report_hour,domain,channel_id,baseline_requests,baseline_matched,current_requests,current_matched) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(account.id, date, hour, domain, owner, pair.before.requests, pair.before.matched, pair.after.requests, pair.after.matched);
      const saved = db.prepare('SELECT id,status,attempts,last_attempt_at FROM coverage_alerts WHERE soap_account_id=? AND report_date=? AND domain=?').get(account.id,date,domain);
      if (saved.status === 'sent' || saved.attempts >= 5 || (saved.last_attempt_at && instant.getTime() - Date.parse(saved.last_attempt_at.replace(' ','T') + 'Z') < 15*60_000)) continue;
      db.prepare("UPDATE coverage_alerts SET report_hour=?,channel_id=?,baseline_requests=?,baseline_matched=?,current_requests=?,current_matched=?,status='pending' WHERE id=?")
        .run(hour,owner,pair.before.requests,pair.before.matched,pair.after.requests,pair.after.matched,saved.id);
      if (!byChannel.has(owner)) byChannel.set(owner, []);
      byChannel.get(owner).push({ id:saved.id, domain, before:pair.before, after:pair.after });
    }
    for (const row of db.prepare("SELECT id,domain FROM coverage_alerts WHERE soap_account_id=? AND report_date=? AND status IN ('pending','failed')").all(account.id,date)) {
      const pair=pairs.get(row.domain);
      if (pair?.after.requests > 0 && !qualified.has(row.domain)) db.prepare("UPDATE coverage_alerts SET status='recovered',error='' WHERE id=?").run(row.id);
    }
    if (!byChannel.size) return;
    const credential = decryptCredential(config.webhook_ciphertext);
    const stamp = instant.toISOString().slice(0,19).replace('T',' ');
    for (const [channelId, notices] of [...byChannel].sort(([a],[b]) => a-b)) {
      const channel = db.prepare('SELECT name FROM channels WHERE id=?').get(channelId)?.name || '未关联渠道';
      notices.sort((a,b) => a.domain.localeCompare(b.domain));
      for (let offset=0; offset<notices.length; offset+=20) {
        const batch = notices.slice(offset,offset+20);
        let status='sent', detail='';
        try { await send(credential.url, credential.secret || '', coverageAlertMessage(account,channel,date,baseline,zone,hour,instant,batch)); }
        catch (error) { status='failed'; detail=String(error.message).slice(0,500); console.error('coverage_feishu_failed',account.id,detail); }
        for (const item of batch) db.prepare("UPDATE coverage_alerts SET status=?,error=?,attempts=attempts+1,last_attempt_at=?,sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END WHERE id=?")
          .run(status,detail,stamp,status,stamp,item.id);
      }
    }
  };
  return { runForAccount };
}
