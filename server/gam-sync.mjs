import { gamApiRequest } from './gam-beta.mjs';
import { createRestReport, fetchRestReport, normalizeRestReportRows, setReportRange, validateReportDefinition } from './gam-reports.mjs';

export function localDate(timeZone, offset = 0, instant = new Date()) {
  if (!timeZone) throw new Error('invalid_network_timezone');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(instant);
  } catch {
    throw new Error('invalid_network_timezone');
  }
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day) + offset)).toISOString().slice(0, 10);
}

function asDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new Error('invalid_report_date');
  return date;
}

export function normalizeGamFactSite(fact, normalizedDomain) {
  // Only the REST report's SITE dimension is authoritative. Ad-unit names often
  // include a human-readable domain fragment, but that fragment is not a site.
  const url = String(fact.url || '').trim();
  return { ...fact, url, domain: url ? normalizedDomain(url) : '' };
}

export function createGamSync({ db, transaction, tokenFor, normalizedDomain, audit, onFactsChanged = () => {} }) {
  const busy = new Set();
  const upsert = db.prepare('INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP');

  async function locked(id, action) {
    if (busy.has(id)) throw new Error('gam_account_busy');
    busy.add(id);
    try { return await action(); } finally { busy.delete(id); }
  }

  async function test(account) {
    const token = await tokenFor(account);
    const network = await gamApiRequest(account.network_code, token, 'networks/' + account.network_code);
    if (network.name !== 'networks/' + account.network_code || !network.timeZone) throw new Error('gam_network_mismatch');
    return network;
  }

  async function configure(account, { channelId, upstreamAccountId, moneyDivisor }, actor) {
    return locked(account.id, async () => {
      const channel = db.prepare("SELECT id FROM channels WHERE id=? AND status='active'").get(channelId);
      const upstream = db.prepare("SELECT id FROM upstream_accounts WHERE id=? AND status='active' AND soap_account_id=?").get(upstreamAccountId, account.id);
      if (!channel || !upstream || ![1, 1000000].includes(moneyDivisor)) throw new Error('invalid_rest_report_mapping');
      const network = await test(account);
      const token = await tokenFor(account);
      const today = localDate(network.timeZone);
      const yesterday = localDate(network.timeZone, -1);
      let reportName = account.rest_report_name;
      if (reportName) {
        validateReportDefinition(await gamApiRequest(account.network_code, token, reportName), account.network_code, { allowLegacy: true });
      } else {
        reportName = (await createRestReport(account.network_code, token, yesterday, today)).name;
      }
      db.prepare("UPDATE soap_accounts SET rest_report_name=?,rest_channel_id=?,rest_upstream_account_id=?,rest_money_divisor=?,rest_sync_enabled=0,rest_last_preview_at=NULL,rest_last_preview_rows=0,rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(reportName, channelId, upstreamAccountId, moneyDivisor, network.timeZone, account.id);
      audit(actor, 'gam.report_configure', 'gam_account', account.id, JSON.stringify({ reportName, channelId, upstreamAccountId, moneyDivisor }));
      return { reportName, channelId, upstreamAccountId, moneyDivisor, timeZone: network.timeZone };
    });
  }

  function mapping(account) {
    if (!account.rest_report_name || !account.rest_channel_id || !account.rest_upstream_account_id ||
        ![1, 1000000].includes(account.rest_money_divisor)) throw new Error('rest_report_not_configured');
    const channel = db.prepare("SELECT id FROM channels WHERE id=? AND status='active'").get(account.rest_channel_id);
    const upstream = db.prepare("SELECT account_key accountKey FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'")
      .get(account.rest_upstream_account_id, account.id);
    if (!channel || !upstream) throw new Error('rest_report_mapping_inactive');
    return { channelId: channel.id, accountKey: upstream.accountKey };
  }

  async function execute(account, { start, end, write = false }) {
    return locked(account.id, async () => {
      const started = performance.now();
      const timingsMs = {};
      const checkpoint = stage => { timingsMs[stage] = Math.round(performance.now() - started); };
      const { channelId, accountKey } = mapping(account);
      let timeZone = account.rest_network_timezone;
      if (!timeZone) {
        const network = await test(account);
        timeZone = network.timeZone;
        db.prepare('UPDATE soap_accounts SET rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(timeZone, account.id);
      }
      const from = asDate(start || localDate(timeZone, -1));
      const through = asDate(end || localDate(timeZone));
      if (from > through || Date.parse(through) - Date.parse(from) > 31 * 86400000) throw new Error('invalid_report_range');
      let runId;
      if (write) {
        runId = Number(db.prepare("INSERT INTO soap_sync_runs(soap_account_id,channel_id,window_start,window_end,status,stage) VALUES(?,?,?,?, 'running','authorizing')")
          .run(account.id, channelId, from, through).lastInsertRowid);
      }
      const stage = value => { if (write) db.prepare('UPDATE soap_sync_runs SET stage=? WHERE id=?').run(value, runId); };
      try {
        const token = await tokenFor(account);
        checkpoint('oauth');
        stage('preparing_report');
        const activeReport = await setReportRange(account.network_code, token, account.rest_report_name, from, through);
        validateReportDefinition(activeReport, account.network_code);
        checkpoint('report_setup');
        stage('fetching_report');
        const result = await fetchRestReport(account.network_code, token, activeReport.name);
        checkpoint('remote_report');
        if (write) db.prepare('UPDATE soap_sync_runs SET rows_read=? WHERE id=?').run(result.rows.length, runId);
        const actual = result.dateRanges[0];
        const dateKey = date => [date?.year, date?.month, date?.day].map(Number).join('-');
        const startKey = from.split('-').map(Number).join('-');
        const endKey = through.split('-').map(Number).join('-');
        if (dateKey(actual.startDate) !== startKey || dateKey(actual.endDate) !== endKey) throw new Error('rest_report_range_mismatch');
        const sourceFile = 'gam-rest:' + account.network_code + ':' + from + '_' + through;
        const facts = normalizeRestReportRows(result.rows, {
          channelId, accountKey, sourceFile, moneyDivisor: account.rest_money_divisor
        }).map(fact => {
          if (fact.reportDate < from || fact.reportDate > through) throw new Error('rest_report_row_outside_range');
          return normalizeGamFactSite(fact, normalizedDomain);
        });
        checkpoint('normalize');
        const revenue = facts.reduce((sum, fact) => sum + fact.revenue, 0);
        if (write) {
          stage('writing');
          transaction(() => {
            // A completed REST run replaces that account's previous rows for
            // the same dates, including legacy five-dimensional rows.
            db.prepare("DELETE FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND source_file LIKE ?")
              .run(channelId, accountKey, from, through, 'gam-rest:' + account.network_code + ':%');
            for (const fact of facts) upsert.run(
              fact.channelId, fact.reportDate, fact.hour, fact.url, fact.domain, fact.account,
              fact.adUnit, fact.adUnitId, fact.country, fact.requests, fact.matched, fact.impressions,
              fact.clicks, fact.revenue, fact.sourceFile, fact.rawJson
            );
            if (activeReport.name !== account.rest_report_name)
              db.prepare('UPDATE soap_accounts SET rest_report_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(activeReport.name, account.id);
          });
          onFactsChanged(channelId, from, through);
          checkpoint('persist');
          db.prepare("UPDATE soap_sync_runs SET status='success',stage='complete',rows_read=?,rows_written=?,timings_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(result.rows.length, facts.length, JSON.stringify(timingsMs), runId);
        } else {
          db.prepare('UPDATE soap_accounts SET rest_last_preview_at=CURRENT_TIMESTAMP,rest_last_preview_rows=? WHERE id=?')
            .run(facts.length, account.id);
          if (activeReport.name !== account.rest_report_name)
            db.prepare('UPDATE soap_accounts SET rest_report_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
              .run(activeReport.name, account.id);
        }
        return {
          start: from, end: through, rows: facts.length, revenue,
          moneyDivisor: account.rest_money_divisor, timingsMs,
          sample: write ? undefined : facts.slice(0, 10).map(({ rawJson, ...fact }) => fact)
        };
      } catch (error) {
        if (write) db.prepare("UPDATE soap_sync_runs SET status='failed',stage='failed',error=?,timings_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(String(error.message).slice(0, 1000), JSON.stringify(timingsMs), runId);
        throw error;
      }
    });
  }

  function activate(account, actor) {
    if (!account.rest_report_name || !account.rest_last_preview_at || account.rest_last_preview_rows < 1) {
      throw new Error('rest_preview_required');
    }
    mapping(account);
    db.prepare('UPDATE soap_accounts SET rest_sync_enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(account.id);
    audit(actor, 'gam.sync_activate', 'gam_account', account.id, JSON.stringify({ reportName: account.rest_report_name }));
  }

  function pause(account, actor) {
    db.prepare('UPDATE soap_accounts SET rest_sync_enabled=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(account.id);
    audit(actor, 'gam.sync_pause', 'gam_account', account.id);
  }

  return { test, configure, execute, activate, pause };
}
