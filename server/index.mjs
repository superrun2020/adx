import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { registerGamRoutes } from './gam-routes.mjs';
import { createGamSync } from './gam-sync.mjs';
import { ensureAdUnitIdDimension } from './revenue-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4180);
const dbPath = path.resolve(root, process.env.ADX_DB_PATH || './data/adx-channel.sqlite');
const adminHost = String(process.env.ADX_ADMIN_HOST || 'adx.geekforest.ai').toLowerCase();
const publisherHost = String(process.env.ADX_PUBLISHER_HOST || 'adxpub.geekforest.ai').toLowerCase();
const production = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', 'loopback');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
const reportCache = new Map();
let reportCacheDataVersion = db.prepare('PRAGMA data_version').get().data_version;
function invalidateReportCache() { reportCache.clear(); }
function cachedReport(req, res, next) {
  // SQLite's data_version changes for writes from another connection; local
  // writes invalidate explicitly after their audit or completed REST import.
  const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  if (dataVersion !== reportCacheDataVersion) {
    invalidateReportCache();
    reportCacheDataVersion = dataVersion;
    dashboardDailyReady = false;
  }
  const key = req.user.id + ':' + req.originalUrl;
  const hit = reportCache.get(key);
  if (hit) {
    reportCache.delete(key);
    reportCache.set(key, hit);
    res.setHeader('Server-Timing', 'app-cache;desc="hit";dur=0');
    return res.json(hit);
  }
  const began = performance.now();
  const send = res.json.bind(res);
  res.json = payload => {
    if (res.statusCode === 200 && payload?.ok) {
      reportCache.set(key, payload);
      if (reportCache.size > 128) reportCache.delete(reportCache.keys().next().value);
    }
    res.setHeader('Server-Timing', 'app-cache;desc="miss";dur=' + (performance.now() - began).toFixed(1));
    return send(payload);
  };
  next();
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  share_percent REAL NOT NULL DEFAULT 100 CHECK(share_percent BETWEEN 0 AND 100), status TEXT NOT NULL DEFAULT 'active', api_secret_ciphertext TEXT,
  api_secret_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_share_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id,effective_from), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS upstream_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, soap_account_id INTEGER, share_percent REAL NOT NULL DEFAULT 100 CHECK(share_percent BETWEEN 0 AND 100),
  advertiser TEXT NOT NULL DEFAULT '', bd TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ad_unit_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ad_unit TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_share_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('account','ad_unit')),
  scope_value TEXT NOT NULL COLLATE NOCASE, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id,scope_type,scope_value,effective_from), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_domain_share_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, upstream_account_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
  domain TEXT NOT NULL COLLATE NOCASE, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(upstream_account_id,channel_id,domain,effective_from),
  FOREIGN KEY(upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ad_unit_creation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, subdomains_json TEXT NOT NULL, inventory_types_json TEXT NOT NULL,
  sizes_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS managed_ad_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  subdomain TEXT NOT NULL, inventory_type TEXT NOT NULL, size TEXT NOT NULL, source_row_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','created','failed')), provider_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','channel')), channel_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS report_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT 'account_reports_read',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS channel_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS revenue_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER,
  url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', ad_unit_id TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT NOT NULL, channel_id INTEGER NOT NULL, source_file TEXT NOT NULL,
  total_rows INTEGER NOT NULL, accepted_rows INTEGER NOT NULL, rejected_rows INTEGER NOT NULL, status TEXT NOT NULL,
  error_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS soap_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, network_code TEXT NOT NULL UNIQUE,
  credential_ciphertext TEXT NOT NULL, api_version TEXT NOT NULL DEFAULT 'v1',
  account_email TEXT NOT NULL DEFAULT '', advertiser TEXT NOT NULL DEFAULT '', bd TEXT NOT NULL DEFAULT '',
  advertiser_share_percent REAL NOT NULL DEFAULT 0, operation_status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'untested', last_test_at TEXT, last_test_status TEXT,
  last_test_summary TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gam_ad_unit_creations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, gam_account_id INTEGER NOT NULL, network_code TEXT NOT NULL,
  site_name TEXT NOT NULL, site_url TEXT NOT NULL, domain TEXT NOT NULL, parent_ad_unit TEXT NOT NULL,
  display_name TEXT NOT NULL, ad_unit_code TEXT NOT NULL COLLATE NOCASE, sizes_json TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', adsense_enabled INTEGER NOT NULL DEFAULT 0,
  target_window TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','created','failed')), provider_id TEXT, publish_error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT,
  UNIQUE(network_code,ad_unit_code), FOREIGN KEY(gam_account_id) REFERENCES soap_accounts(id)
);
CREATE TABLE IF NOT EXISTS soap_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, soap_account_id INTEGER NOT NULL, channel_id INTEGER,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, status TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT,
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_revenue_scope_date ON revenue_facts(channel_id, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_dashboard ON revenue_facts(report_date, channel_id, account, ad_unit, domain, revenue, requests, matched_requests, impressions, clicks);
CREATE INDEX IF NOT EXISTS idx_revenue_domain ON revenue_facts(domain, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_account_unit ON revenue_facts(account, ad_unit, report_date);
`);
try { db.exec('ALTER TABLE channels ADD COLUMN api_secret_ciphertext TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
for (const column of ['description','adsense_enabled','placement','target_window','label']) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('managed_ad_units') WHERE name=?`).get(column)) db.exec(`ALTER TABLE managed_ad_units ADD COLUMN ${column} ${column==='adsense_enabled'?'INTEGER NOT NULL DEFAULT 0':'TEXT NOT NULL DEFAULT \'\''}`);
}
for (const [column, definition] of Object.entries({
  gam_network_code: 'TEXT', gam_parent_ad_unit: 'TEXT', publish_error: "TEXT NOT NULL DEFAULT ''",
  published_at: 'TEXT'
})) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('managed_ad_units') WHERE name=?").get(column)) {
    db.exec('ALTER TABLE managed_ad_units ADD COLUMN ' + column + ' ' + definition);
  }
}
const firstRestMigration = !db.prepare("SELECT 1 FROM pragma_table_info('soap_accounts') WHERE name='rest_report_name'").get();
for (const [column, definition] of Object.entries({
  rest_report_name: "TEXT NOT NULL DEFAULT ''", rest_channel_id: 'INTEGER',
  rest_upstream_account_id: 'INTEGER', rest_money_divisor: 'INTEGER',
  rest_sync_enabled: 'INTEGER NOT NULL DEFAULT 0', rest_last_preview_at: 'TEXT',
  rest_last_preview_rows: 'INTEGER NOT NULL DEFAULT 0', rest_network_timezone: "TEXT NOT NULL DEFAULT ''",
  account_email: "TEXT NOT NULL DEFAULT ''", advertiser: "TEXT NOT NULL DEFAULT ''",
  bd: "TEXT NOT NULL DEFAULT ''", advertiser_share_percent: 'REAL NOT NULL DEFAULT 0',
  operation_status: "TEXT NOT NULL DEFAULT 'unknown'", enabled: 'INTEGER NOT NULL DEFAULT 1', notes: "TEXT NOT NULL DEFAULT ''"
})) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('soap_accounts') WHERE name=?").get(column)) {
    db.exec('ALTER TABLE soap_accounts ADD COLUMN ' + column + ' ' + definition);
  }
}
if (firstRestMigration) db.exec("UPDATE soap_accounts SET status='untested',last_test_at=NULL,last_test_status=NULL,last_test_summary='请重新测试 REST 连接'");
if (!db.prepare("SELECT 1 FROM pragma_table_info('upstream_accounts') WHERE name='soap_account_id'").get()) db.exec('ALTER TABLE upstream_accounts ADD COLUMN soap_account_id INTEGER');
for (const column of ['advertiser', 'bd']) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('upstream_accounts') WHERE name=?").get(column))
    db.exec(`ALTER TABLE upstream_accounts ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('revenue_facts') WHERE name='raw_json'").get()) {
  db.exec("ALTER TABLE revenue_facts ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}'");
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('soap_sync_runs') WHERE name='stage'").get()) {
  db.exec("ALTER TABLE soap_sync_runs ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('soap_sync_runs') WHERE name='timings_json'").get()) {
  db.exec("ALTER TABLE soap_sync_runs ADD COLUMN timings_json TEXT NOT NULL DEFAULT '{}'");
}
ensureAdUnitIdDimension(db);
db.exec('CREATE INDEX IF NOT EXISTS idx_revenue_ad_unit_id ON revenue_facts(ad_unit_id, report_date)');
db.exec("INSERT OR IGNORE INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) SELECT id,share_percent,'1900-01-01','migration' FROM channels");
db.exec("CREATE TABLE IF NOT EXISTS upstream_share_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, upstream_account_id INTEGER NOT NULL, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100), effective_from TEXT NOT NULL, created_by TEXT NOT NULL, UNIQUE(upstream_account_id,effective_from), FOREIGN KEY(upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE)");
db.exec("INSERT OR IGNORE INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) SELECT id,100,'1900-01-01','migration' FROM upstream_accounts");
db.exec("INSERT OR IGNORE INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) SELECT id,share_percent,'2026-10-11','migration' FROM upstream_accounts");
db.exec('CREATE TABLE IF NOT EXISTS dashboard_daily (report_date TEXT NOT NULL, channel_id INTEGER NOT NULL, domain TEXT NOT NULL, requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, revenue REAL NOT NULL, settled_revenue REAL NOT NULL, PRIMARY KEY(report_date,channel_id,domain)) WITHOUT ROWID');

const normalizeEmail = v => String(v || '').trim().toLowerCase();
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function passwordMatches(password, encoded = '') {
  const [type, salt, expected] = encoded.split('$');
  if (type !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  return actual.length === expected.length / 2 && crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function audit(actor, action, targetType, targetId = '', detail = '', ip = '') {
  db.prepare('INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,ip) VALUES(?,?,?,?,?,?)')
    .run(actor || '', action, targetType, String(targetId), String(detail).slice(0, 2000), String(ip).slice(0, 80));
  if (!action.startsWith('auth.') && action !== 'api.revenue' && action !== 'gam.report_preview') invalidateReportCache();
  if (['upstream_account.create','upstream_account.update','ad_unit_domain.create','ad_unit_domain.update',
    'share_rule.create','domain_share_rule.create','domain_share_rule.update','channel.update'].includes(action)) {
    try { refreshDashboardDaily(); }
    catch (error) { dashboardDailyReady = false; console.error('dashboard_daily_refresh_failed', error.message); }
  }
}

const credentialKey = (() => {
  const configured = String(process.env.ADX_CREDENTIAL_KEY || '');
  if (configured.length >= 32) return crypto.createHash('sha256').update(configured).digest();
  if (production) throw new Error('ADX_CREDENTIAL_KEY_REQUIRED');
  return crypto.createHash('sha256').update('local-development-only').digest();
})();
function encryptCredential(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', credentialKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
function decryptCredential(encoded) {
  const [ivText, tagText, dataText] = String(encoded).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8'));
}
async function issueServiceToken(credentials, scope = 'https://www.googleapis.com/auth/admanager') {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  if (tokenUri !== 'https://oauth2.googleapis.com/token') throw new Error('invalid_service_account_token_uri');
  const payload = Buffer.from(JSON.stringify({ iss: credentials.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const tokenResponse = await fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) });
  const body = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !body.access_token) throw new Error(`oauth_${tokenResponse.status}_${body.error || 'failed'}`);
  return { token: body.access_token, expiresIn: Number(body.expires_in) || 3600 };
}
const gamTokens = new Map();
async function gamTokenFor(account) {
  const key = Number(account.id);
  const cipher = account.credential_ciphertext;
  const cached = gamTokens.get(key);
  if (cached?.cipher === cipher && cached.token && cached.expiresAt > Date.now() + 300000) return cached.token;
  if (cached?.cipher === cipher && cached.promise) return cached.promise;
  const promise = (async () => {
    const credentials = decryptCredential(cipher);
    if (!credentials.client_email || !credentials.private_key) throw new Error('invalid_service_account_json');
    const result = await issueServiceToken(credentials);
    gamTokens.set(key, { cipher, token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 });
    return result.token;
  })();
  gamTokens.set(key, { cipher, promise });
  try { return await promise; }
  catch (error) { if (gamTokens.get(key)?.promise === promise) gamTokens.delete(key); throw error; }
}
function domainFromAdUnit(value) { const raw=String(value||''); const labelled=raw.match(/(?:^|[_-])lb-((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i); if(labelled)return normalizedDomain(labelled[1]); const match=raw.match(/(?:^|[-_])((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i); return match?normalizedDomain(match[1]):''; }
const gamSync = createGamSync({ db, transaction, tokenFor: gamTokenFor, normalizedDomain, domainFromAdUnit, audit,
  onFactsChanged: (channelId, start, end) => {
    try { refreshDashboardDaily(channelId, start, end); }
    catch (error) { dashboardDailyReady = false; console.error('dashboard_daily_refresh_failed', error.message); }
  } });

const adminEmail = normalizeEmail(process.env.ADX_ADMIN_EMAIL);
const adminPassword = String(process.env.ADX_ADMIN_PASSWORD || '');
const hasActiveAdmin = Boolean(db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' LIMIT 1").get());
const bootstrapCredentialsValid = Boolean(adminEmail && adminPassword.length >= (production ? 12 : 10) && !/replace|change|example\.com/i.test(adminPassword));
if (production && !hasActiveAdmin && !bootstrapCredentialsValid) throw new Error('production_admin_credentials_required');
if (!hasActiveAdmin && bootstrapCredentialsValid) {
  db.prepare("INSERT INTO users(email,name,password_hash,role,status) VALUES(?,?,?,'admin','active')")
    .run(adminEmail, '平台管理员', passwordHash(adminPassword));
}

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

function tokenFrom(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('adx_session='));
  return req.headers.authorization?.replace(/^Bearer\s+/i, '') || (cookie ? decodeURIComponent(cookie.slice(12)) : '');
}
function portalRole(req) {
  const hostname = String(req.hostname || '').toLowerCase();
  if (hostname === adminHost) return 'admin';
  if (hostname === publisherHost) return 'channel';
  return null;
}
app.use((req, res, next) => production && !portalRole(req) ? res.status(421).json({ ok: false, error: 'unknown_host' }) : next());

const loginAttempts = new Map();
function loginRateLimited(req, email) {
  const key = `${req.ip}|${email}`;
  const now = Date.now(), windowMs = 15 * 60 * 1000;
  const recent = (loginAttempts.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= 8) return true;
  recent.push(now); loginAttempts.set(key, recent); return false;
}
function requireAuth(req, res, next) {
  const token = tokenFrom(req); if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const row = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.channel_id,u.status,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`).get(sha256(token));
  if (!row || row.status !== 'active') return res.status(401).json({ ok: false, error: 'unauthorized' });
  const requiredRole = portalRole(req);
  if (requiredRole && row.role !== requiredRole) return res.status(403).json({ ok: false, error: 'wrong_portal' });
  req.user = row; req.sessionToken = token; next();
}
function requireAdmin(req, res, next) { return req.user?.role === 'admin' ? next() : res.status(403).json({ ok: false, error: 'forbidden' }); }
const userJson = row => ({ id: row.id, email: row.email, name: row.name, role: row.role, channelId: row.channel_id || null });

