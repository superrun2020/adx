export function gamChannelAssignments(db, accountId, fallback, end) {
  const rows = db.prepare('SELECT effective_from effectiveFrom,channel_id channelId FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from<=? ORDER BY effective_from').all(accountId, end);
  return [{ effectiveFrom: '1900-01-01', channelId: fallback }, ...rows];
}

export function channelForGamDate(assignments, date) {
  let channelId = assignments[0].channelId;
  for (const row of assignments.slice(1)) {
    if (row.effectiveFrom > date) break;
    channelId = row.channelId;
  }
  return channelId;
}

export function gamChannelForDate(db, account, date) {
  return db.prepare('SELECT channel_id channelId FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1').get(account.id, date)?.channelId || account.rest_channel_id;
}
