import { catalogLinksWithManual } from './link-catalog.mjs';

export function resolveChannelAssignment(account, metadata, fallback, channelNames = new Map()) {
  const channelId = Number(metadata?.channelId || fallback?.channelId || account?.channelId || 0);
  if (!channelId) return { channelId: null, channelName: '', assignmentSource: '' };
  const assignmentSource = metadata?.channelId ? '链接管理' : fallback?.channelId ? '域名归属' : '账号同步映射';
  const channelName = (metadata?.channelId ? metadata.channelName : fallback?.channelId ? fallback.channelName : '') || channelNames.get(channelId) || '';
  return { channelId, channelName, assignmentSource };
}

// Only domains confirmed by live GAM Sites, or REST report subdomains beneath
// one of those Sites, are included here. Local-only links are never included.
export function channelGAMDomains(accounts, sitesByAccount, reportedByAccount, metadata, assignments) {
  const saved = new Map(metadata.map(row => [row.networkCode + ':' + row.domain, row]));
  const assigned = new Map(assignments.map(row => [row.domain, row]));
  const byChannel = new Map();
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const rows = catalogLinksWithManual(account, sitesByAccount[account.id] || [], [], reportedByAccount[account.id] || []);
    for (const row of rows) {
      if (row.source === '本地新增') continue;
      const meta = saved.get(row.networkCode + ':' + row.domain);
      const fallback = assigned.get(row.domain);
      const { channelId, assignmentSource } = resolveChannelAssignment(account, meta, fallback);
      if (!channelId) continue;
      const list = byChannel.get(channelId) || [];
      list.push({ ...row, assignmentSource });
      byChannel.set(channelId, list);
    }
  }
  for (const rows of byChannel.values()) rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.networkCode.localeCompare(b.networkCode));
  return byChannel;
}