function reportApiKeyFrom(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}
function requireAccountReportKey(req, res, next) {
  const secret = reportApiKeyFrom(req);
  if (!secret) return res.status(401).json({ ok: false, error: 'report_api_key_required' });
  const row = db.prepare("SELECT id,scope,status FROM report_api_keys WHERE key_hash=?").get(sha256(secret));
  if (!row || row.status !== 'active' || row.scope !== 'account_reports_read') return res.status(401).json({ ok: false, error: 'invalid_report_api_key' });
  req.reportApiKey = row;
  next();
}

app.post('/api/auth/login', (req, res) => {
  const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
  if (loginRateLimited(req, email)) { audit(email, 'auth.login_blocked', 'user', '', '', req.ip); return res.status(429).json({ ok: false, error: 'too_many_attempts' }); }
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const requiredRole = portalRole(req);
  if (!user || user.status !== 'active' || (requiredRole && user.role !== requiredRole) || !passwordMatches(password, user.password_hash)) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = Math.max(1, Math.min(168, Number(process.env.SESSION_TTL_HOURS || 12)));
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))").run(sha256(token), user.id, `+${ttl} hours`);
  audit(email, 'auth.login', 'user', user.id, '', req.ip);
  loginAttempts.delete(`${req.ip}|${email}`);
  res.setHeader('Set-Cookie', `adx_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl * 3600}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true, user: userJson(user) });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ok: true, user: userJson(req.user) }));
app.post('/api/auth/logout', requireAuth, (req, res) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(req.sessionToken)); res.setHeader('Set-Cookie', 'adx_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ ok: true }); });

const validDate = value => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === text;
};
function reportScope(req) { return req.user.role === 'channel' ? req.user.channel_id : Number(req.query.channelId || 0) || null; }
function range(req) {
  const end = validDate(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
  const start = validDate(req.query.start) ? req.query.start : `${end.slice(0, 8)}01`;
  return { start, end };
}
function whereScope(scope, start, end) { return { sql: `report_date BETWEEN ? AND ?${scope ? ' AND channel_id=?' : ''}`, params: scope ? [start, end, scope] : [start, end] }; }
function effectiveShareSql(alias = 'revenue_facts') { return `(SELECT v.share_percent FROM channel_share_versions v WHERE v.channel_id=${alias}.channel_id AND v.effective_from<=${alias}.report_date ORDER BY v.effective_from DESC,v.id DESC LIMIT 1)`; }
function upstreamShareSql(alias = 'revenue_facts') { return `COALESCE((SELECT v.share_percent FROM upstream_share_versions v JOIN upstream_accounts u ON u.id=v.upstream_account_id WHERE u.account_key=${alias}.account COLLATE NOCASE AND u.status='active' AND v.effective_from<=${alias}.report_date ORDER BY v.effective_from DESC,v.id DESC LIMIT 1),(SELECT u.share_percent FROM upstream_accounts u WHERE u.account_key=${alias}.account COLLATE NOCASE AND u.status='active' LIMIT 1),100)`; }
function channelRuleShareSql(alias = 'revenue_facts') {
  const fallback = effectiveShareSql(alias);
  const domain = mappedDomainSql(alias);
  return `COALESCE((SELECT r.share_percent FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id WHERE r.channel_id=${alias}.channel_id AND u.account_key=${alias}.account COLLATE NOCASE AND (r.domain='' OR r.domain=${domain} COLLATE NOCASE) AND r.effective_from<=${alias}.report_date ORDER BY CASE WHEN r.domain='' THEN 1 ELSE 0 END,r.effective_from DESC,r.id DESC LIMIT 1),(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=${alias}.channel_id AND r.scope_type='ad_unit' AND r.scope_value=${alias}.ad_unit COLLATE NOCASE AND r.effective_from<=${alias}.report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1),(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=${alias}.channel_id AND r.scope_type='account' AND r.scope_value=${alias}.account COLLATE NOCASE AND r.effective_from<=${alias}.report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1),${fallback})`;
}
function settledRevenueSql(alias = 'revenue_facts') { return `(${alias}.revenue*(${upstreamShareSql(alias)}/100.0)*(${channelRuleShareSql(alias)}/100.0))`; }
function mappedDomainSql(alias = 'revenue_facts') { return `COALESCE((SELECT m.domain FROM ad_unit_domains m WHERE m.ad_unit=${alias}.ad_unit COLLATE NOCASE LIMIT 1),${alias}.domain)`; }

const builderAliases = {
  subdomain: ['subdomain','sub_domain','domain','hostname','url','site','子域名','域名'],
  inventoryType: ['inventory_type','ad_type','placement_type','type','广告位类型','广告类型','广告位'],
  size: ['size','sizes','ad_size','dimensions','dimension','尺寸','广告尺寸'],
  adUnit: ['ad_unit','adunit','ad_unit_name','广告单元','广告位名称'],
  name: ['name','名称','广告单元名称'], description: ['description','说明','描述'], adsenseEnabled: ['adsense_enabled','已启用 adsense','启用 adsense'], placement: ['placement','刊登位置'], targetWindow: ['target_window','目标视窗','目标窗口'], label: ['label','标签']
};
function firstValue(row, keys) { const entry=Object.entries(row||{}).find(([key])=>keys.some(alias=>canonicalFieldName(key)===canonicalFieldName(alias))); return entry?.[1]; }
function splitValues(value) { return Array.isArray(value) ? value.flatMap(splitValues) : String(value??'').split(/[;,|，、\n]+/).map(v=>v.trim()).filter(Boolean); }
function normalizeSubdomain(value) { return normalizedDomain(String(value||'')); }
function buildAdUnits(payload, rules={}) {
  const rows=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.rows)?payload.rows:[];
  const subdomains=(rules.subdomains||[]).map(normalizeSubdomain).filter(Boolean), types=(rules.inventoryTypes||[]).map(String).filter(Boolean), sizes=(rules.sizes||[]).map(String).filter(Boolean);
  const result=[];
  for(const row of rows){
    const rawSubdomains=splitValues(firstValue(row,builderAliases.subdomain)).map(normalizeSubdomain).filter(Boolean);
    const rowTypes=splitValues(firstValue(row,builderAliases.inventoryType));
    const rowSizes=splitValues(firstValue(row,builderAliases.size));
    const domains=subdomains.length?subdomains:(rawSubdomains.length?rawSubdomains:['unmapped']);
    const selectedTypes=types.length?types:(rowTypes.length?rowTypes:['standard']);
    const selectedSizes=sizes.length?sizes:(rowSizes.length?rowSizes:['responsive']);
    for(const subdomain of domains) for(const inventoryType of selectedTypes) for(const size of selectedSizes) {
      const code=`${subdomain}-${inventoryType}-${size}`.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,120);
      const sourceName=String(firstValue(row,builderAliases.name)||'').trim();
      result.push({code,name:sourceName||`${subdomain} / ${inventoryType} / ${size}`,subdomain,inventoryType,size,description:String(firstValue(row,builderAliases.description)||''),adsenseEnabled:['true','1','yes','是'].includes(String(firstValue(row,builderAliases.adsenseEnabled)||'').toLowerCase()),placement:String(firstValue(row,builderAliases.placement)||''),targetWindow:String(firstValue(row,builderAliases.targetWindow)||''),label:String(firstValue(row,builderAliases.label)||''),sourceRow:row});
    }
  }
  return [...new Map(result.map(item=>[item.code,item])).values()];
}

app.post('/api/admin/ad-units/preview', requireAuth, requireAdmin, (req,res) => {
  const items=buildAdUnits(req.body?.payload,req.body?.rules); if(!items.length)return res.status(400).json({ok:false,error:'no_ad_units_detected'});
  const existing=new Set(db.prepare('SELECT code FROM managed_ad_units').all().map(row=>row.code.toLowerCase()));
  res.json({ok:true,total:items.length,duplicates:items.filter(item=>existing.has(item.code)).map(item=>item.code),items:items.slice(0,500)});
});
app.post('/api/admin/ad-units/create', requireAuth, requireAdmin, (req,res) => {
  const items=Array.isArray(req.body?.items)?req.body.items:buildAdUnits(req.body?.payload,req.body?.rules); if(!items.length)return res.status(400).json({ok:false,error:'no_ad_units'});
  const insert=db.prepare('INSERT OR IGNORE INTO managed_ad_units(code,name,subdomain,inventory_type,size,description,adsense_enabled,placement,target_window,label,source_row_json,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const created=transaction(()=>items.reduce((count,item)=>count+Number(insert.run(item.code,item.name,item.subdomain,item.inventoryType,item.size,item.description||'',item.adsenseEnabled?1:0,item.placement||'',item.targetWindow||'',item.label||'',JSON.stringify(item.sourceRow||{}),'planned',req.user.email).changes),0));
  audit(req.user.email,'ad_units.create','ad_unit_batch','',JSON.stringify({requested:items.length,created}),req.ip); res.status(201).json({ok:true,created,skipped:items.length-created,status:'planned',message:'已保存本地广告单元计划，等待 GAM API 授权后执行真实创建'});
});
app.get('/api/admin/ad-units', requireAuth, requireAdmin, (_req,res) => res.json({ok:true,items:db.prepare('SELECT id,code,name,subdomain,inventory_type inventoryType,size,description,adsense_enabled adsenseEnabled,placement,target_window targetWindow,label,status,provider_id providerId,gam_network_code gamNetworkCode,gam_parent_ad_unit gamParentAdUnit,publish_error publishError,published_at publishedAt,created_at createdAt FROM managed_ad_units ORDER BY id DESC LIMIT 1000').all()}));

const { runHourlyGamSync } = registerGamRoutes(app, { db, requireAuth, requireAdmin, encryptCredential, tokenFor: gamTokenFor, gamSync, audit });

let dashboardDailyReady = true;
function refreshDashboardDaily(channelId, start, end) {
  const scoped = Number.isSafeInteger(channelId) && channelId > 0 && validDate(start) && validDate(end);
  const where = scoped ? 'WHERE rf.channel_id=? AND rf.report_date BETWEEN ? AND ?' : '';
  const params = scoped ? [channelId, start, end] : [];
  const domain = mappedDomainSql('rf');
  const settled = settledRevenueSql('rf');
  const insertSql = 'INSERT INTO dashboard_daily(report_date,channel_id,domain,requests,matched_requests,impressions,clicks,revenue,settled_revenue) '
    + 'SELECT rf.report_date,rf.channel_id,' + domain + ',SUM(rf.requests),SUM(rf.matched_requests),'
    + 'SUM(rf.impressions),SUM(rf.clicks),SUM(rf.revenue),SUM(' + settled + ') '
    + 'FROM revenue_facts rf ' + where + ' GROUP BY rf.report_date,rf.channel_id,' + domain;
  transaction(() => {
    if (scoped) db.prepare('DELETE FROM dashboard_daily WHERE channel_id=? AND report_date BETWEEN ? AND ?').run(...params);
    else db.exec('DELETE FROM dashboard_daily');
    db.prepare(insertSql).run(...params);
  });
  dashboardDailyReady = true;
  invalidateReportCache();
}
if (!db.prepare('SELECT 1 FROM dashboard_daily LIMIT 1').get() &&
    db.prepare('SELECT 1 FROM revenue_facts LIMIT 1').get()) refreshDashboardDaily();

app.get('/api/dashboard', requireAuth, cachedReport, (req, res) => {
  const scope = reportScope(req), { start, end } = range(req), where = whereScope(scope, start, end);
  const source = dashboardDailyReady ? 'dashboard_daily' : 'revenue_facts';
  const sums = db.prepare('SELECT COALESCE(SUM(requests),0) requests,COALESCE(SUM(matched_requests),0) matched,COALESCE(SUM(impressions),0) impressions,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(revenue),0) revenue FROM ' + source + ' WHERE ' + where.sql).get(...where.params);
  const factor = req.user.role === 'channel' ? (dashboardDailyReady ? 'settled_revenue' : settledRevenueSql('revenue_facts')) : 'revenue';
  const domain = dashboardDailyReady ? 'domain' : mappedDomainSql('revenue_facts');
  const trend = db.prepare('SELECT report_date date,ROUND(SUM(' + factor + '),6) revenue FROM ' + source + ' WHERE ' + where.sql + ' GROUP BY report_date ORDER BY report_date').all(...where.params);
  const topUrls = db.prepare('SELECT ' + domain + ' url,ROUND(SUM(' + factor + '),6) revenue FROM ' + source + ' WHERE ' + where.sql + ' GROUP BY ' + domain + ' ORDER BY revenue DESC LIMIT 10').all(...where.params);
  const lastSync = db.prepare("SELECT MAX(value) value FROM (SELECT MAX(created_at) value FROM import_runs UNION ALL SELECT MAX(finished_at) value FROM soap_sync_runs WHERE status='success')").get()?.value || null;
  const settledWhere = where.sql.replaceAll('report_date', 'rf.report_date').replaceAll('channel_id', 'rf.channel_id');
  const settledRevenue = dashboardDailyReady
    ? db.prepare('SELECT COALESCE(SUM(settled_revenue),0) value FROM dashboard_daily WHERE ' + where.sql).get(...where.params).value
    : db.prepare('SELECT COALESCE(SUM(' + settledRevenueSql('rf') + '),0) value FROM revenue_facts rf WHERE ' + settledWhere).get(...where.params).value;
  res.json({ ok: true, summary: { ...sums, revenue: req.user.role === 'channel' ? settledRevenue : sums.revenue, channelRevenue: settledRevenue, matchRate: sums.requests ? sums.matched * 100 / sums.requests : 0 }, trend, topUrls, lastSync });
});

const reportDimensionMap = {
  date: 'rf.report_date', hour: 'rf.hour', url: mappedDomainSql('rf'),
  country: 'rf.country', adUnit: 'rf.ad_unit', adUnitId: 'rf.ad_unit_id',
  account: 'rf.account', channel: 'rf.channel_id',
  advertiser: "COALESCE(ua.advertiser,'')", bd: "COALESCE(ua.bd,'')"
};
const reportMetricMap = {
  requests: 'requests', matchedRequests: 'matchedRequests', impressions: 'impressions',
  clicks: 'clicks', revenue: 'revenue', matchRate: 'matchRate',
  impressionRate: 'impressionRate', clickRate: 'clickRate', ecpm: 'ecpm',
  upstreamRevenue: 'upstreamRevenue', channelRevenue: 'channelRevenue',
  grossProfit: 'upstreamRevenue*0.85-channelRevenue',
  upstreamSharePercent: 'upstreamSharePercent', channelSharePercent: 'channelSharePercent'
};
function serveReports(req, res, exportCsv = false) {
  const dimensions = [...new Set(String(req.query.dimensions || 'date,url').split(',').filter(v => Object.hasOwn(reportDimensionMap, v)))];
  if (!dimensions.length || dimensions.length > 10) return res.status(400).json({ ok:false, error:'invalid_report_dimensions' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && dimensions.some(key => ['channel','advertiser','bd'].includes(key)))
    return res.status(403).json({ ok:false, error:'report_dimension_forbidden' });
  if (!isAdmin && (req.query.advertiser || req.query.bd))
    return res.status(403).json({ ok:false, error:'report_filter_forbidden' });
  const { start, end } = range(req);
  if (start > end) return res.status(400).json({ ok:false, error:'invalid_report_range' });
  const page = Number(req.query.page || 1), requestedSize = Number(req.query.pageSize || 50);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      !Number.isSafeInteger(requestedSize) || requestedSize < 1 || requestedSize > 50000)
    return res.status(400).json({ ok:false, error:'invalid_report_page' });
  const pageSize = exportCsv ? 50001 : Math.min(200, requestedSize);
  const where = ['rf.report_date BETWEEN ? AND ?'];
  const params = [start, end];
  const addExact = (expression, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      where.push(expression + '=? COLLATE NOCASE'); params.push(String(value).trim());
    }
  };
  if (!isAdmin) { where.push('rf.channel_id=?'); params.push(req.user.channel_id); }
  else if (req.query.channelId !== undefined && req.query.channelId !== '') {
    const channelId = Number(req.query.channelId);
    if (!Number.isSafeInteger(channelId) || channelId < 1) return res.status(400).json({ ok:false, error:'invalid_channel_id' });
    where.push('rf.channel_id=?'); params.push(channelId);
  }
  if (req.query.source === 'rest') where.push("rf.source_file LIKE 'gam-rest:%'");
  else if (req.query.source && req.query.source !== 'all') return res.status(400).json({ ok:false, error:'invalid_report_source' });
  addExact('rf.account', req.query.account || req.query.upstreamAccount);
  addExact('rf.ad_unit', req.query.adUnit);
  addExact('rf.ad_unit_id', req.query.adUnitId);
  addExact('rf.country', req.query.country);
  addExact("COALESCE(ua.advertiser,'')", req.query.advertiser);
  addExact("COALESCE(ua.bd,'')", req.query.bd);
  if (req.query.domain) addExact(mappedDomainSql('rf'), normalizedDomain(req.query.domain));
  if (req.query.hour !== undefined && req.query.hour !== '') {
    const hour = Number(req.query.hour);
    if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) return res.status(400).json({ ok:false, error:'invalid_report_hour' });
    where.push('rf.hour=?'); params.push(hour);
  }
  if (req.query.drill !== undefined) {
    let drill;
    try { drill = JSON.parse(String(req.query.drill)); } catch { return res.status(400).json({ ok:false, error:'invalid_report_drill' }); }
    if (!drill || Array.isArray(drill) || typeof drill !== 'object' || Object.keys(drill).length > 10 ||
        Object.keys(drill).some(key => !Object.hasOwn(reportDimensionMap, key) ||
          (!isAdmin && ['channel','advertiser','bd'].includes(key)) ||
          (drill[key] !== null && !['string','number'].includes(typeof drill[key])) ||
          String(drill[key]).length > 500))
      return res.status(400).json({ ok:false, error:'invalid_report_drill' });
    for (const [key, value] of Object.entries(drill)) {
      if (value === null) where.push(`${reportDimensionMap[key]} IS NULL`);
      else { where.push(`${reportDimensionMap[key]}=?`); params.push(value); }
    }
  }
  const select = dimensions.map(key => key === 'channel' ? 'rf.channel_id AS channelId,c.name AS channel' : `${reportDimensionMap[key]} AS ${key}`).join(',');
  const group = dimensions.map(key => reportDimensionMap[key]).join(',');
  const settled = settledRevenueSql('rf');
  const gross = 'grossRevenue', visible = isAdmin ? gross : 'channelRevenue';
  const rateSql = {
    ...reportMetricMap,
    revenue: visible, matchRate: 'CASE WHEN requests=0 THEN 0 ELSE matchedRequests*100.0/requests END',
    impressionRate: 'CASE WHEN matchedRequests=0 THEN 0 ELSE impressions*100.0/matchedRequests END',
    clickRate: 'CASE WHEN impressions=0 THEN 0 ELSE clicks*100.0/impressions END',
    ecpm: `CASE WHEN impressions=0 THEN 0 ELSE ${visible}*1000.0/impressions END`
  };
  const metricFilters = [], metricParams = [];
  for (const [key, expression] of Object.entries(rateSql)) {
    for (const [prefix, op] of [['min','>='], ['max','<=']]) {
      const raw = req.query[prefix + key[0].toUpperCase() + key.slice(1)];
      if (raw === undefined || raw === '') continue;
      if (!isAdmin && ['upstreamRevenue','grossProfit','upstreamSharePercent','channelSharePercent'].includes(key))
        return res.status(403).json({ ok:false, error:'report_filter_forbidden' });
      const threshold = Number(raw);
      if (!Number.isFinite(threshold)) return res.status(400).json({ ok:false, error:'invalid_report_metric_filter' });
      metricFilters.push(`${expression} ${op} ?`); metricParams.push(threshold);
    }
  }
  const metricWhere = metricFilters.length ? 'WHERE ' + metricFilters.join(' AND ') : '';
  const sql = `WITH grouped AS (
    SELECT ${select}, MAX(rf.report_date) sortDate,
      SUM(rf.requests) requests, SUM(rf.matched_requests) matchedRequests,
      SUM(rf.impressions) impressions, SUM(rf.clicks) clicks,
      ROUND(SUM(rf.revenue),6) grossRevenue,
      ROUND(SUM(rf.revenue*${upstreamShareSql('rf')}/100.0),6) upstreamRevenue,
      ROUND(SUM(${settled}),6) channelRevenue,
      ROUND(AVG(${upstreamShareSql('rf')}),2) upstreamSharePercent,
      ROUND(AVG(${channelRuleShareSql('rf')}),2) channelSharePercent
    FROM revenue_facts rf
    JOIN channels c ON c.id=rf.channel_id
    LEFT JOIN upstream_accounts ua ON ua.account_key=rf.account
    WHERE ${where.join(' AND ')} GROUP BY ${group}
  ) SELECT grouped.*, COUNT(*) OVER() totalRows FROM grouped ${metricWhere}
    ORDER BY sortDate DESC, ${visible} DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, ...metricParams, pageSize, exportCsv ? 0 : (page-1)*pageSize);
  const items = rows.map(row => {
    const { grossRevenue, sortDate, totalRows, ...base } = row;
    const revenue = isAdmin ? grossRevenue : row.channelRevenue;
    const info = domainInfo(row.url || domainFromAdUnit(row.adUnit));
    return { ...base, url: row.url || info.domain, rawUrl: row.url, mainDomain: info.mainDomain,
      domainType: info.domainType, revenue, ecpm: row.impressions ? revenue*1000/row.impressions : 0,
      matchRate: row.requests ? row.matchedRequests*100/row.requests : 0,
      impressionRate: row.matchedRequests ? row.impressions*100/row.matchedRequests : 0,
      clickRate: row.impressions ? row.clicks*100/row.impressions : 0,
      upstreamRevenue: isAdmin ? row.upstreamRevenue : undefined,
      upstreamSharePercent: isAdmin ? row.upstreamSharePercent : undefined,
      channelSharePercent: isAdmin ? row.channelSharePercent : undefined,
      grossProfit: isAdmin ? row.upstreamRevenue*0.85-row.channelRevenue : undefined };
  });
  if (exportCsv) {
    if (rows.length > 50000) return res.status(413).json({ ok:false, error:'report_export_too_large' });
    const metrics = [...new Set(String(req.query.metrics || 'requests,matchedRequests,impressions,clicks,revenue,matchRate,impressionRate,clickRate,ecpm').split(',').filter(key => Object.hasOwn(reportMetricMap,key)))];
    const allowed = isAdmin ? metrics : metrics.filter(key =>
      !['upstreamRevenue','grossProfit','upstreamSharePercent','channelSharePercent'].includes(key));
    const columns = [...dimensions, ...allowed];
    const csvCell = (key, value) => {
      const raw = String(value ?? '');
      return dimensions.includes(key) && /^[=+@-]/.test(raw.trimStart()) ? "'" + raw : raw;
    };
    const csv = [columns.join(','), ...items.map(item => columns.map(key => `"${csvCell(key,item[key]).replaceAll('\"','\"\"')}"`).join(','))].join('\r\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename=adx-report.csv');
    return res.send('\uFEFF' + csv);
  }
  res.json({ ok:true, items, total: rows[0]?.totalRows || 0, page, pageSize, dimensions });
}
app.get('/api/reports', requireAuth, cachedReport, (req, res) => serveReports(req, res));
app.get('/api/reports/export', requireAuth, (req, res) => serveReports(req, res, true));

