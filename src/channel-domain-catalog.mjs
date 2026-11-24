import { catalogLinksWithManual } from './link-catalog.mjs';

export function matchingDomainAssignment(domain, assignments, date = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date())) {
  const host = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  return assignments.filter(item => {
    const root = String(item.rootDomain || '').toLowerCase();
    return item.effectiveFrom <= date && (host === root || host.endsWith('.' + root));
  }).sort((a, b) => b.rootDomain.length - a.rootDomain.length || b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

export function resolveChannelAssignment(account, metadata, fallback, channelNames = new Map(), domainOverride = null) {
  if (Number(metadata?.channelAssigned) && Number(metadata.channelId)) {
    const channelId = Number(metadata.channelId);
    return { channelId, channelName: metadata.channelName || channelNames.get(channelId) || '', assignmentSource: '渠道管理分配' };
  }
  if (Number(domainOverride?.channelId)) {
    const channelId = Number(domainOverride.channelId);
    return { channelId, channelName: domainOverride.channelName || channelNames.get(channelId) || '', assignmentSource: '域名专属归属' };
  }
  if (Number(account?.channelLocked) && Number(account?.channelId)) {
    const channelId = Number(account.channelId);
    return { channelId, channelName: channelNames.get(channelId) || '', assignmentSource: '账号关联' };
  }
  const channelId = Number(metadata?.channelId || fallback?.channelId || account?.channelId || 0);
  if (!channelId) return { channelId: null, channelName: '', assignmentSource: '' };
  const assignmentSource = metadata?.channelId ? '链接管理' : fallback?.channelId ? '域名归属' : '账号同步映射';
  const channelName = (metadata?.channelId ? metadata.channelName : fallback?.channelId ? fallback.channelName : '') || channelNames.get(channelId) || '';
  return { channelId, channelName, assignmentSource };
}

// Only domains confirmed by live GAM Sites, or REST report subdomains beneath
// one of those Sites, are included here. Local-only links are never included.
export function channelGAMDomains(accounts, sitesByAccount, reportedByAccount, metadata, assignments, domainAssignments = []) {
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
      const override = matchingDomainAssignment(row.domain, domainAssignments);
      const { channelId, assignmentSource } = resolveChannelAssignment(account, meta, fallback, new Map(), override);
      if (!channelId) continue;
      const list = byChannel.get(channelId) || [];
      list.push({ ...row, assignmentSource });
      byChannel.set(channelId, list);
    }
  }
  for (const rows of byChannel.values()) rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.networkCode.localeCompare(b.networkCode));
  return byChannel;
}
