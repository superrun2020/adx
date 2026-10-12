import 'dotenv/config';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4180);
const dbPath = path.resolve(root, process.env.ADX_DB_PATH || './data/adx-channel.sqlite');
const adminHost = String(process.env.ADX_ADMIN_HOST || 'adx.geekforest.ai').toLowerCase();
const publisherHost = String(process.env.ADX_PUBLISHER_HOST || 'adxpub.geekforest.ai').toLowerCase();
const production = process.env.NODE_ENV === 'production';
const app = express();
const execFileAsync = promisify(execFile);
app.set('trust proxy', 'loopback');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
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
CREATE TABLE IF NOT EXISTS channel_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS revenue_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER,
  url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(channel_id,report_date,hour,url,account,ad_unit,country), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
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
  credential_ciphertext TEXT NOT NULL, api_version TEXT NOT NULL DEFAULT 'v202602',
  status TEXT NOT NULL DEFAULT 'untested', last_test_at TEXT, last_test_status TEXT,
  last_test_summary TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS soap_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, soap_account_id INTEGER NOT NULL, channel_id INTEGER,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, status TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT,
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_revenue_scope_date ON revenue_facts(channel_id, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_domain ON revenue_facts(domain, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_account_unit ON revenue_facts(account, ad_unit, report_date);
`);
try { db.exec('ALTER TABLE channels ADD COLUMN api_secret_ciphertext TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
for (const column of ['description','adsense_enabled','placement','target_window','label']) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('managed_ad_units') WHERE name=?`).get(column)) db.exec(`ALTER TABLE managed_ad_units ADD COLUMN ${column} ${column==='adsense_enabled'?'INTEGER NOT NULL DEFAULT 0':'TEXT NOT NULL DEFAULT \'\''}`);
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('upstream_accounts') WHERE name='soap_account_id'").get()) db.exec('ALTER TABLE upstream_accounts ADD COLUMN soap_account_id INTEGER');
if (!db.prepare("SELECT 1 FROM pragma_table_info('revenue_facts') WHERE name='raw_json'").get()) {
  db.exec("ALTER TABLE revenue_facts ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}'");
}
db.exec("INSERT OR IGNORE INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) SELECT id,share_percent,'1900-01-01','migration' FROM channels");

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
function xmlEscape(value) { return String(value).replace(/[<&>"']/g, char => ({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char])); }
function soapText(xml, tag) { const value=String(xml).match(new RegExp(`<[^>]*${tag}[^>]*>([^<]*)</[^>]*${tag}>`))?.[1] || ''; return value.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'"); }
async function issueServiceToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/dfp', aud: credentials.token_uri, iat: now, exp: now + 3600 })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const tokenResponse = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) });
  const body = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !body.access_token) throw new Error(`oauth_${tokenResponse.status}_${body.error || 'failed'}`);
  return body.access_token;
}
async function testSoapAccount(account) {
  const credentials = decryptCredential(account.credential_ciphertext);
  if (!credentials.client_email || !credentials.private_key) throw new Error('invalid_service_account_json');
  const version = /^v\d{6}$/.test(account.api_version) ? account.api_version : 'v202602';
  const token = await issueServiceToken(credentials);
  const endpoint = `https://ads.google.com/apis/ads/publisher/${version}/NetworkService`;
  const ns = `https://www.google.com/apis/ads/publisher/${version}`;
  const soap = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}"><soap:Header><tns:RequestHeader><tns:networkCode>${xmlEscape(account.network_code)}</tns:networkCode><tns:applicationName>AdX Control</tns:applicationName></tns:RequestHeader></soap:Header><soap:Body><tns:getCurrentNetwork/></soap:Body></soap:Envelope>`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', Authorization: `Bearer ${token}` }, body: soap });
  const text = await response.text();
  if (!response.ok || /<soap:Fault|<Fault/.test(text)) throw new Error(`soap_${response.status}_${soapText(text, 'faultstring') || soapText(text, 'ApiVersionError') || 'request_failed'}`);
  const network = { id: soapText(text, 'id'), displayName: soapText(text, 'displayName'), networkCode: soapText(text, 'networkCode'), currencyCode: soapText(text, 'currencyCode'), timeZone: soapText(text, 'timeZone') };
  if (!network.networkCode) throw new Error('soap_network_not_found');
  return { version, network };
}
function soapEnvelope(version, networkCode, body) { const ns=`https://www.google.com/apis/ads/publisher/${version}`; return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}"><soap:Header><tns:RequestHeader><tns:networkCode>${xmlEscape(networkCode)}</tns:networkCode><tns:applicationName>AdX Control</tns:applicationName></tns:RequestHeader></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`; }
async function soapRequest(account, service, body) { const credentials=decryptCredential(account.credential_ciphertext),version=account.api_version,token=await issueServiceToken(credentials),ns=`https://www.google.com/apis/ads/publisher/${version}`,response=await fetch(`https://ads.google.com/apis/ads/publisher/${version}/${service}`,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',Authorization:`Bearer ${token}`},body:soapEnvelope(version,account.network_code,body)}); const text=await response.text(); if(!response.ok||/<soap:Fault|<Fault/.test(text))throw new Error(`soap_${response.status}_${soapText(text,'faultstring')||'request_failed'}`); return {text,ns,version}; }
function dateXml(date) { const d=new Date(`${date}T00:00:00Z`); return `<tns:year>${d.getUTCFullYear()}</tns:year><tns:month>${d.getUTCMonth()+1}</tns:month><tns:day>${d.getUTCDate()}</tns:day>`; }
function csvRows(text) { const clean=text.replace(/^\uFEFF/,'').trim(); const lines=clean.split(/\r?\n/).filter(Boolean); if(lines.length<2)return []; const split=s=>{const delimiter=s.includes('\t')?'\t':','; return s.split(delimiter).map(v=>v.replace(/^"|"$/g,'').trim());}; const headerIndex=lines.findIndex(line=>{const headers=split(line).map(v=>v.toLowerCase()); return headers.some(v=>v.includes('date'))&&headers.some(v=>v.includes('ad exchange'));}); if(headerIndex<0)return []; const headers=split(lines[headerIndex]).map(v=>v.toLowerCase()); return lines.slice(headerIndex+1).map(line=>{const cells=split(line),row={}; headers.forEach((h,i)=>row[h]=cells[i]||''); return row}); }
function decodeReportBody(buffer) { let body=Buffer.from(buffer); if(body[0]===0x1f&&body[1]===0x8b) body=zlib.gunzipSync(body); if(body[0]===0x3c&&body.toString('utf8',0,200).toLowerCase().includes('<html')) throw new Error('report_download_html_error'); const text=body.toString('utf8'); if(!text.trim())throw new Error('report_download_empty'); return text; }
function reportProxyUrl() {
  const direct=String(process.env.ADX_REPORT_PROXY||'').trim();
  if (direct) return direct;
  const host=String(process.env.ADX_REPORT_PROXY_HOST||'').trim();
  if (!host) return '';
  const protocol=String(process.env.ADX_REPORT_PROXY_PROTOCOL||'socks5h').trim();
  const port=String(process.env.ADX_REPORT_PROXY_PORT||'1080').trim();
  const user=String(process.env.ADX_REPORT_PROXY_USER||'');
  const password=String(process.env.ADX_REPORT_PROXY_PASSWORD||'');
  return `${protocol}://${user?`${encodeURIComponent(user)}:${encodeURIComponent(password)}@`:''}${host}:${port}`;
}
async function downloadReport(url) { const proxy=reportProxyUrl(); if(!proxy){ const response=await fetch(url); if(!response.ok)throw new Error(`report_download_http_${response.status}`); return Buffer.from(await response.arrayBuffer()); } const parsed=new URL(proxy); if(!['socks5:','socks5h:'].includes(parsed.protocol))throw new Error('unsupported_report_proxy'); try { const {stdout}=await execFileAsync('curl',['-fsSL','--compressed','--max-time','180','--socks5-hostname',`${parsed.hostname}:${parsed.port||1080}`,...(parsed.username?[ '--proxy-user',`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`]:[]),url],{encoding:'buffer',maxBuffer:100*1024*1024}); return Buffer.from(stdout); } catch { throw new Error('report_download_proxy_failed'); } }
function reportValue(row, names) { const key=Object.keys(row).find(k=>names.some(n=>k.includes(n))); return key===undefined?'':row[key]; }
function reportDateValue(value) { const raw=String(value||'').trim(); if(/^\d{4}-\d{2}-\d{2}/.test(raw))return raw.slice(0,10); const match=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if(!match)return raw.slice(0,10); const year=match[3].length===2?`20${match[3]}`:match[3]; return `${year}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`; }
function domainFromAdUnit(value) { const raw=String(value||''); const labelled=raw.match(/(?:^|[_-])lb-((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i); if(labelled)return normalizedDomain(labelled[1]); const match=raw.match(/(?:^|[-_])((?:[a-z0-9](?:[a-z0-9-]*\.)+)[a-z]{2,})(?=$|[-_])/i); return match?normalizedDomain(match[1]):''; }
function parseReportRows(rows, channelId, sourceFile, accountKey='') { return rows.map(row=>{ const date=reportDateValue(reportValue(row,['date'])),hour=Number(reportValue(row,['hour'])); const revenueKey=Object.keys(row).find(k=>['ad_exchange_line_item_level_revenue','ad exchange line item level revenue','ad_exchange_revenue','revenue'].some(n=>k.includes(n)))||''; const revenueRaw=String(revenueKey?row[revenueKey]:''); const numericRevenue=Number(revenueRaw.replace(/[^0-9.-]/g,'')); const amount=Number.isFinite(numericRevenue)?(/micro/i.test(revenueKey)?numericRevenue/1000000:numericRevenue):0; const adUnit=reportValue(row,['ad_unit_name','ad unit']); const reportUrl=String(reportValue(row,['site','url'])||'').trim(); const url=reportUrl||domainFromAdUnit(adUnit); return {channelId,reportDate:date,hour:Number.isInteger(hour)?hour:-1,url,domain:normalizedDomain(url),account:String(accountKey),adUnit,country:reportValue(row,['country_code','country']),requests:Number(reportValue(row,['ad_exchange_total_requests','ad exchange ad requests','total_ad_requests','total_requests'])||0),matched:Number(reportValue(row,['ad_exchange_responses_served','ad exchange responses served','matched_requests','responses_served'])||0),impressions:Number(reportValue(row,['ad_exchange_line_item_level_impressions','ad exchange line item level impressions','ad_exchange_impressions','ad exchange impressions'])||0),clicks:Number(reportValue(row,['ad_exchange_line_item_level_clicks','ad exchange line item level clicks','ad_exchange_clicks','clicks'])||0),revenue:amount,sourceFile,rawJson:JSON.stringify(row)}; }).filter(x=>validDate(x.reportDate)&&[x.requests,x.matched,x.impressions,x.clicks,x.revenue].every(Number.isFinite)); }
async function syncSoapAccount(account) {
  const channel=db.prepare("SELECT id FROM channels WHERE status='active' ORDER BY id LIMIT 1").get();
  if(!channel) throw new Error('no_active_channel');
  const historyStart=validDate(process.env.ADX_HISTORY_START_DATE)?process.env.ADX_HISTORY_START_DATE:'';
  const end=historyStart?new Date(`${new Date(Date.now()-86400000).toISOString().slice(0,10)}T23:00:00Z`):new Date(Date.now()-60*60*1000);
  const start=historyStart?new Date(`${historyStart}T00:00:00Z`):new Date(end.getTime()-60*60*1000);
  const date=start.toISOString().slice(0,10),endDate=end.toISOString().slice(0,10),hour=historyStart?-1:start.getUTCHours();
  const run=db.prepare('INSERT INTO soap_sync_runs(soap_account_id,channel_id,window_start,window_end,status) VALUES(?,?,?,?,?)').run(account.id,channel.id,start.toISOString(),end.toISOString(),'running');
  const runId=Number(run.lastInsertRowid);
  try {
    const v=account.api_version;
    const query=`<tns:runReportJob><tns:reportJob><tns:reportQuery><tns:dimensions>DATE</tns:dimensions><tns:dimensions>HOUR</tns:dimensions><tns:dimensions>SITE</tns:dimensions><tns:dimensions>COUNTRY_CODE</tns:dimensions><tns:dimensions>AD_UNIT_NAME</tns:dimensions><tns:dimensions>AD_UNIT_ID</tns:dimensions><tns:columns>AD_EXCHANGE_TOTAL_REQUESTS</tns:columns><tns:columns>AD_EXCHANGE_RESPONSES_SERVED</tns:columns><tns:columns>AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS</tns:columns><tns:columns>AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS</tns:columns><tns:columns>AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE</tns:columns><tns:columns>AD_EXCHANGE_LINE_ITEM_LEVEL_AVERAGE_ECPM</tns:columns><tns:startDate>${dateXml(date)}</tns:startDate><tns:endDate>${dateXml(endDate)}</tns:endDate><tns:dateRangeType>CUSTOM_DATE</tns:dateRangeType><tns:reportCurrency>USD</tns:reportCurrency><tns:timeZoneType>PUBLISHER</tns:timeZoneType></tns:reportQuery></tns:reportJob></tns:runReportJob>`;
    const result=await soapRequest(account,'ReportService',query),jobId=soapText(result.text,'id');
    if(!jobId) throw new Error('report_job_id_missing');
    let status='IN_PROGRESS';
    for(let i=0;i<40&&status==='IN_PROGRESS';i++){ await new Promise(r=>setTimeout(r,1500)); const s=await soapRequest(account,'ReportService',`<tns:getReportJobStatus><tns:reportJobId>${jobId}</tns:reportJobId></tns:getReportJobStatus>`); status=soapText(s.text,'rval'); }
    if(status!=='COMPLETED') throw new Error(`report_status_${status}`);
    const d=await soapRequest(account,'ReportService',`<tns:getReportDownloadURL><tns:reportJobId>${jobId}</tns:reportJobId><tns:exportFormat>TSV</tns:exportFormat></tns:getReportDownloadURL>`),url=soapText(d.text,'rval');
    if(!url) throw new Error('report_download_url_missing');
    const file=decodeReportBody(await downloadReport(url)),rows=csvRows(file); if(!rows.length) throw new Error(`report_rows_unrecognized:${Buffer.from(file.slice(0,300)).toString('base64')}`); const upstream=db.prepare("SELECT account_key FROM upstream_accounts WHERE soap_account_id=? AND status='active' ORDER BY id LIMIT 1").get(account.id); const facts=parseReportRows(rows,channel.id,`soap:${account.network_code}:${date}_${endDate}`,upstream?.account_key||account.network_code);
    const insert=db.prepare(`INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP`);
    transaction(()=>facts.forEach(f=>insert.run(f.channelId,f.reportDate,f.hour,f.url,f.domain,f.account,f.adUnit,f.country,f.requests,f.matched,f.impressions,f.clicks,f.revenue,f.sourceFile,f.rawJson)));
    db.prepare('UPDATE soap_sync_runs SET status=\'success\',rows_read=?,rows_written=?,finished_at=CURRENT_TIMESTAMP WHERE id=?').run(rows.length,facts.length,runId);
    return {runId,rows:facts.length,date,endDate,hour};
  } catch(error) { db.prepare('UPDATE soap_sync_runs SET status=\'failed\',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?').run(String(error.message).slice(0,1000),runId); throw error; }
}

const adminEmail = normalizeEmail(process.env.ADX_ADMIN_EMAIL);
const adminPassword = String(process.env.ADX_ADMIN_PASSWORD || '');
if (production && (!adminEmail || adminPassword.length < 12 || /replace|change|example\.com/i.test(adminPassword))) throw new Error('production_admin_credentials_required');
if (adminEmail && adminPassword.length >= 10 && !db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) {
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
function upstreamShareSql(alias = 'revenue_facts') { return `COALESCE((SELECT u.share_percent FROM upstream_accounts u WHERE u.account_key=${alias}.account AND u.status='active' LIMIT 1),100)`; }
function channelRuleShareSql(alias = 'revenue_facts') {
  const fallback = effectiveShareSql(alias);
  const domain = mappedDomainSql(alias);
  return `COALESCE((SELECT r.share_percent FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id WHERE r.channel_id=${alias}.channel_id AND lower(u.account_key)=lower(${alias}.account) AND (r.domain='' OR lower(r.domain)=lower(${domain})) AND r.effective_from<=${alias}.report_date ORDER BY CASE WHEN r.domain='' THEN 1 ELSE 0 END,r.effective_from DESC,r.id DESC LIMIT 1),(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=${alias}.channel_id AND r.scope_type='ad_unit' AND lower(r.scope_value)=lower(${alias}.ad_unit) AND r.effective_from<=${alias}.report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1),(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=${alias}.channel_id AND r.scope_type='account' AND lower(r.scope_value)=lower(${alias}.account) AND r.effective_from<=${alias}.report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1),${fallback})`;
}
function settledRevenueSql(alias = 'revenue_facts') { return `(${alias}.revenue*(${upstreamShareSql(alias)}/100.0)*(${channelRuleShareSql(alias)}/100.0))`; }
function mappedDomainSql(alias = 'revenue_facts') { return `COALESCE((SELECT m.domain FROM ad_unit_domains m WHERE lower(m.ad_unit)=lower(${alias}.ad_unit) LIMIT 1),${alias}.domain)`; }

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
app.get('/api/admin/ad-units', requireAuth, requireAdmin, (_req,res) => res.json({ok:true,items:db.prepare('SELECT id,code,name,subdomain,inventory_type inventoryType,size,description,adsense_enabled adsenseEnabled,placement,target_window targetWindow,label,status,provider_id providerId,created_at createdAt FROM managed_ad_units ORDER BY id DESC LIMIT 1000').all()}));

app.get('/api/admin/soap-accounts', requireAuth, requireAdmin, (_req, res) => res.json({ ok: true, items: db.prepare(`SELECT id,name,network_code networkCode,api_version apiVersion,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary,created_at createdAt FROM soap_accounts ORDER BY id DESC`).all() }));
app.post('/api/admin/soap-accounts', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim(), networkCode = String(req.body?.networkCode || '').trim(), apiVersion = String(req.body?.apiVersion || 'v202602').trim();
  const credentials = req.body?.credentials;
  if (!name || !/^\d{6,}$/.test(networkCode) || !/^v\d{6}$/.test(apiVersion) || !credentials || typeof credentials !== 'object') return res.status(400).json({ ok: false, error: 'invalid_soap_account' });
  if (!credentials.client_email || !credentials.private_key) return res.status(400).json({ ok: false, error: 'invalid_service_account_json' });
  try {
    const result = db.prepare(`INSERT INTO soap_accounts(name,network_code,credential_ciphertext,api_version,created_by) VALUES(?,?,?,?,?) ON CONFLICT(network_code) DO UPDATE SET name=excluded.name,credential_ciphertext=excluded.credential_ciphertext,api_version=excluded.api_version,updated_at=CURRENT_TIMESTAMP`).run(name, networkCode, encryptCredential(credentials), apiVersion, req.user.email);
    audit(req.user.email, 'soap_account.save', 'soap_account', result.lastInsertRowid || db.prepare('SELECT id FROM soap_accounts WHERE network_code=?').get(networkCode).id, JSON.stringify({ name, networkCode, apiVersion }), req.ip);
    res.json({ ok: true, item: db.prepare(`SELECT id,name,network_code networkCode,api_version apiVersion,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary FROM soap_accounts WHERE network_code=?`).get(networkCode) });
  } catch (error) { res.status(409).json({ ok: false, error: 'soap_account_save_failed', detail: error.message }); }
});
app.post('/api/admin/soap-accounts/:id/test', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id), account = db.prepare('SELECT * FROM soap_accounts WHERE id=?').get(id);
  if (!account) return res.status(404).json({ ok: false, error: 'soap_account_not_found' });
  try {
    const result = await testSoapAccount(account);
    db.prepare(`UPDATE soap_accounts SET api_version=?,status='active',last_test_at=CURRENT_TIMESTAMP,last_test_status='success',last_test_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(result.version, `连接成功：${result.network.displayName || result.network.networkCode} / ${result.network.currencyCode || ''}`, id);
    audit(req.user.email, 'soap_account.test', 'soap_account', id, JSON.stringify({ status: 'success', version: result.version, network: result.network }), req.ip);
    res.json({ ok: true, status: 'success', version: result.version, network: result.network });
  } catch (error) {
    const summary = String(error.message || 'soap_test_failed').slice(0, 500);
    db.prepare(`UPDATE soap_accounts SET status='error',last_test_at=CURRENT_TIMESTAMP,last_test_status='failed',last_test_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(summary, id);
    audit(req.user.email, 'soap_account.test', 'soap_account', id, JSON.stringify({ status: 'failed', error: summary }), req.ip);
    res.status(502).json({ ok: false, error: 'soap_test_failed', detail: summary });
  }
});
app.get('/api/admin/soap-sync/runs', requireAuth, requireAdmin, (_req,res)=>res.json({ok:true,items:db.prepare('SELECT r.id,r.soap_account_id soapAccountId,s.name soapAccountName,r.window_start windowStart,r.window_end windowEnd,r.status,r.rows_read rowsRead,r.rows_written rowsWritten,r.error,r.started_at startedAt,r.finished_at finishedAt FROM soap_sync_runs r JOIN soap_accounts s ON s.id=r.soap_account_id ORDER BY r.id DESC LIMIT 100').all()}));
let syncRunning=false;
async function runHourlySoapSync(){ if(syncRunning)return; syncRunning=true; try { for(const account of db.prepare("SELECT * FROM soap_accounts WHERE status='active'").all()) { try { await syncSoapAccount(account); } catch(error) { console.error('soap_sync_failed',account.id,error.message); } } } finally { syncRunning=false; } }

app.get('/api/dashboard', requireAuth, (req, res) => {
  const scope = reportScope(req), { start, end } = range(req), where = whereScope(scope, start, end);
  const sums = db.prepare(`SELECT COALESCE(SUM(requests),0) requests,COALESCE(SUM(matched_requests),0) matched,COALESCE(SUM(impressions),0) impressions,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(revenue),0) revenue FROM revenue_facts WHERE ${where.sql}`).get(...where.params);
  const share = scope ? Number(db.prepare('SELECT share_percent FROM channels WHERE id=?').get(scope)?.share_percent || 0) : 100;
  const settled = settledRevenueSql('revenue_facts');
  const factor = req.user.role === 'channel' ? settled : 'revenue';
  const trend = db.prepare(`SELECT report_date date,ROUND(SUM(${factor}),6) revenue FROM revenue_facts WHERE ${where.sql} GROUP BY report_date ORDER BY report_date`).all(...where.params);
  const topUrls = db.prepare(`SELECT ${mappedDomainSql('revenue_facts')} url,ROUND(SUM(${factor}),6) revenue FROM revenue_facts WHERE ${where.sql} GROUP BY ${mappedDomainSql('revenue_facts')} ORDER BY revenue DESC LIMIT 10`).all(...where.params);
  const lastSync = db.prepare('SELECT created_at FROM import_runs ORDER BY id DESC LIMIT 1').get()?.created_at || null;
  const settledWhere = where.sql.replaceAll('report_date', 'rf.report_date').replaceAll('channel_id', 'rf.channel_id');
  const settledRevenue = db.prepare(`SELECT COALESCE(SUM(${settledRevenueSql('rf')}),0) value FROM revenue_facts rf WHERE ${settledWhere}`).get(...where.params).value;
  res.json({ ok: true, summary: { ...sums, revenue: req.user.role === 'channel' ? settledRevenue : sums.revenue, channelRevenue: settledRevenue, matchRate: sums.requests ? sums.matched * 100 / sums.requests : 0 }, trend, topUrls, lastSync });
});

const dimensionMap = { date: 'report_date', url: 'url', account: 'account', adUnit: 'ad_unit', hour: 'hour', country: 'country' };
app.get('/api/reports', requireAuth, (req, res) => {
  const requested = String(req.query.dimensions || 'date,url').split(',').filter(v => dimensionMap[v]);
  const dimensions = requested.length ? requested : ['date'];
  const scope = reportScope(req), { start, end } = range(req), where = whereScope(scope, start, end);
  const filters = [], filterParams = [];
  if (req.user.role === 'admin' && Number(req.query.channelId)) { filters.push('channel_id=?'); filterParams.push(Number(req.query.channelId)); }
  if (String(req.query.upstreamAccount || '').trim()) { filters.push('lower(account)=lower(?)'); filterParams.push(String(req.query.upstreamAccount).trim()); }
  if (String(req.query.account || '').trim()) { filters.push('lower(account)=lower(?)'); filterParams.push(String(req.query.account).trim()); }
  if (String(req.query.adUnit || '').trim()) { filters.push('lower(ad_unit)=lower(?)'); filterParams.push(String(req.query.adUnit).trim()); }
  if (String(req.query.domain || '').trim()) { filters.push(`lower(${mappedDomainSql('revenue_facts')})=lower(?)`); filterParams.push(normalizedDomain(req.query.domain)); }
  if (filters.length) { where.sql += ` AND ${filters.join(' AND ')}`; where.params.push(...filterParams); }
  const select = dimensions.map(v => v === 'url' ? `${mappedDomainSql('revenue_facts')} AS url` : `${dimensionMap[v]} AS ${v}`).join(',');
  const group = dimensions.map(v => v === 'url' ? mappedDomainSql('revenue_facts') : dimensionMap[v]).join(',');
  const settled = settledRevenueSql('revenue_facts');
  const rows = db.prepare(`SELECT ${select},SUM(requests) requests,SUM(matched_requests) matchedRequests,SUM(impressions) impressions,SUM(clicks) clicks,ROUND(SUM(revenue),6) revenue,ROUND(SUM(revenue*${upstreamShareSql('revenue_facts')}/100.0),6) upstreamRevenue,ROUND(SUM(${settled}),6) settledRevenue,ROUND(AVG(${upstreamShareSql('revenue_facts')}),2) upstreamSharePercent,ROUND(AVG(${channelRuleShareSql('revenue_facts')}),2) channelSharePercent FROM revenue_facts WHERE ${where.sql} GROUP BY ${group} ORDER BY report_date DESC,revenue DESC LIMIT 5000`).all(...where.params);
  const share = scope ? Number(db.prepare('SELECT share_percent FROM channels WHERE id=?').get(scope)?.share_percent || 0) : 100;
  res.json({ ok: true, items: rows.map(r => { const settled=scope?r.settledRevenue:r.settledRevenue; const visibleRevenue=req.user.role==='channel'?settled:r.revenue; const {settledRevenue:_,...publicRow}=r; const info=domainInfo(r.url||domainFromAdUnit(r.adUnit)); return { ...publicRow, url:publicRow.url||info.domain, mainDomain:info.mainDomain, domainType:info.domainType, revenue:visibleRevenue, ecpm:r.impressions?Number((visibleRevenue*1000/r.impressions).toFixed(6)):0, upstreamRevenue:req.user.role==='channel'?undefined:r.upstreamRevenue, channelRevenue:settled, matchRate:r.requests?r.matchedRequests*100/r.requests:0 }; }) });
});

app.get('/api/admin/upstream-accounts', requireAuth, requireAdmin, (_req,res) => res.json({ ok:true, items:db.prepare('SELECT u.id,u.account_key accountKey,u.name,u.soap_account_id soapAccountId,s.name soapAccountName,s.network_code networkCode,u.share_percent sharePercent,u.status,u.created_at createdAt,u.updated_at updatedAt FROM upstream_accounts u LEFT JOIN soap_accounts s ON s.id=u.soap_account_id ORDER BY u.account_key').all() }));
app.post('/api/admin/upstream-accounts', requireAuth, requireAdmin, (req,res) => {
  const accountKey=String(req.body?.accountKey||'').trim(), name=String(req.body?.name||accountKey).trim(), share=Number(req.body?.sharePercent), soapAccountId=Number(req.body?.soapAccountId)||null;
  if(!accountKey||!name||!Number.isFinite(share)||share<0||share>100||(soapAccountId&&!db.prepare('SELECT id FROM soap_accounts WHERE id=?').get(soapAccountId)))return res.status(400).json({ok:false,error:'invalid_upstream_account'});
  try { const r=db.prepare('INSERT INTO upstream_accounts(account_key,name,soap_account_id,share_percent,status) VALUES(?,?,?,?,?)').run(accountKey,name,soapAccountId,share,'active'); audit(req.user.email,'upstream_account.create','upstream_account',r.lastInsertRowid,JSON.stringify({accountKey,name,soapAccountId,share}),req.ip); res.status(201).json({ok:true,item:db.prepare('SELECT id,account_key accountKey,name,soap_account_id soapAccountId,share_percent sharePercent,status FROM upstream_accounts WHERE id=?').get(r.lastInsertRowid)}); } catch { res.status(409).json({ok:false,error:'account_exists'}); }
});
app.put('/api/admin/upstream-accounts/:id', requireAuth, requireAdmin, (req,res) => {
  const id=Number(req.params.id), name=String(req.body?.name||'').trim(), share=Number(req.body?.sharePercent), status=req.body?.status==='disabled'?'disabled':'active';
  if(!Number.isSafeInteger(id)||!name||!Number.isFinite(share)||share<0||share>100)return res.status(400).json({ok:false,error:'invalid_upstream_account'});
  const before=db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(id); if(!before)return res.status(404).json({ok:false,error:'upstream_account_not_found'});
  db.prepare('UPDATE upstream_accounts SET name=?,share_percent=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,share,status,id); const after=db.prepare('SELECT id,account_key accountKey,name,share_percent sharePercent,status FROM upstream_accounts WHERE id=?').get(id); audit(req.user.email,'upstream_account.update','upstream_account',id,JSON.stringify({before,after}),req.ip); res.json({ok:true,item:after});
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
  adUnit: { aliases: ['ad_unit','adunit','unit','广告单元','ad_unit_name','ad_unit_id','dimension_ad_unit_name','dimension_ad_unit_id'] },
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
  const fact={channelId,reportDate,hour:hourValue===undefined?-1:Number(hourValue),url,domain:normalizedDomain(url),account:String(pick(row,'account')||''),adUnit:String(pick(row,'adUnit')||''),country:String(pick(row,'country')||''),requests:Number(pick(row,'requests')||0),matched:Number(pick(row,'matched')||0),impressions:Number(pick(row,'impressions')||0),clicks:Number(pick(row,'clicks')||0),revenue:Number(revenueValue),sourceFile,rawJson:JSON.stringify(row)};
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
  if(!db.prepare('SELECT id FROM channels WHERE id=?').get(channelId)||!rows?.length||rows.length>200000)return res.status(400).json({ok:false,error:'invalid_import'});
  const normalized=rows.map(row=>normalizeFact(row,channelId,fileName)), valid=normalized.filter(x=>x.valid), rejected=normalized.length-valid.length;
  if(!valid.length)return res.status(422).json({ok:false,error:'no_valid_rows'});
  const upsert=db.prepare(`INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP`);
  const runId=transaction(()=>{for(const {fact:f} of valid)upsert.run(f.channelId,f.reportDate,f.hour,f.url,f.domain,f.account,f.adUnit,f.country,f.requests,f.matched,f.impressions,f.clicks,f.revenue,f.sourceFile,f.rawJson);const run=db.prepare('INSERT INTO import_runs(actor_email,channel_id,source_file,total_rows,accepted_rows,rejected_rows,status,error_summary) VALUES(?,?,?,?,?,?,?,?)').run(req.user.email,channelId,fileName,rows.length,valid.length,rejected,rejected?'partial':'success',rejected?`${rejected} rows rejected`:'');return Number(run.lastInsertRowid)});
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

const dist=path.join(root,'dist'); app.use(express.static(dist,{index:false,maxAge:'1h'}));
app.all('/api/{*path}',(_req,res)=>res.status(404).json({ok:false,error:'not_found'}));
app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
app.use((error,_req,res,_next)=>{console.error('request_failed',error.message);res.status(500).json({ok:false,error:'internal_error'})});
app.listen(port,process.env.HOST||'127.0.0.1',()=>{ console.log(`adx-channel-platform listening on ${port}`); setInterval(runHourlySoapSync,60*60*1000); if(process.env.ADX_SYNC_ON_START==='true')runHourlySoapSync(); });