// Account-level report for the admin console. Keep settlement calculations on
// the server so callers never need to infer the upstream deduction.
app.get('/api/admin/reports/accounts', requireAuth, requireAdmin, cachedReport, (req, res) => {
  const { start, end } = range(req);
  const filters = ['rf.report_date BETWEEN ? AND ?'];
  const params = [start, end];
  const channelId = Number(req.query.channelId || 0);
  if (channelId) {
    filters.push('rf.channel_id=?');
    params.push(channelId);
  }
  const account = String(req.query.account || req.query.upstreamAccount || '').trim();
  if (account) {
    filters.push('lower(rf.account)=lower(?)');
    params.push(account);
  }
  const adUnit = String(req.query.adUnit || '').trim();
  if (adUnit) {
    filters.push('lower(rf.ad_unit)=lower(?)');
    params.push(adUnit);
  }
  const domain = String(req.query.domain || '').trim();
  if (domain) {
    filters.push(`lower(${mappedDomainSql('rf')})=lower(?)`);
    params.push(normalizedDomain(domain));
  }
  const channel = String(req.query.channel || '').trim();
  if (channel) {
    filters.push('lower(c.name)=lower(?)');
    params.push(channel);
  }
  const where = filters.join(' AND ');
  const settled = settledRevenueSql('rf');
  const rows = db.prepare(`
    SELECT
      rf.account AS account,
      COALESCE(NULLIF(MAX(ua.name), ''), rf.account) AS accountName,
      COUNT(DISTINCT rf.channel_id) AS channelCount,
      COUNT(DISTINCT rf.ad_unit) AS adUnitCount,
      COUNT(DISTINCT ${mappedDomainSql('rf')}) AS domainCount,
      SUM(rf.requests) AS requests,
      SUM(rf.matched_requests) AS matchedRequests,
      SUM(rf.impressions) AS impressions,
      SUM(rf.clicks) AS clicks,
      ROUND(SUM(rf.revenue), 6) AS revenue,
      ROUND(SUM(rf.revenue * (${upstreamShareSql('rf')}/100.0)), 6) AS upstreamRevenue,
      ROUND(SUM(${settled}), 6) AS channelRevenue,
      ROUND(AVG(${upstreamShareSql('rf')}), 2) AS upstreamSharePercent,
      ROUND(AVG(${channelRuleShareSql('rf')}), 2) AS channelSharePercent
    FROM revenue_facts rf
    LEFT JOIN upstream_accounts ua ON lower(ua.account_key)=lower(rf.account) AND ua.status='active'
    LEFT JOIN channels c ON c.id=rf.channel_id
    WHERE ${where}
    GROUP BY rf.account
    ORDER BY revenue DESC, rf.account
    LIMIT 5000
  `).all(...params);
  res.json({
    ok: true,
    range: { start, end },
    items: rows.map(row => ({
      ...row,
      matchRate: Number(row.requests) ? Number(row.matchedRequests) * 100 / Number(row.requests) : 0,
      ecpm: Number(row.impressions) ? Number(row.revenue) * 1000 / Number(row.impressions) : 0,
      upstreamEcpm: Number(row.impressions) ? Number(row.upstreamRevenue) * 1000 / Number(row.impressions) : 0,
      channelEcpm: Number(row.impressions) ? Number(row.channelRevenue) * 1000 / Number(row.impressions) : 0,
      grossProfit: Number(row.upstreamRevenue || 0) * 0.85 - Number(row.channelRevenue || 0)
    }))
  });
});

