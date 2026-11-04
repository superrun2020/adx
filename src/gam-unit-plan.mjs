export function siteDomain(url) {
  try {
    const value = String(url || '').trim();
    const domain = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value).hostname.toLowerCase();
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ? domain : '';
  } catch { return ''; }
}

export const belongsToSite = (domain, base) => Boolean(domain && base && (domain === base || domain.endsWith('.' + base)));
const suffix = row => row.type === 'banner' ? 'banner' + row.bannerNo : row.type === 'anchor' ? 'ANC' : 'INT';

function makeUnique(items, field, maximum) {
  const counts = new Map();
  for (const item of items) {
    const key = item[field].toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const used = new Set(items.filter(item => counts.get(item[field].toLowerCase()) === 1)
    .map(item => item[field].toLowerCase()));
  return items.map(item => {
    const original = item[field];
    if (counts.get(original.toLowerCase()) === 1) return item;
    const preferredSuffix = '-' + item.unitSuffix;
    const alreadySuffixed = original.toLowerCase().endsWith(preferredSuffix.toLowerCase());
    const baseSuffix = alreadySuffixed ? '' : preferredSuffix;
    let candidate, sequence = alreadySuffixed ? 2 : 1;
    do {
      const ending = baseSuffix + (sequence > 1 ? '-' + sequence : '');
      candidate = original.slice(0, maximum - ending.length) + ending;
      sequence += 1;
    } while (used.has(candidate.toLowerCase()));
    used.add(candidate.toLowerCase());
    return { ...item, [field]: candidate };
  });
}

export function prepareGamUnitItems({ accountId, siteNames, sites, domainChoices, rows,
  description = '', adsenseEnabled = false, targetWindow = '', single = false }) {
  if (!accountId || !siteNames.length) throw new Error('请选择账号和网站');
  const targets = siteNames.flatMap(siteName => {
    const base = siteDomain(sites.find(item => item.name === siteName)?.url || '');
    if (!base) throw new Error('所选网站域名无效，请重新加载 GAM Sites');
    const selected = domainChoices[siteName]?.length ? domainChoices[siteName] : [base];
    if (single && selected.length > 1) throw new Error('创建单个时只能选择一个子网站');
    return selected.map(value => {
      const domain = siteDomain(value);
      if (!belongsToSite(domain, base)) throw new Error('子网站必须属于所选主网站：' + base);
      return { siteName, domain };
    });
  });
  if (!rows.length || rows.length > 100 || rows.length * targets.length > 100) throw new Error('每批最多创建 100 个广告单元');
  const drafts = targets.flatMap(({ siteName, domain }) => rows.map(row => {
    if (row.type === 'banner' && (!Number.isInteger(row.bannerNo) || row.bannerNo < 1)) throw new Error('Banner 序号必须是正整数');
    if (!row.sizes?.length) throw new Error('每个广告单元至少选择一个尺寸');
    const customCode = String(row.code || '').trim();
    if (targets.length > 1 && customCode && !customCode.includes('{domain}')) throw new Error('多网站自定义代码请包含 {domain}');
    const code = customCode ? customCode.replaceAll('{domain}', domain) : domain + '-' + suffix(row);
    const customName = String(row.name || '').trim();
    return { gamAccountId: accountId, siteName, domain, code,
      name: customName ? customName.replaceAll('{domain}', domain) : code,
      sizes: row.sizes, description, adsenseEnabled, targetWindow, unitSuffix: suffix(row), customName: Boolean(customName) };
  }));
  const uniqueCodes = makeUnique(drafts, 'code', 120);
  const adjustedNames = uniqueCodes.map(item => item.customName ? item : { ...item, name: item.code });
  const uniqueNames = makeUnique(adjustedNames, 'name', 255);
  return uniqueNames.map(({ unitSuffix, customName, ...item }) => item);
}
