const API_ROOT = 'https://admanager.googleapis.com/v1/';
const NETWORK_CODE = /^\d{6,}$/;
const AD_UNIT_NAME = /^networks\/(\d+)\/adUnits\/(\d+)$/;
const SITE_NAME = /^networks\/(\d+)\/sites\/(\d+)$/;

function networkCode(value) {
  const code = String(value || '').trim();
  if (!NETWORK_CODE.test(code)) throw new Error('invalid_network_code');
  return code;
}

export function adUnitResource(value, network) {
  const name = String(value || '').trim();
  const match = AD_UNIT_NAME.exec(name);
  if (!match || match[1] !== networkCode(network)) throw new Error('invalid_parent_ad_unit');
  return name;
}

export function gamSiteResource(value, network) {
  const name = String(value || '').trim();
  const match = SITE_NAME.exec(name);
  if (!match || match[1] !== networkCode(network)) throw new Error('invalid_gam_site');
  return name;
}

export function parseGamAdUnitSizes(values) {
  const entries = Array.isArray(values) ? values : [values];
  if (!entries.length || entries.length > 20) throw new Error('invalid_ad_unit_sizes');
  const special = { fluid: 'FLUID', responsive: 'FLUID', '自适应尺寸': 'FLUID',
    'out-of-page': 'INTERSTITIAL', '页外': 'INTERSTITIAL',
    native: 'NATIVE', 'custom rendering': 'NATIVE', '自定义呈现': 'NATIVE' };
  const sizes = entries.map(value => {
    const raw = String(value || '').trim().toLowerCase();
    const fixed = /^(\d{1,4})\s*[x×]\s*(\d{1,4})$/.exec(raw);
    let size;
    if (fixed) {
      const width = Number(fixed[1]), height = Number(fixed[2]);
      if (!width || !height) throw new Error('invalid_ad_unit_size');
      size = { width, height, sizeType: 'PIXEL' };
    } else if (special[raw]) {
      size = { width: 1, height: 1, sizeType: special[raw] };
    } else {
      throw new Error('unsupported_ad_unit_size_use_WxH_or_fluid');
    }
    return { size, environmentType: 'BROWSER' };
  });
  if (new Set(sizes.map(item => JSON.stringify(item.size))).size !== sizes.length) throw new Error('duplicate_ad_unit_size');
  return sizes;
}

export function buildGamAdUnit(plan, network, parent) {
  const parentAdUnit = adUnitResource(parent, network);
  const displayName = String(plan?.name || '').trim();
  const adUnitCode = String(plan?.gam_ad_unit_code || plan?.code || '').trim();
  if (!displayName || displayName.length > 255 || !adUnitCode || adUnitCode.length > 100) throw new Error('invalid_ad_unit_plan');
  const sizes = plan?.sizes_json ? JSON.parse(plan.sizes_json) : plan?.sizes || plan?.size;

  const adUnit = {
    parentAdUnit, displayName, adUnitCode,
    adUnitSizes: parseGamAdUnitSizes(sizes)
  };
  const description = String(plan?.description || '').trim();
  if (description) adUnit.description = description;
  if (plan?.adsense_enabled === 1 || plan?.adsenseEnabled === true) adUnit.appliedAdsenseEnabled = true;
  const targetWindow = String(plan?.target_window ?? plan?.targetWindow ?? '').trim().toUpperCase();
  if (targetWindow === 'TOP' || targetWindow === '_TOP') adUnit.appliedTargetWindow = 'TOP';
  if (targetWindow === 'BLANK' || targetWindow === '_BLANK') adUnit.appliedTargetWindow = 'BLANK';
  return adUnit;
}

export async function gamApiRequest(network, token, relativePath, { method = 'GET', query = {}, body, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const code = networkCode(network);
  if (!token) throw new Error('missing_gam_access_token');
  if (relativePath !== 'networks/' + code && !String(relativePath).startsWith('networks/' + code + '/')) {
    throw new Error('invalid_gam_resource');
  }
  const url = new URL(relativePath, API_ROOT);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  // Retrying create/run POSTs can duplicate remote resources or report jobs.
  const retryableMethod = method === 'GET' || method === 'PATCH';
  for (let attempt = 0; attempt < (retryableMethod ? 3 : 1); attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      if (!retryableMethod || attempt === 2) throw error;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    const transient = [429, 500, 502, 503, 504].includes(response.status);
    if (retryableMethod && transient && attempt < 2) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(5000, retryAfter * 1000) : 250 * 2 ** attempt);
      continue;
    }
    const detail = String(payload?.error?.message || payload?.error?.status || 'request_failed').slice(0, 400);
    throw new Error('gam_http_' + response.status + ': ' + detail);
  }
}

function request(network, token, suffix, options) {
  const code = networkCode(network);
  return gamApiRequest(code, token, 'networks/' + code + '/adUnits' + suffix, options);
}

export function listGamAdUnits(network, token, { pageToken = '', filter = '', pageSize = 100 } = {}, fetchImpl) {
  return request(network, token, '', { query: { pageSize, pageToken, filter }, fetchImpl });
}

export function listGamSites(network, token, { pageToken = '', pageSize = 100 } = {}, fetchImpl) {
  const code = networkCode(network);
  return gamApiRequest(code, token, 'networks/' + code + '/sites', { query: { pageSize, pageToken }, fetchImpl });
}

export function listGamAdUnitSizes(network, token, { pageToken = '', pageSize = 100 } = {}, fetchImpl) {
  const code = networkCode(network);
  return gamApiRequest(code, token, 'networks/' + code + '/adUnitSizes', { query: { pageSize, pageToken }, fetchImpl });
}

export function getGamSite(network, token, name, fetchImpl) {
  const resource = gamSiteResource(name, network);
  return gamApiRequest(network, token, resource, { fetchImpl });
}

export function getGamAdUnit(network, token, name, fetchImpl) {
  const resource = adUnitResource(name, network);
  return request(network, token, '/' + resource.split('/').at(-1), { fetchImpl });
}

export async function findGamAdUnitByCode(network, token, code, fetchImpl) {
  const result = await listGamAdUnits(network, token, { filter: 'adUnitCode = ' + JSON.stringify(String(code)), pageSize: 100 }, fetchImpl);
  return (result.adUnits || []).find(unit => String(unit.adUnitCode || '').toLowerCase() === String(code).toLowerCase()) || null;
}

export async function findGamAdUnitByName(network, token, name, fetchImpl) {
  let pageToken = '';
  do {
    const result = await listGamAdUnits(network, token, { filter: 'displayName = ' + JSON.stringify(String(name)), pageSize: 100, pageToken }, fetchImpl);
    const existing = (result.adUnits || []).find(unit => String(unit.displayName || '').toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return null;
}

export function createGamAdUnit(network, token, adUnit, fetchImpl) {
  return request(network, token, '', { method: 'POST', body: adUnit, fetchImpl });
}
