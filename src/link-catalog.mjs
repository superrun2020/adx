export function hostname(value) {
  try {
    const text = String(value || '').trim();
    const host = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text).hostname.toLowerCase();
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? host : '';
  } catch { return ''; }
}

const isWithin = (domain, parent) => domain === parent || domain.endsWith('.' + parent);
const multiPartSuffixes = new Set(['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr']);

function mainDomain(domain) {
  const parts = domain.split('.');
  const count = multiPartSuffixes.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length > count ? parts.slice(-count).join('.') : domain;
}

export function catalogLinksForAccount(account, sites = [], knownDomains = []) {
  const byDomain = new Map();
  for (const site of sites) {
    const domain = hostname(site.url);
    if (domain) byDomain.set(domain, site);
  }
  const siteDomains = [...byDomain.keys()].sort((a, b) => b.length - a.length);
  const rows = new Map();
  for (const domain of siteDomains) {
    const site = byDomain.get(domain);
    const parent = siteDomains.find(other => other !== domain && isWithin(domain, other)) || '';
    const inferredType = domain === mainDomain(domain) ? 'main' : 'sub';
    rows.set(domain, {
      key: account.id + ':' + domain, domain, type: parent ? 'sub' : inferredType,
      parentDomain: parent, accountId: account.id,
      accountName: account.name, networkCode: account.networkCode,
      approval: String(site.approvalStatus || 'UNKNOWN').toUpperCase(), source: 'GAM Sites', siteName: site.name
    });
  }
  // SITE is a report dimension, not proof of a separately registered GAM site.
  // Only show observed subdomains beneath a Site returned for this account.
  for (const raw of knownDomains) {
    const domain = hostname(raw);
    if (!domain || rows.has(domain)) continue;
    const parent = siteDomains.find(siteDomain => isWithin(domain, siteDomain));
    if (!parent) continue;
    const parentSite = byDomain.get(parent);
    rows.set(domain, {
      key: account.id + ':' + domain, domain, type: 'sub', parentDomain: parent,
      accountId: account.id, accountName: account.name, networkCode: account.networkCode,
      approval: 'PARENT_' + String(parentSite.approvalStatus || 'UNKNOWN').toUpperCase(),
      source: 'GAM REST 报表 SITE', siteName: parentSite.name
    });
  }
  return [...rows.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function approvedLinksForAccount(account, sites = [], knownDomains = []) {
  return catalogLinksForAccount(account, sites, knownDomains)
    .filter(row => row.approval === 'APPROVED');
}
