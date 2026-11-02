import { buildGamAdUnit, createGamAdUnit, findGamAdUnitByCode, getGamAdUnit, listGamAdUnits } from './gam-beta.mjs';

export function registerGamRoutes(app, { db, requireAuth, requireAdmin, encryptCredential, tokenFor, gamSync, audit }) {
  const publishing = new Set();
  let scheduledSyncRunning = false;
  const account = id => {
    const number = Number(id);
    return Number.isSafeInteger(number) && number > 0 ? db.prepare('SELECT * FROM soap_accounts WHERE id=?').get(number) : null;
  };
  const publicAccount = id => db.prepare('SELECT id,name,network_code networkCode,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary,rest_report_name reportName,rest_channel_id channelId,rest_upstream_account_id upstreamAccountId,rest_money_divisor moneyDivisor,rest_sync_enabled syncEnabled,rest_last_preview_at lastPreviewAt,rest_last_preview_rows lastPreviewRows,rest_network_timezone timeZone,created_at createdAt FROM soap_accounts WHERE id=?').get(id);
  const route = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => {
    const detail = String(error.message || error).slice(0, 500);
    const status = /^(invalid_|unsupported_|rest_report_not_configured|rest_report_mapping_inactive|rest_preview_required)/.test(detail) ? 400
      : /busy|already_created|parent_ad_unit_mismatch/.test(detail) ? 409
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