app.get('/api/admin/report-api-keys', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, items: db.prepare(`SELECT id,name,key_prefix keyPrefix,scope,status,created_by createdBy,created_at createdAt,revoked_at revokedAt FROM report_api_keys ORDER BY id DESC`).all() });
});
app.post('/api/admin/report-api-keys', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ ok: false, error: 'key_name_required' });
  const secret = `adx_account_${crypto.randomBytes(32).toString('base64url')}`;
  const prefix = secret.slice(0, 24);
  const result = db.prepare(`INSERT INTO report_api_keys(name,key_prefix,key_hash,created_by) VALUES(?,?,?,?)`).run(name, prefix, sha256(secret), req.user.email);
  audit(req.user.email, 'report_api_key.create', 'report_api_key', result.lastInsertRowid, JSON.stringify({ name, scope: 'account_reports_read' }), req.ip);
  res.status(201).json({ ok: true, item: { id: Number(result.lastInsertRowid), name, keyPrefix: prefix, scope: 'account_reports_read', status: 'active' }, key: secret });
});
app.post('/api/admin/report-api-keys/:id/revoke', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'invalid_key_id' });
  const result = db.prepare("UPDATE report_api_keys SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(id);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'active_key_not_found' });
  audit(req.user.email, 'report_api_key.revoke', 'report_api_key', id, '', req.ip);
  res.json({ ok: true, revoked: true });
});

