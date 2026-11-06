export function siteDomain(url) {
  try {
    const value = String(url || '').trim();
    const domain = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value).hostname.toLowerCase();
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ? domain : '';
  } catch { return ''; }
}

export const belongsToSite = (domain, base) => Boolean(domain && base && (domain === base || domain.endsWith('.' + base)));
export const batchUnitTemplates = Object.freeze([
  { type: 'banner', bannerNo: 1, suffix: 'banner1' },
  { type: 'banner', bannerNo: 2, suffix: 'banner2' },
  { type: 'banner', bannerNo: 3, suffix: 'banner3' },
  { type: 'interstitial', suffix: 'INT' },
  { type: 'anchor', suffix: 'ANC' }
].map(template => Object.freeze(template)));

function datePrefix(value) {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('请选择命名日期');
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.toISOString().slice(0, 10) !== value) throw new Error('命名日期无效');
  return year.slice(-2) + month + day;
}

function suffix(row) {
  if (row.type === 'anchor') return 'ANC';
  if (row.type === 'interstitial') return 'INT';
  if (row.type !== 'banner' || !Number.isInteger(row.bannerNo) || row.bannerNo < 1 || row.bannerNo > 999)
    throw new Error('广告类型或 Banner 序号无效');
  return 'banner' + row.bannerNo;
}

export function prepareGamUnitItems({ accountId, siteNames, sites, domainChoices, rows, creationDate,
  description = '', adsenseEnabled = false, targetWindow = '', single = false }) {
  if (!accountId || !siteNames.length) throw new Error('请选择账号和网站');
  const prefix = datePrefix(creationDate);
  if (!single && (rows.length !== batchUnitTemplates.length || rows.some((row, index) => suffix(row) !== batchUnitTemplates[index].suffix)))
    throw new Error('批量版位固定为 banner1、banner2、banner3、INT、ANC');
  if (single && (rows.length !== 1 || siteNames.length !== 1)) throw new Error('创建单个时只能选择一个网站和版位');
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
  if (new Set(targets.map(item => item.domain)).size !== targets.length) throw new Error('同一域名只能选择一次');
  const items = targets.flatMap(({ siteName, domain }) => rows.map(row => {
    if (!row.sizes?.length) throw new Error('每个广告单元至少选择一个尺寸');
    const defaultName = prefix + '-' + domain + '-' + suffix(row);
    const customCode = single ? String(row.code || '').trim() : '';
    const customName = single ? String(row.name || '').trim() : '';
    const code = customCode ? customCode.replaceAll('{domain}', domain) : defaultName;
    return { gamAccountId: accountId, siteName, domain, code,
      name: customName ? customName.replaceAll('{domain}', domain) : code,
      sizes: [...row.sizes], description, adsenseEnabled, targetWindow };
  }));
  if (items.some(item => item.code.length > 100 || item.name.length > 255))
    throw new Error('广告单元代码最多 100 字符，名称最多 255 字符');
  const codes = new Set(), names = new Set();
  for (const item of items) {
    const code = item.code.toLowerCase(), name = item.name.toLowerCase();
    if (codes.has(code)) throw new Error('本批次有重复的广告单元代码');
    if (names.has(name)) throw new Error('本批次有重复的广告单元名称');
    codes.add(code); names.add(name);
  }
  return items;
}
