import { adUnitResource, buildGamAdUnit, createGamAdUnit, findGamAdUnitByCode, gamSiteResource, getGamAdUnit, getGamSite, listGamAdUnits, listGamSites } from './gam-beta.mjs';

function siteDomain(value) {
  const raw = String(value || '').trim();
  try {
    const hostname = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).hostname.toLowerCase();
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname)) return hostname;
  } catch {}
  throw new Error('invalid_gam_site_url');
}

function sameRemoteAdUnit(remote, expected) {
  const sizeKey = unit => JSON.stringify((unit.adUnitSizes || []).map(entry => [
    Number(entry.size?.width), Number(entry.size?.height), entry.size?.sizeType, entry.environmentType
  ]).sort());
  return remote.parentAdUnit === expected.parentAdUnit && remote.displayName === expected.displayName &&
    remote.adUnitCode === expected.adUnitCode && sizeKey(remote) === sizeKey(expected);
}

export function registerGamRoutes(app, { db, requireAuth, requireAdmin, encryptCredential, tokenFor, gamSync, audit }) {
  const publishing = new Set();
  const creating = new Set();
  let scheduledSyncRunning = false;
  const account = id => {
    const number = Number(id);
    return Number.isSafeInteger(number) && number > 0 ? db.prepare('SELECT * FROM soap_accounts WHERE id=?').get(number) : null;
  };
  const publicAccount = id => db.prepare('SELECT id,name,network_code networkCode,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary,rest_report_name reportName,rest_channel_id channelId,rest_upstream_account_id upstreamAccountId,rest_money_divisor moneyDivisor,rest_sync_enabled syncEnabled,rest_last_preview_at lastPreviewAt,rest_last_preview_rows lastPreviewRows,rest_network_timezone timeZone,created_at createdAt FROM soap_accounts WHERE id=?').get(id);
  const route = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    const detail = String(error.message || error).slice(0, 500);
    const status = /^(invalid_|unsupported_|duplicate_|rest_report_not_configured|rest_report_mapping_inactive|rest_preview_required)/.test(detail) ? 400
      : /busy|already_created|already_exists|_mismatch/.test(detail) ? 409
      : /^(gam_http_|oauth_)/.test(detail) ? 502 : 500;
    res.status(status).json({ ok: false, error: detail });
  });

  app.get('/api/admin/gam-accounts', requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true, items: db.prepare('SELECT id,name,network_code networkCode,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary,rest_report_name reportName,rest_channel_id channelId,rest_upstream_account_id upstreamAccountId,rest_money_divisor moneyDivisor,rest_sync_enabled syncEnabled,rest_last_preview_at lastPreviewAt,rest_last_preview_rows lastPreviewRows,rest_network_timezone timeZone,created_at createdAt FROM soap_accounts ORDER BY id DESC').all() });
  });

  app.post('/api/admin/gam-accounts', requireAuth, requireAdmin, route((req, res) => {
    const name = String(req.body?.name || '').trim();
    const networkCode = String(req.body?.networkCode || '').trim();
    const credentials = req.body?.credentials;
    if (!name || !/^\d{6,}$/.test(networkCode) || !credentials || typeof credentials !== 'object' ||
        !credentials.client_email || !credentials.private_key) throw new Error('invalid_gam_account');
    const cipher = encryptCredential(credentials);
    db.prepare("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,created_by) VALUES(?,?,?,?) ON CONFLICT(network_code) DO UPDATE SET name=excluded.name,credential_ciphertext=excluded.credential_ciphertext,status='untested',last_test_at=NULL,last_test_status=NULL,last_test_summary='',rest_report_name='',rest_sync_enabled=0,rest_last_preview_at=NULL,rest_last_preview_rows=0,updated_at=CURRENT_TIMESTAMP")
      .run(name, networkCode, cipher, req.user.email);
    const id = accountByCode(networkCode).id;
    audit(req.user.email, 'gam_account.save', 'gam_account', id, JSON.stringify({ name, networkCode }), req.ip);
    res.json({ ok: true, item: publicAccount(id) });
  }));
  function accountByCode(networkCode) {
    return db.prepare('SELECT id FROM soap_accounts WHERE network_code=?').get(networkCode);
  }

  app.post('/api/admin/gam-accounts/:id/test', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    try {
      const network = await gamSync.test(item);
      db.prepare("UPDATE soap_accounts SET status='active',last_test_at=CURRENT_TIMESTAMP,last_test_status='success',last_test_summary=?,rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run('连接成功：' + (network.displayName || network.name), network.timeZone, item.id);
      audit(req.user.email, 'gam_account.test', 'gam_account', item.id, 'success', req.ip);
      res.json({ ok: true, network, item: publicAccount(item.id) });
    } catch (error) {
      const detail = String(error.message).slice(0, 500);
      db.prepare("UPDATE soap_accounts SET status='error',rest_sync_enabled=0,last_test_at=CURRENT_TIMESTAMP,last_test_status='failed',last_test_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(detail, item.id);
      audit(req.user.email, 'gam_account.test', 'gam_account', item.id, detail, req.ip);
      throw error;
    }
  }));

  app.post('/api/admin/gam-accounts/:id/report', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active') throw new Error('invalid_gam_account_status');
    const channelId = Number(req.body?.channelId), upstreamAccountId = Number(req.body?.upstreamAccountId);
    const moneyDivisor = Number(req.body?.moneyDivisor);
    if (!Number.isSafeInteger(channelId) || !Number.isSafeInteger(upstreamAccountId)) throw new Error('invalid_rest_report_mapping');
    const configured = await gamSync.configure(item, { channelId, upstreamAccountId, moneyDivisor }, req.user.email);
    res.json({ ok: true, configured, item: publicAccount(item.id) });
  }));

  app.post('/api/admin/gam-accounts/:id/preview', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active') throw new Error('invalid_gam_account_status');
    const preview = await gamSync.execute(item, { start: req.body?.start, end: req.body?.end });
    audit(req.user.email, 'gam.report_preview', 'gam_account', item.id, JSON.stringify({ start: preview.start, end: preview.end, rows: preview.rows, revenue: preview.revenue }), req.ip);
    res.json({ ok: true, preview, item: publicAccount(item.id) });
  }));

  app.post('/api/admin/gam-accounts/:id/activate', requireAuth, requireAdmin, route((req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active') throw new Error('invalid_gam_account_status');
    gamSync.activate(item, req.user.email);
    res.json({ ok: true, item: publicAccount(item.id) });
  }));

  app.post('/api/admin/gam-accounts/:id/pause', requireAuth, requireAdmin, route((req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    gamSync.pause(item, req.user.email);
    res.json({ ok: true, item: publicAccount(item.id) });
  }));

  app.post('/api/admin/gam-accounts/:id/sync-now', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active' || item.rest_sync_enabled !== 1) throw new Error('invalid_gam_account_status');
    const result = await gamSync.execute(item, { start: req.body?.start, end: req.body?.end, write: true });
    audit(req.user.email, 'gam.sync_manual', 'gam_account', item.id, JSON.stringify({ start: result.start, end: result.end, rows: result.rows }), req.ip);
    res.json({ ok: true, result });
  }));

  app.get('/api/admin/gam-sync/runs', requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true, items: db.prepare('SELECT r.id,r.soap_account_id gamAccountId,s.name gamAccountName,r.window_start windowStart,r.window_end windowEnd,r.status,r.rows_read rowsRead,r.rows_written rowsWritten,r.error,r.started_at startedAt,r.finished_at finishedAt FROM soap_sync_runs r JOIN soap_accounts s ON s.id=r.soap_account_id ORDER BY r.id DESC LIMIT 100').all() });
  });

  app.get('/api/admin/gam-accounts/:id/ad-units', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active') throw new Error('invalid_gam_account_status');
    const pageToken = String(req.query.pageToken || '');
    const result = await listGamAdUnits(item.network_code, await tokenFor(item), { pageToken, pageSize: 100 });
    res.json({ ok: true, items: (result.adUnits || []).map(unit => ({ name: unit.name, displayName: unit.displayName, adUnitCode: unit.adUnitCode, parentAdUnit: unit.parentAdUnit, status: unit.status })), nextPageToken: result.nextPageToken || '' });
  }));

  app.get('/api/admin/gam-accounts/:id/sites', requireAuth, requireAdmin, route(async (req, res) => {
    const item = account(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'gam_account_not_found' });
    if (item.status !== 'active') throw new Error('invalid_gam_account_status');
    const pageToken = String(req.query.pageToken || '');
    const result = await listGamSites(item.network_code, await tokenFor(item), { pageToken, pageSize: 100 });
    res.json({ ok: true, items: (result.sites || []).map(site => ({
      name: site.name, url: site.url, approvalStatus: site.approvalStatus, childNetworkCode: site.childNetworkCode
    })), nextPageToken: result.nextPageToken || '' });
  }));

  const creation = id => {
    const number = Number(id);
    return Number.isSafeInteger(number) && number > 0 ? db.prepare('SELECT * FROM gam_ad_unit_creations WHERE id=?').get(number) : null;
  };
  const publicCreation = id => db.prepare('SELECT id,gam_account_id gamAccountId,network_code networkCode,site_name siteName,site_url siteUrl,domain,parent_ad_unit parentAdUnit,display_name displayName,ad_unit_code adUnitCode,sizes_json sizesJson,description,adsense_enabled adsenseEnabled,target_window targetWindow,status,provider_id providerId,publish_error publishError,created_at createdAt,published_at publishedAt FROM gam_ad_unit_creations WHERE id=?').get(id);
  const saveCreated = (row, remote, actor, ip) => {
    adUnitResource(remote.name, row.network_code);
    if ((remote.adUnitCode && remote.adUnitCode !== row.ad_unit_code) ||
        (remote.parentAdUnit && remote.parentAdUnit !== row.parent_ad_unit)) throw new Error('created_ad_unit_mismatch');
    db.prepare("UPDATE gam_ad_unit_creations SET status='created',provider_id=?,publish_error='',published_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(remote.name, row.id);
    audit(actor, 'gam.ad_unit_create', 'gam_ad_unit_creation', row.id,
      JSON.stringify({ networkCode: row.network_code, siteName: row.site_name, parentAdUnit: row.parent_ad_unit, remoteName: remote.name }), ip);
    return publicCreation(row.id);
  };

  app.get('/api/admin/gam-ad-units', requireAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true, items: db.prepare('SELECT id,gam_account_id gamAccountId,network_code networkCode,site_name siteName,site_url siteUrl,domain,parent_ad_unit parentAdUnit,display_name displayName,ad_unit_code adUnitCode,sizes_json sizesJson,description,adsense_enabled adsenseEnabled,target_window targetWindow,status,provider_id providerId,publish_error publishError,created_at createdAt,published_at publishedAt FROM gam_ad_unit_creations ORDER BY id DESC LIMIT 1000').all() });
  });

  const createDirect = async (input, actor, ip, context = {}) => {
    const gamAccount = account(input?.gamAccountId);
    if (!gamAccount || gamAccount.status !== 'active') throw new Error('invalid_gam_account_status');
    const network = gamAccount.network_code;
    const siteName = gamSiteResource(input?.siteName, network);
    const parentName = adUnitResource(input?.parentAdUnit, network);
    const adUnit = buildGamAdUnit(input, network, parentName);
    const key = network + ':' + adUnit.adUnitCode.toLowerCase();
    if (creating.has(key)) throw new Error('gam_account_busy');
    creating.add(key);
    try {
      if (db.prepare('SELECT id FROM gam_ad_unit_creations WHERE network_code=? AND ad_unit_code=?').get(network, adUnit.adUnitCode))
        throw new Error('ad_unit_already_created');
      const token = context.token || await tokenFor(gamAccount);
      const sites = context.sites || new Map(), parents = context.parents || new Map();
      let site = sites.get(siteName);
      if (!site) { site = await getGamSite(network, token, siteName); sites.set(siteName, site); }
      let parent = parents.get(parentName);
      if (!parent) { parent = await getGamAdUnit(network, token, parentName); parents.set(parentName, parent); }
      if (site.name !== siteName) throw new Error('invalid_gam_site');
      if (parent.name !== parentName) throw new Error('invalid_parent_ad_unit');
      if (await findGamAdUnitByCode(network, token, adUnit.adUnitCode)) throw new Error('ad_unit_already_exists_in_gam');
      const domain = siteDomain(site.url);
      const inserted = db.prepare('INSERT INTO gam_ad_unit_creations(gam_account_id,network_code,site_name,site_url,domain,parent_ad_unit,display_name,ad_unit_code,sizes_json,description,adsense_enabled,target_window,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(gamAccount.id, network, siteName, site.url, domain, parentName, adUnit.displayName, adUnit.adUnitCode,
          JSON.stringify(input.sizes || [input.size]), adUnit.description || '', adUnit.appliedAdsenseEnabled ? 1 : 0,
          adUnit.appliedTargetWindow || '', actor);
      const row = creation(inserted.lastInsertRowid);
      try { return saveCreated(row, await createGamAdUnit(network, token, adUnit), actor, ip); }
      catch (error) {
        db.prepare("UPDATE gam_ad_unit_creations SET status='failed',publish_error=? WHERE id=?")
          .run(String(error.message).slice(0, 500), row.id);
        throw error;
      }
    } finally { creating.delete(key); }
  };

  app.post('/api/admin/gam-ad-units', requireAuth, requireAdmin, route(async (req, res) => {
    res.status(201).json({ ok: true, item: await createDirect(req.body, req.user.email, req.ip) });
  }));

  app.post('/api/admin/gam-ad-units/batch', requireAuth, requireAdmin, route(async (req, res) => {
    const inputs = req.body?.items;
    const gamAccount = account(req.body?.gamAccountId);
    if (!gamAccount || gamAccount.status !== 'active') throw new Error('invalid_gam_account_status');
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) throw new Error('invalid_ad_unit_batch');
    const seen = new Set();
    const prepared = inputs.map(input => {
      gamSiteResource(input?.siteName, gamAccount.network_code);
      adUnitResource(input?.parentAdUnit, gamAccount.network_code);
      const adUnit = buildGamAdUnit(input, gamAccount.network_code, input.parentAdUnit);
      const code = adUnit.adUnitCode.toLowerCase();
      if (seen.has(code)) throw new Error('duplicate_ad_unit_code');
      seen.add(code);
      return { ...input, gamAccountId: gamAccount.id, code: adUnit.adUnitCode };
    });
    const context = { token: await tokenFor(gamAccount), sites: new Map(), parents: new Map() };
    const results = [];
    for (const [index, input] of prepared.entries()) {
      try {
        const item = await createDirect(input, req.user.email, req.ip, context);
        results.push({ index, code: input.code, siteName: input.siteName, status: 'created', item });
      } catch (error) {
        results.push({ index, code: input.code, siteName: input.siteName, status: 'failed', error: String(error.message).slice(0, 500) });
      }
    }
    res.json({ ok: true, created: results.filter(item => item.status === 'created').length,
      failed: results.filter(item => item.status === 'failed').length, results });
  }));

  app.post('/api/admin/gam-ad-units/:id/retry', requireAuth, requireAdmin, route(async (req, res) => {
    const row = creation(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'ad_unit_not_found' });
    if (row.status === 'created') throw new Error('ad_unit_already_created');
    const gamAccount = account(row.gam_account_id);
    if (!gamAccount || gamAccount.status !== 'active' || gamAccount.network_code !== row.network_code)
      throw new Error('invalid_gam_account_status');
    if (creating.has(row.network_code + ':' + row.ad_unit_code.toLowerCase())) throw new Error('gam_account_busy');
    creating.add(row.network_code + ':' + row.ad_unit_code.toLowerCase());
    try {
      const adUnit = buildGamAdUnit({ name: row.display_name, code: row.ad_unit_code, sizes_json: row.sizes_json,
        description: row.description, adsense_enabled: row.adsense_enabled, target_window: row.target_window },
      row.network_code, row.parent_ad_unit);
      const token = await tokenFor(gamAccount);
      const [site, parent, existing] = await Promise.all([
        getGamSite(row.network_code, token, row.site_name), getGamAdUnit(row.network_code, token, row.parent_ad_unit),
        findGamAdUnitByCode(row.network_code, token, row.ad_unit_code)
      ]);
      if (site.name !== row.site_name || siteDomain(site.url) !== row.domain) throw new Error('gam_site_mismatch');
      if (parent.name !== row.parent_ad_unit) throw new Error('invalid_parent_ad_unit');
      if (existing && !sameRemoteAdUnit(existing, adUnit)) throw new Error('ad_unit_already_exists_in_gam');
      const remote = existing || await createGamAdUnit(row.network_code, token, adUnit);
      res.json({ ok: true, item: saveCreated(row, remote, req.user.email, req.ip) });
    } catch (error) {
      db.prepare("UPDATE gam_ad_unit_creations SET status='failed',publish_error=? WHERE id=?")
        .run(String(error.message).slice(0, 500), row.id);
      throw error;
    } finally { creating.delete(row.network_code + ':' + row.ad_unit_code.toLowerCase()); }
  }));

  app.post('/api/admin/ad-units/:id/publish', requireAuth, requireAdmin, route(async (req, res) => {
    const id = Number(req.params.id), item = db.prepare('SELECT * FROM managed_ad_units WHERE id=?').get(id);
    const gamAccountId = Number(req.body?.gamAccountId);
    const gamAccount = Number.isSafeInteger(gamAccountId) ? account(gamAccountId) : null;
    if (!item) return res.status(404).json({ ok: false, error: 'ad_unit_not_found' });
    if (!gamAccount || gamAccount.status !== 'active') throw new Error('invalid_gam_account_status');
    if (item.status === 'created' || item.provider_id) throw new Error('ad_unit_already_created');
    if (publishing.has(id)) throw new Error('gam_account_busy');
    publishing.add(id);
    try {
      const parentName = String(req.body?.parentAdUnit || '').trim();
      const adUnit = buildGamAdUnit(item, gamAccount.network_code, parentName);
      const token = await tokenFor(gamAccount);
      const parent = await getGamAdUnit(gamAccount.network_code, token, parentName);
      if (parent.name !== parentName) throw new Error('invalid_parent_ad_unit');
      let remote = await findGamAdUnitByCode(gamAccount.network_code, token, item.code);
      if (remote && remote.parentAdUnit !== parentName) throw new Error('parent_ad_unit_mismatch');
      if (!remote) remote = await createGamAdUnit(gamAccount.network_code, token, adUnit);
      if (!remote.name) throw new Error('invalid_created_ad_unit');
      db.prepare("UPDATE managed_ad_units SET status='created',provider_id=?,gam_network_code=?,gam_parent_ad_unit=?,publish_error='',published_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(remote.name, gamAccount.network_code, parentName, id);
      audit(req.user.email, 'gam.ad_unit_publish', 'managed_ad_unit', id, JSON.stringify({ networkCode: gamAccount.network_code, parentAdUnit: parentName, remoteName: remote.name }), req.ip);
      res.json({ ok: true, name: remote.name });
    } catch (error) {
      db.prepare("UPDATE managed_ad_units SET status='failed',publish_error=? WHERE id=?")
        .run(String(error.message).slice(0, 500), id);
      throw error;
    } finally {
      publishing.delete(id);
    }
  }));

  async function runHourlyGamSync() {
    if (scheduledSyncRunning) return;
    scheduledSyncRunning = true;
    try {
      for (const item of db.prepare("SELECT * FROM soap_accounts WHERE status='active' AND rest_sync_enabled=1").all()) {
        try { await gamSync.execute(item, { write: true }); }
        catch (error) { console.error('gam_rest_sync_failed', item.id, error.message); }
      }
    } finally { scheduledSyncRunning = false; }
  }
  return { runHourlyGamSync };
}