app.get('/api/public/account/revenue', requireAccountReportKey, (req, res) => {
  const { start, end } = range(req);
  const filters = ['rf.report_date BETWEEN ? AND ?'];
  const params = [start, end];
  const account = String(req.query.account || req.query.upstreamAccount || '').trim();
  if (account) { filters.push('lower(rf.account)=lower(?)'); params.push(account); }
  const channelId = Number(req.query.channelId || 0);
  if (channelId) { filters.push('rf.channel_id=?'); params.push(channelId); }
  const where = filters.join(' AND ');
  const settled = settledRevenueSql('rf');
  const rows = db.prepare(`
    SELECT rf.report_date date,rf.account account,COALESCE(NULLIF(MAX(ua.name),''),rf.account) accountName,
      SUM(rf.requests) requests,SUM(rf.matched_requests) matchedRequests,SUM(rf.impressions) impressions,
      SUM(rf.clicks) clicks,ROUND(SUM(rf.revenue),6) revenue,
      ROUND(SUM(rf.revenue*(${upstreamShareSql('rf')}/100.0)),6) upstreamRevenue,
      ROUND(SUM(${settled}),6) channelRevenue
    FROM revenue_facts rf
    LEFT JOIN upstream_accounts ua ON lower(ua.account_key)=lower(rf.account) AND ua.status='active'
    WHERE ${where}
    GROUP BY rf.report_date,rf.account
    ORDER BY rf.report_date DESC,revenue DESC
    LIMIT 10000
  `).all(...params);
  res.json({ ok: true, range: { start, end }, items: rows.map(row => ({
    ...row,
    matchRate: Number(row.requests) ? Number(row.matchedRequests) * 100 / Number(row.requests) : 0,
    ecpm: Number(row.impressions) ? Number(row.revenue) * 1000 / Number(row.impressions) : 0,
    upstreamEcpm: Number(row.impressions) ? Number(row.upstreamRevenue) * 1000 / Number(row.impressions) : 0,
    channelEcpm: Number(row.impressions) ? Number(row.channelRevenue) * 1000 / Number(row.impressions) : 0,
    grossProfit: Number(row.upstreamRevenue || 0) * 0.85 - Number(row.channelRevenue || 0)
  })) });
});

