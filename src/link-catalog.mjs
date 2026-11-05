export function hostname(value) {
  try {
    const text = String(value || '').trim();
    const host = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text).hostname.toLowerCase();
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(host) ? host : '';
  } catch { return ''; }
}

const isChildOf = (domain, parent) => domain.endsWith('.' + parent);
const multiPartSuffixes = new Set(['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr']);

function mainDomain(domain) {
  const parts = domain.split('.');
  const count = multiPartSuffixes.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length > count ? parts.slice(-count).join('.') : domain;
}

export function approvedLinksForAccount(account, sites = []) {
  const byDomain = new Map();
  for (const site of sites) {
    if (String(site.approvalStatus || '').toUpperCase() !== 'APPROVED') continue;
    const domain = hostname(site.url);
    if (domain) byDomain.set(domain, site);
  }

  const siteDomains = [...byDomain.keys()].sort((a, b) => b.length - a.length);
  return siteDomains.map(domain => {
    const site = byDomain.get(domain);
    const parentDomain = siteDomains.find(parent => parent !== domain && isChildOf(domain, parent)) || '';
    return {
      key: account.id + ':' + domain,
      domain,
      type: domain === mainDomain(domain) ? 'main' : 'sub',
      parentDomain,
      accountId: account.id,
      accountName: account.name,
      networkCode: account.networkCode,
      approval: 'APPROVED',
      source: 'GAM Sites',
      siteName: site.name
    };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
}
