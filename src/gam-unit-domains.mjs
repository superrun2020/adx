import { siteDomain, belongsToSite } from './gam-unit-plan.mjs';

// GAM ad units have no website field. Only a creation record or an explicit
// hostname in the unit's code/name can identify its website.
const labelled = /(?:^|[_-])lb-((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i;
const dated = /(?:^|[_-])(?:\d{6}|\d{8})-((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i;
const embedded = /(?:^|[-_])((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i;
const multiPartSuffixes = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.cn', 'net.cn', 'org.cn',
  'com.au', 'net.au', 'org.au', 'co.jp', 'or.jp', 'ne.jp',
  'co.kr', 'or.kr', 'com.br', 'com.hk', 'com.tw', 'co.nz', 'com.sg',
  'co.za', 'org.za', 'co.in', 'ac.in', 'com.my', 'com.tr', 'com.mx',
  'com.ar', 'com.pl', 'com.ua'
]);
const privateSuffixes = new Set(['github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'blogspot.com', 'appspot.com']);

export function domainInUnit(value) {
  const text = String(value || '');
  const match = text.match(labelled) || text.match(dated) || text.match(embedded);
  return match ? siteDomain(match[1]) : '';
}

export function mainDomainOf(domain) {
  const host = siteDomain(domain);
  if (!host) return '';
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  const genericCcTld = parts.at(-1)?.length === 2 &&
    ['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or'].includes(parts.at(-2));
  const suffix = multiPartSuffixes.has(lastTwo) || privateSuffixes.has(lastTwo) || genericCcTld ? 3 : 2;
  const fallback = parts.length >= suffix ? parts.slice(-suffix).join('.') : host;
  return fallback;
}

export function indexCreationRecords(records) {
  const index = new Map();
  for (const record of records) {
    if (!record.providerId || !record.networkCode) continue;
    const key = String(record.networkCode) + ':' + record.providerId;
    const previous = index.get(key);
    if (!previous) index.set(key, record);
    else if (previous.ambiguous || siteDomain(previous.domain) !== siteDomain(record.domain) ||
        siteDomain(previous.siteUrl) !== siteDomain(record.siteUrl))
      index.set(key, { ambiguous: true });
  }
  return index;
}

export function resolveAdUnitDomain(unit, creation) {
  if (creation?.ambiguous)
    return { domain: '', mainDomain: '', subdomain: '', source: '创建记录冲突，需人工核对' };
  const codeDomain = domainInUnit(unit.adUnitCode);
  const nameDomain = domainInUnit(unit.displayName);
  const stored = creation?.status === 'created' && creation.providerId === unit.name &&
    String(creation.networkCode) === String(unit.networkCode) ? siteDomain(creation.domain) : '';
  const site = stored ? siteDomain(creation.siteUrl) : '';
  const candidates = [codeDomain, nameDomain, stored].filter(Boolean);
  if ((stored && site && !belongsToSite(stored, site)) || new Set(candidates).size > 1)
    return { domain: '', mainDomain: '', subdomain: '', source: '归属冲突，需人工核对' };
  const domain = stored || codeDomain || nameDomain;
  if (!domain) return { domain: '', mainDomain: '', subdomain: '', source: '无法确认归属' };
  const mainDomain = mainDomainOf(domain);
  return { domain, mainDomain, subdomain: domain !== mainDomain ? domain : '',
    source: stored ? '本站创建记录' : codeDomain ? 'GAM 代码' : 'GAM 名称' };
}

export function archivableSubdomainUnit(unit, target, creation) {
  if (!unit?.parentAdUnit || !unit.accountEnabled || !['ACTIVE', 'INACTIVE'].includes(unit.status)) return false;
  return resolveAdUnitDomain(unit, creation).subdomain === siteDomain(target);
}

export async function scanArchivableUnits(accounts, fetchPage) {
  const groups = await Promise.all(accounts.map(async account => {
    const items = [], tokens = new Set();
    let pageToken = '';
    do {
      const page = await fetchPage(account, pageToken);
      items.push(...(page.items || []).map(unit => ({ ...unit, gamAccountId: account.id,
        accountName: account.name, networkCode: account.networkCode, accountEnabled: Boolean(account.enabled) })));
      const next = page.nextPageToken || '';
      if (next && tokens.has(next)) throw new Error(account.name + ' 的广告单元分页重复');
      tokens.add(next);
      pageToken = next;
    } while (pageToken && tokens.size < 1000);
    if (pageToken) throw new Error(account.name + ' 的广告单元超过 100000 个，无法安全预览');
    return items;
  }));
  return groups.flat();
}
