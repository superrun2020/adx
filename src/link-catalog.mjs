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

export function catalogLinksForAccount(account, sites = []) {
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
  return [...rows.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function catalogLinksWithManual(account, sites = [], manualDomains = [], reportedDomains = []) {
  const gamDomains = new Set(sites.map(site => hostname(site.url)).filter(Boolean));
  const manual = new Set(manualDomains.map(hostname).filter(Boolean));
  const reported = new Set(reportedDomains.map(hostname).filter(domain =>
    domain && [...gamDomains].some(parent => domain !== parent && domain.endsWith('.' + parent))));
  const combined = [...manual].map(domain => ({ url: domain, name: '' }))
    .concat([...reported].map(domain => ({ url: domain, name: '' })), sites);
  return catalogLinksForAccount(account, combined).map(row => ({
    ...row, source: gamDomains.has(row.domain) ? 'GAM Sites'
      : reported.has(row.domain) ? 'GAM 报表' : '本地新增',
    isManual: manual.has(row.domain) && !gamDomains.has(row.domain)
  }));
}

export function approvedLinksForAccount(account, sites = []) {
  return catalogLinksForAccount(account, sites)
    .filter(row => row.approval === 'APPROVED');
}