app.get('/api/admin/upstream-accounts', requireAuth, requireAdmin, (_req,res) => res.json({ ok:true, items:db.prepare('SELECT u.id,u.account_key accountKey,u.name,u.advertiser,u.bd,u.soap_account_id gamAccountId,s.name gamAccountName,s.network_code networkCode,u.share_percent sharePercent,u.status,u.created_at createdAt,u.updated_at updatedAt FROM upstream_accounts u LEFT JOIN soap_accounts s ON s.id=u.soap_account_id ORDER BY u.account_key').all() }));
app.post('/api/admin/upstream-accounts', requireAuth, requireAdmin, (req,res) => {
  const accountKey=String(req.body?.accountKey||'').trim(), name=String(req.body?.name||accountKey).trim(), share=Number(req.body?.sharePercent), gamAccountId=Number(req.body?.gamAccountId)||null;
  const advertiser=String(req.body?.advertiser||'').trim(), bd=String(req.body?.bd||'').trim();
  if(!accountKey||!name||advertiser.length>200||bd.length>200||!Number.isFinite(share)||share<0||share>100||(gamAccountId&&!db.prepare('SELECT id FROM soap_accounts WHERE id=?').get(gamAccountId)))return res.status(400).json({ok:false,error:'invalid_upstream_account'});
  try { const r=db.prepare('INSERT INTO upstream_accounts(account_key,name,soap_account_id,share_percent,advertiser,bd,status) VALUES(?,?,?,?,?,?,?)').run(accountKey,name,gamAccountId,share,advertiser,bd,'active'); audit(req.user.email,'upstream_account.create','upstream_account',r.lastInsertRowid,JSON.stringify({accountKey,name,gamAccountId,share,advertiser,bd}),req.ip); res.status(201).json({ok:true,item:db.prepare('SELECT id,account_key accountKey,name,advertiser,bd,soap_account_id gamAccountId,share_percent sharePercent,status FROM upstream_accounts WHERE id=?').get(r.lastInsertRowid)}); } catch { res.status(409).json({ok:false,error:'account_exists'}); }
});
app.put('/api/admin/upstream-accounts/:id', requireAuth, requireAdmin, (req,res) => {
  const id=Number(req.params.id), name=String(req.body?.name||'').trim(), share=Number(req.body?.sharePercent), status=req.body?.status==='disabled'?'disabled':'active';
  const before=db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(id); if(!before)return res.status(404).json({ok:false,error:'upstream_account_not_found'});
  const advertiser=String(req.body?.advertiser??before.advertiser).trim(), bd=String(req.body?.bd??before.bd).trim();
  if(!Number.isSafeInteger(id)||!name||advertiser.length>200||bd.length>200||!Number.isFinite(share)||share<0||share>100)return res.status(400).json({ok:false,error:'invalid_upstream_account'});
  const gamAccountId=req.body?.gamAccountId===undefined?before.soap_account_id:(Number(req.body.gamAccountId)||null);
  if(gamAccountId&&!db.prepare('SELECT id FROM soap_accounts WHERE id=?').get(gamAccountId))return res.status(400).json({ok:false,error:'invalid_gam_account'});
  db.prepare('UPDATE upstream_accounts SET name=?,soap_account_id=?,share_percent=?,advertiser=?,bd=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,gamAccountId,share,advertiser,bd,status,id);
  if(gamAccountId!==before.soap_account_id||status!=='active')db.prepare('UPDATE soap_accounts SET rest_sync_enabled=0 WHERE rest_upstream_account_id=?').run(id);
  const after=db.prepare('SELECT id,account_key accountKey,name,advertiser,bd,soap_account_id gamAccountId,share_percent sharePercent,status FROM upstream_accounts WHERE id=?').get(id); audit(req.user.email,'upstream_account.update','upstream_account',id,JSON.stringify({before,after}),req.ip); res.json({ok:true,item:after});
});
app.get('/api/admin/ad-unit-domains', requireAuth, requireAdmin, (_req,res) => res.json({ok:true,items:db.prepare('SELECT id,ad_unit adUnit,domain,created_by createdBy,created_at createdAt,updated_at updatedAt FROM ad_unit_domains ORDER BY ad_unit').all()}));
app.post('/api/admin/ad-unit-domains', requireAuth, requireAdmin, (req,res) => {
  const adUnit=String(req.body?.adUnit||'').trim(), domain=normalizedDomain(req.body?.domain); if(!adUnit||!domain)return res.status(400).json({ok:false,error:'invalid_ad_unit_domain'});
  try { const r=db.prepare('INSERT INTO ad_unit_domains(ad_unit,domain,created_by) VALUES(?,?,?)').run(adUnit,domain,req.user.email); audit(req.user.email,'ad_unit_domain.create','ad_unit_domain',r.lastInsertRowid,JSON.stringify({adUnit,domain}),req.ip); res.status(201).json({ok:true,item:db.prepare('SELECT id,ad_unit adUnit,domain FROM ad_unit_domains WHERE id=?').get(r.lastInsertRowid)}); } catch { res.status(409).json({ok:false,error:'ad_unit_exists'}); }
});
app.put('/api/admin/ad-unit-domains/:id', requireAuth, requireAdmin, (req,res) => { const id=Number(req.params.id), domain=normalizedDomain(req.body?.domain); if(!Number.isSafeInteger(id)||!domain)return res.status(400).json({ok:false,error:'invalid_ad_unit_domain'}); const before=db.prepare('SELECT * FROM ad_unit_domains WHERE id=?').get(id); if(!before)return res.status(404).json({ok:false,error:'ad_unit_domain_not_found'}); db.prepare('UPDATE ad_unit_domains SET domain=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(domain,id); const after=db.prepare('SELECT id,ad_unit adUnit,domain FROM ad_unit_domains WHERE id=?').get(id); audit(req.user.email,'ad_unit_domain.update','ad_unit_domain',id,JSON.stringify({before,after}),req.ip); res.json({ok:true,item:after}); });
app.get('/api/admin/share-rules', requireAuth, requireAdmin, (req,res) => { const channelId=Number(req.query.channelId||0); const where=channelId?'WHERE r.channel_id=?':''; res.json({ok:true,items:db.prepare(`SELECT r.id,r.channel_id channelId,c.name channelName,r.scope_type scopeType,r.scope_value scopeValue,r.share_percent sharePercent,r.effective_from effectiveFrom,r.created_by createdBy FROM channel_share_rules r JOIN channels c ON c.id=r.channel_id ${where} ORDER BY r.effective_from DESC,r.id DESC`).all(...(channelId?[channelId]:[]))}); });
app.post('/api/admin/share-rules', requireAuth, requireAdmin, (req,res) => { const channelId=Number(req.body?.channelId), scopeType=String(req.body?.scopeType||''), scopeValue=String(req.body?.scopeValue||'').trim(), share=Number(req.body?.sharePercent), effectiveFrom=String(req.body?.effectiveFrom||new Date().toISOString().slice(0,10)); if(!Number.isSafeInteger(channelId)||!['account','ad_unit'].includes(scopeType)||!scopeValue||!Number.isFinite(share)||share<0||share>100||!validDate(effectiveFrom)||!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId))return res.status(400).json({ok:false,error:'invalid_share_rule'}); try { const r=db.prepare('INSERT INTO channel_share_rules(channel_id,scope_type,scope_value,share_percent,effective_from,created_by) VALUES(?,?,?,?,?,?)').run(channelId,scopeType,scopeValue,share,effectiveFrom,req.user.email); audit(req.user.email,'share_rule.create','share_rule',r.lastInsertRowid,JSON.stringify({channelId,scopeType,scopeValue,share,effectiveFrom}),req.ip); res.status(201).json({ok:true,id:r.lastInsertRowid}); } catch { res.status(409).json({ok:false,error:'share_rule_exists'}); } });
app.get('/api/admin/domain-share-rules', requireAuth, requireAdmin, (_req,res) => res.json({ok:true,items:db.prepare('SELECT r.id,r.upstream_account_id upstreamAccountId,u.name upstreamAccountName,r.channel_id channelId,c.name channelName,r.domain,r.share_percent sharePercent,r.effective_from effectiveFrom FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id JOIN channels c ON c.id=r.channel_id ORDER BY r.effective_from DESC,r.id DESC').all()}));
app.post('/api/admin/domain-share-rules', requireAuth, requireAdmin, (req,res) => { const upstreamAccountId=Number(req.body?.upstreamAccountId),channelId=Number(req.body?.channelId),domain=normalizedDomain(req.body?.domain),share=Number(req.body?.sharePercent),effectiveFrom=String(req.body?.effectiveFrom||new Date().toISOString().slice(0,10)); if(!Number.isSafeInteger(upstreamAccountId)||!Number.isSafeInteger(channelId)||!Number.isFinite(share)||share<0||share>100||!validDate(effectiveFrom)||!db.prepare('SELECT id FROM upstream_accounts WHERE id=?').get(upstreamAccountId)||!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId))return res.status(400).json({ok:false,error:'invalid_domain_share_rule'}); try { const r=db.prepare('INSERT INTO channel_domain_share_rules(upstream_account_id,channel_id,domain,share_percent,effective_from,created_by) VALUES(?,?,?,?,?,?)').run(upstreamAccountId,channelId,domain,share,effectiveFrom,req.user.email); audit(req.user.email,'domain_share_rule.create','domain_share_rule',r.lastInsertRowid,JSON.stringify({upstreamAccountId,channelId,domain:domain||'all',share,effectiveFrom}),req.ip); res.status(201).json({ok:true,id:r.lastInsertRowid}); } catch { res.status(409).json({ok:false,error:'domain_share_rule_exists'}); } });
app.put('/api/admin/domain-share-rules/:id', requireAuth, requireAdmin, (req,res) => { const id=Number(req.params.id),upstreamAccountId=Number(req.body?.upstreamAccountId),channelId=Number(req.body?.channelId),domain=normalizedDomain(req.body?.domain),share=Number(req.body?.sharePercent),effectiveFrom=String(req.body?.effectiveFrom||new Date().toISOString().slice(0,10)); if(!Number.isSafeInteger(id)||!Number.isSafeInteger(upstreamAccountId)||!Number.isSafeInteger(channelId)||!Number.isFinite(share)||share<0||share>100||!validDate(effectiveFrom)||!db.prepare('SELECT id FROM upstream_accounts WHERE id=?').get(upstreamAccountId)||!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId))return res.status(400).json({ok:false,error:'invalid_domain_share_rule'}); const before=db.prepare('SELECT * FROM channel_domain_share_rules WHERE id=?').get(id); if(!before)return res.status(404).json({ok:false,error:'domain_share_rule_not_found'}); try { db.prepare('UPDATE channel_domain_share_rules SET upstream_account_id=?,channel_id=?,domain=?,share_percent=?,effective_from=? WHERE id=?').run(upstreamAccountId,channelId,domain,share,effectiveFrom,id); audit(req.user.email,'domain_share_rule.update','domain_share_rule',id,JSON.stringify({before,upstreamAccountId,channelId,domain,share,effectiveFrom}),req.ip); res.json({ok:true}); } catch { res.status(409).json({ok:false,error:'domain_share_rule_exists'}); } });

app.get('/api/admin/channels', requireAuth, requireAdmin, (_req, res) => {
  const items = db.prepare(`SELECT c.id,c.name,c.email,c.share_percent sharePercent,c.status,c.created_at createdAt,
    (SELECT COUNT(*) FROM channel_domains d WHERE d.channel_id=c.id) domainCount,
    CASE WHEN c.api_secret_hash IS NULL THEN 0 ELSE 1 END apiConfigured FROM channels c ORDER BY c.id DESC`).all();
  res.json({ ok: true, items });
});
app.post('/api/admin/channels', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim(), email = normalizeEmail(req.body?.email), password = String(req.body?.password || ''), share = Number(req.body?.sharePercent);
  if (!name || !email || password.length < 10 || !Number.isFinite(share) || share < 0 || share > 100) return res.status(400).json({ ok: false, error: 'invalid_channel' });
  const tx = () => transaction(() => {
    const secret = `adx_${crypto.randomBytes(24).toString('base64url')}`;
    const result = db.prepare('INSERT INTO channels(name,email,share_percent,status,api_secret_hash,api_secret_ciphertext) VALUES(?,?,?,?,?,?)').run(name, email, share, req.body?.status === 'disabled' ? 'disabled' : 'active', sha256(secret), encryptCredential({ secret }));
    db.prepare("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?)").run(result.lastInsertRowid, share, '1900-01-01', req.user.email);
    db.prepare("INSERT INTO users(email,name,password_hash,role,channel_id,status) VALUES(?,?,?,'channel',?,?)").run(email, name, passwordHash(password), result.lastInsertRowid, req.body?.status === 'disabled' ? 'disabled' : 'active');
    return { id: Number(result.lastInsertRowid), secret };
  });
  try { const created = tx(); audit(req.user.email, 'channel.create', 'channel', created.id, JSON.stringify({ name, email, share }), req.ip); res.status(201).json({ ok: true, channel: db.prepare('SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?').get(created.id), secret: created.secret }); }
  catch (error) { res.status(error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500).json({ ok: false, error: error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' ? 'email_exists' : 'save_failed' }); }
});
app.put('/api/admin/channels/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id), name = String(req.body?.name || '').trim(), share = Number(req.body?.sharePercent), status = req.body?.status === 'disabled' ? 'disabled' : 'active', effectiveFrom = String(req.body?.effectiveFrom || new Date().toISOString().slice(0,10));
  if (!Number.isSafeInteger(id) || !name || !Number.isFinite(share) || share < 0 || share > 100) return res.status(400).json({ ok: false, error: 'invalid_channel' });
  if (!validDate(effectiveFrom)) return res.status(400).json({ ok: false, error: 'invalid_effective_date' });
  const before = db.prepare('SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?').get(id);
  if (!before) return res.status(404).json({ ok: false, error: 'channel_not_found' });
  const after = transaction(() => { db.prepare("UPDATE channels SET name=?,share_percent=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name, share, status, id); db.prepare("UPDATE users SET name=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE channel_id=? AND role='channel'").run(name, status, id); db.prepare("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?) ON CONFLICT(channel_id,effective_from) DO UPDATE SET share_percent=excluded.share_percent,created_by=excluded.created_by").run(id, share, effectiveFrom, req.user.email); return db.prepare('SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?').get(id); });
  audit(req.user.email, 'channel.update', 'channel', id, JSON.stringify({ before, after }), req.ip);
  res.json({ ok: true, channel: after });
});
app.post('/api/admin/channels/:id/password', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id), password = String(req.body?.password || ''); if (password.length < 10) return res.status(400).json({ ok: false, error: 'weak_password' });
  const result = db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE channel_id=? AND role='channel'").run(passwordHash(password), id);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'channel_not_found' });
  db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE channel_id=? AND role='channel')").run(id); audit(req.user.email, 'channel.password_reset', 'channel', id, '', req.ip); res.json({ ok: true });
});
app.post('/api/admin/channels/:id/api-secret', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id), secret = `adx_${crypto.randomBytes(24).toString('base64url')}`;
  const result = db.prepare('UPDATE channels SET api_secret_hash=?,api_secret_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(sha256(secret), encryptCredential({ secret }), id);
  if (!result.changes) return res.status(404).json({ ok: false, error: 'channel_not_found' });
  audit(req.user.email, 'channel.api_secret_rotate', 'channel', id, '', req.ip); res.json({ ok: true, secret });
});
app.get('/api/channel/api-secret', requireAuth, (req, res) => {
  if (req.user.role !== 'channel' || !req.user.channel_id) return res.status(403).json({ ok: false, error: 'channel_only' });
  const row = db.prepare('SELECT api_secret_ciphertext FROM channels WHERE id=?').get(req.user.channel_id);
  if (!row?.api_secret_ciphertext) return res.status(404).json({ ok: false, error: 'api_secret_not_generated' });
  const value = decryptCredential(row.api_secret_ciphertext);
  res.json({ ok: true, secret: value.secret });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => res.json({ ok: true, items: db.prepare("SELECT id,email,name,status,created_at createdAt FROM users WHERE role='admin' ORDER BY id").all() }));
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const email = normalizeEmail(req.body?.email), name = String(req.body?.name || '').trim(), password = String(req.body?.password || '');
  if (!email || !name || password.length < 10) return res.status(400).json({ ok: false, error: 'invalid_admin' });
  try { const r = db.prepare("INSERT INTO users(email,name,password_hash,role,status) VALUES(?,?,?,'admin','active')").run(email,name,passwordHash(password)); audit(req.user.email,'admin.create','user',r.lastInsertRowid,email,req.ip); res.status(201).json({ok:true}); }
  catch { res.status(409).json({ok:false,error:'email_exists'}); }
});
app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const id=Number(req.params.id), password=String(req.body?.password||''); if(password.length<10)return res.status(400).json({ok:false,error:'weak_password'});
  const target=db.prepare("SELECT email FROM users WHERE id=? AND role='admin'").get(id); if(!target)return res.status(404).json({ok:false,error:'admin_not_found'});
  db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(passwordHash(password),id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); audit(req.user.email,'admin.password_reset','user',id,target.email,req.ip); res.json({ok:true});
});

