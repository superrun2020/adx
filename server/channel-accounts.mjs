export function parseChannelAccountIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length)
    throw new Error('invalid_channel_account');
  return [...value].sort((a, b) => a - b);
}

// The selected GAM account owns all REST facts from effectiveFrom onward.
export function assignChannelAccounts(db, channelId, ids, effectiveFrom, actor) {
  const affected = new Map();
  for (const id of ids) {
    const account = db.prepare('SELECT id,network_code networkCode,status,enabled,rest_report_name reportName,rest_channel_id channelId,rest_upstream_account_id upstreamId FROM soap_accounts WHERE id=?').get(id);
    if (!account || account.status !== 'active' || !account.enabled || !account.reportName || !account.upstreamId) throw new Error('invalid_channel_account');
    const upstream = db.prepare("SELECT account_key accountKey FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'").get(account.upstreamId, id);
    if (!upstream) throw new Error('invalid_channel_account');
    if (account.channelId !== channelId) {
      if (account.channelId) db.prepare("INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) SELECT ?,?,'1900-01-01',? WHERE NOT EXISTS (SELECT 1 FROM gam_channel_assignments WHERE soap_account_id=?)")
        .run(id, account.channelId, actor, id);
      else db.prepare("INSERT OR IGNORE INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(?,?,'1900-01-01',?)").run(id, channelId, actor);
      db.prepare('DELETE FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from>=?').run(id, effectiveFrom);
      db.prepare('INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(?,?,?,?)').run(id, channelId, effectiveFrom, actor);
      const prefix = 'gam-rest:' + account.networkCode + ':%';
      const prior = db.prepare('SELECT COUNT(DISTINCT channel_id) channels,MAX(report_date) lastDate FROM revenue_facts WHERE account=? AND report_date>=? AND source_file LIKE ?').get(upstream.accountKey, effectiveFrom, prefix);
      if (prior.channels > 1) throw new Error('conflicting_channel_facts');
      if (prior.lastDate) {
        db.prepare('UPDATE revenue_facts SET channel_id=? WHERE account=? AND report_date>=? AND source_file LIKE ?').run(channelId, upstream.accountKey, effectiveFrom, prefix);
        if (account.channelId && prior.lastDate > (affected.get(account.channelId) || '')) affected.set(account.channelId, prior.lastDate);
        if (prior.lastDate > (affected.get(channelId) || '')) affected.set(channelId, prior.lastDate);
      }
    }
    db.prepare('UPDATE soap_accounts SET rest_channel_id=?,channel_locked_to_account=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(channelId, id);
    db.prepare('UPDATE link_metadata SET channel_id=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE network_code=?').run(channelId, actor, account.networkCode);
  }
  return affected;
}