const fieldDefinitions = {
  date: { required: true, aliases: ['date','report_date','day','日期','dimension_date'] },
  hour: { aliases: ['hour','小时','dimension_hour'] },
  url: { aliases: ['url','link','链接','url_channel','dimension_url','dimension_url_channel'] },
  account: { aliases: ['account','账号','child_network','child_network_code','dimension_child_network_code','publisher'] },
  adUnit: { aliases: ['ad_unit','adunit','unit','广告单元','ad_unit_name','dimension_ad_unit_name'] },
  adUnitId: { aliases: ['ad_unit_id','dimension_ad_unit_id','广告单元ID'] },
  country: { aliases: ['country','country_code','国家','dimension_country_name','dimension_country_code'] },
  requests: { aliases: ['requests','ad_requests','请求','total_ad_requests','metric_total_ad_requests','ad_server_requests'] },
  matched: { aliases: ['matched_requests','matchedrequests','matched','匹配','total_matched_requests','metric_total_matched_requests','ad_server_matched_requests'] },
  impressions: { aliases: ['impressions','展示','total_impressions','metric_total_impressions','ad_server_impressions'] },
  clicks: { aliases: ['clicks','点击','total_clicks','metric_total_clicks','ad_server_clicks'] },
  revenue: { required: true, aliases: ['revenue','earnings','income','收益','收入','total_revenue','metric_total_revenue','ad_server_cpm_and_cpc_revenue','ad_exchange_revenue'] }
};
function canonicalFieldName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, ''); }
const canonicalAliases = Object.fromEntries(Object.entries(fieldDefinitions).map(([name, definition]) => [name, new Set(definition.aliases.map(canonicalFieldName))]));
function sourceKeys(row, field) { return Object.keys(row || {}).filter(key => canonicalAliases[field].has(canonicalFieldName(key))); }
function findSourceKey(row, field) { return sourceKeys(row, field)[0]; }
function pick(row, field) { const key=findSourceKey(row,field); return key === undefined ? undefined : row[key]; }
function inspectFields(row = {}) {
  const mappings = Object.keys(fieldDefinitions).map(field => ({ field, source: findSourceKey(row,field) })).filter(item => item.source);
  const recognized = new Set(mappings.map(item => item.source));
  return {
    mappings,
    missingRequired: Object.entries(fieldDefinitions).filter(([field, definition]) => definition.required && !findSourceKey(row,field)).map(([field]) => field),
    preservedFields: Object.keys(row).filter(field => !recognized.has(field))
  };
}
function normalizedDomain(url) { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return String(url || '').replace(/^https?:\/\//,'').split('/')[0].toLowerCase(); } }
function domainInfo(value) { const domain=normalizedDomain(value),parts=domain.split('.').filter(Boolean); const suffix=parts.length>2&&['co.uk','com.cn','com.au','co.jp','co.kr'].includes(parts.slice(-2).join('.'))?3:2; const mainDomain=parts.length>=suffix?parts.slice(-suffix).join('.'):domain; return {domain,mainDomain,domainType:domain&&domain===mainDomain?'主域名':'子域名'}; }
function normalizeFact(row, channelId, sourceFile) {
  const dateValue=pick(row,'date'), revenueValue=pick(row,'revenue'), hourValue=pick(row,'hour');
  const reportDate=String(dateValue||'').slice(0,10), url=String(pick(row,'url')||'').trim();
  const fact={channelId,reportDate,hour:hourValue===undefined?-1:Number(hourValue),url,domain:normalizedDomain(url),account:String(pick(row,'account')||''),adUnit:String(pick(row,'adUnit')||''),adUnitId:String(pick(row,'adUnitId')||''),country:String(pick(row,'country')||''),requests:Number(pick(row,'requests')||0),matched:Number(pick(row,'matched')||0),impressions:Number(pick(row,'impressions')||0),clicks:Number(pick(row,'clicks')||0),revenue:Number(revenueValue),sourceFile,rawJson:JSON.stringify(row)};
  const requiredPresent=dateValue!==undefined&&dateValue!==null&&String(dateValue).trim()!==''&&revenueValue!==undefined&&revenueValue!==null&&String(revenueValue).trim()!=='';
  const validHour=fact.hour===-1||(Number.isInteger(fact.hour)&&fact.hour>=0&&fact.hour<=23);
  const conflictingFields=Object.keys(fieldDefinitions).filter(field=>sourceKeys(row,field).length>1);
  const valid=requiredPresent&&conflictingFields.length===0&&validDate(fact.reportDate)&&validHour&&[fact.requests,fact.matched,fact.impressions,fact.clicks,fact.revenue].every(Number.isFinite)&&fact.requests>=0&&fact.matched>=0&&fact.impressions>=0&&fact.clicks>=0&&fact.revenue>=0;
  return {valid,fact,error:valid?'':conflictingFields.length?'ambiguous_fields':'invalid_required_fields',conflictingFields};
}
app.post('/api/admin/imports/preview', requireAuth, requireAdmin, (req,res)=>{
  const channelId=Number(req.body?.channelId), payload=req.body?.payload, rows=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.rows)?payload.rows:null;
  if(!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId)||!rows?.length||rows.length>200000)return res.status(400).json({ok:false,error:'invalid_import'});
  const normalized=rows.map(row=>normalizeFact(row,channelId,String(req.body?.fileName||'upload.json'))), accepted=normalized.filter(x=>x.valid).length, fields=inspectFields(rows[0]);
  res.json({ok:true,totalRows:rows.length,accepted,rejected:rows.length-accepted,detectedFields:Object.keys(rows[0]||{}),fieldMappings:fields.mappings,missingRequiredFields:fields.missingRequired,conflictingFields:[...new Set(normalized.flatMap(x=>x.conflictingFields||[]))],preservedFields:fields.preservedFields,preview:normalized.slice(0,20).map(x=>x.valid?x.fact:{error:x.error,conflictingFields:x.conflictingFields,source:x.fact})});
});
app.post('/api/admin/imports', requireAuth, requireAdmin, (req,res)=>{
  const channelId=Number(req.body?.channelId), payload=req.body?.payload, fileName=String(req.body?.fileName||'upload.json').slice(0,190), rows=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.rows)?payload.rows:null;
  if (/^gam-rest:/i.test(fileName)) return res.status(400).json({ok:false,error:'reserved_import_source'});
  if(!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId)||!rows?.length||rows.length>200000)return res.status(400).json({ok:false,error:'invalid_import'});
  const normalized=rows.map(row=>normalizeFact(row,channelId,fileName)), valid=normalized.filter(x=>x.valid), rejected=normalized.length-valid.length;
  if(!valid.length)return res.status(422).json({ok:false,error:'no_valid_rows'});
  const upsert=db.prepare(`INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP`);
  const runId=transaction(()=>{for(const {fact:f} of valid)upsert.run(f.channelId,f.reportDate,f.hour,f.url,f.domain,f.account,f.adUnit,f.adUnitId,f.country,f.requests,f.matched,f.impressions,f.clicks,f.revenue,f.sourceFile,f.rawJson);const run=db.prepare('INSERT INTO import_runs(actor_email,channel_id,source_file,total_rows,accepted_rows,rejected_rows,status,error_summary) VALUES(?,?,?,?,?,?,?,?)').run(req.user.email,channelId,fileName,rows.length,valid.length,rejected,rejected?'partial':'success',rejected?`${rejected} rows rejected`:'');return Number(run.lastInsertRowid)});
  let firstDate = valid[0].fact.reportDate, lastDate = firstDate;
  for (const { fact } of valid) {
    if (fact.reportDate < firstDate) firstDate = fact.reportDate;
    if (fact.reportDate > lastDate) lastDate = fact.reportDate;
  }
  try { refreshDashboardDaily(channelId, firstDate, lastDate); }
  catch (error) { dashboardDailyReady = false; console.error('dashboard_daily_refresh_failed', error.message); }
  audit(req.user.email,'data.import','import',runId,JSON.stringify({channelId,fileName,total:rows.length,accepted:valid.length,rejected}),req.ip); res.json({ok:true,runId,total:rows.length,accepted:valid.length,rejected});
});
app.get('/api/admin/imports', requireAuth, requireAdmin, (_req,res)=>res.json({ok:true,items:db.prepare(`SELECT r.id,r.source_file sourceFile,r.total_rows totalRows,r.accepted_rows acceptedRows,r.rejected_rows rejectedRows,r.status,r.created_at createdAt,c.name channelName FROM import_runs r JOIN channels c ON c.id=r.channel_id ORDER BY r.id DESC LIMIT 100`).all()}));

const apiAttempts = new Map();
function apiRateLimited(req, channelId) {
  const key = `${req.ip}|${channelId}`, now = Date.now(), windowMs = 60 * 1000;
  const recent = (apiAttempts.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= 60) return true;
  recent.push(now); apiAttempts.set(key, recent); return false;
}
app.get('/api/public/channel/revenue', (req,res)=>{
  const secret=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); if(!secret)return res.status(401).json({code:401,msg:'渠道密钥无效'});
  const channel=db.prepare("SELECT * FROM channels WHERE api_secret_hash=?").get(sha256(secret)); if(!channel)return res.status(401).json({code:401,msg:'渠道密钥无效'}); if(channel.status!=='active')return res.status(403).json({code:403,msg:'渠道已被禁用'});
  if (apiRateLimited(req, channel.id)) return res.status(429).json({ code: 429, msg: '请求过于频繁' });
  const start=validDate(req.query.start_date)?req.query.start_date:new Date(Date.now()-2*86400000).toISOString().slice(0,10), end=validDate(req.query.end_date)?req.query.end_date:new Date().toISOString().slice(0,10); const page=Math.max(1,Number(req.query.page||1)),pageSize=Math.min(5000,Math.max(1,Number(req.query.page_size||500))); if(Date.parse(end)-Date.parse(start)>90*86400000)return res.status(400).json({code:400,msg:'日期跨度不能超过90天'});
  const total=db.prepare('SELECT COUNT(*) n FROM revenue_facts WHERE channel_id=? AND report_date BETWEEN ? AND ?').get(channel.id,start,end).n;
  const shareSql = effectiveShareSql('revenue_facts');
  const rows=db.prepare(`SELECT report_date date,${mappedDomainSql('revenue_facts')} url,ad_unit,country,account,requests,matched_requests,impressions,clicks,ROUND(${settledRevenueSql('revenue_facts')},6) revenue,CASE WHEN impressions>0 THEN ROUND(${settledRevenueSql('revenue_facts')}*1000.0/impressions,6) ELSE 0 END ecpm FROM revenue_facts WHERE channel_id=? AND report_date BETWEEN ? AND ? ORDER BY url,ad_unit LIMIT ? OFFSET ?`).all(channel.id,start,end,pageSize,(page-1)*pageSize);
  audit(channel.email,'api.revenue','channel',channel.id,JSON.stringify({start,end,page,pageSize}),'api'); res.json({code:0,msg:'ok',data:rows,meta:{total,page,page_size:pageSize}});
});

app.get('/api/admin/audit', requireAuth, requireAdmin, (_req,res)=>res.json({ok:true,items:db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all()}));
app.get('/api/health', (req,res)=>res.json({ok:true,status:'ok',portal:portalRole(req)||'local'}));

const dist=path.join(root,'dist');
app.use(express.static(dist, { index:false, maxAge:'1h', setHeaders(res, file) {
  // Vite fingerprints assets, so a long cache avoids re-downloading the UI on every login.
  if (file.startsWith(path.join(dist, 'assets') + path.sep))
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
} }));
app.all('/api/{*path}',(_req,res)=>res.status(404).json({ok:false,error:'not_found'}));
app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
app.use((error,_req,res,_next)=>{console.error('request_failed',error.message);res.status(500).json({ok:false,error:'internal_error'})});
app.listen(port,process.env.HOST||'127.0.0.1',()=>{ console.log(`adx-channel-platform listening on ${port}`); setInterval(runHourlyGamSync,15*60*1000); if(process.env.ADX_SYNC_ON_START==='true')runHourlyGamSync(); });
