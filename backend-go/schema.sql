CREATE TABLE IF NOT EXISTS ad_unit_creation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, subdomains_json TEXT NOT NULL, inventory_types_json TEXT NOT NULL,
  sizes_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ad_unit_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ad_unit TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_domain_share_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, upstream_account_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
  domain TEXT NOT NULL COLLATE NOCASE, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(upstream_account_id,channel_id,domain,effective_from),
  FOREIGN KEY(upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_share_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('account','ad_unit')),
  scope_value TEXT NOT NULL COLLATE NOCASE, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id,scope_type,scope_value,effective_from), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_share_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100),
  effective_from TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id,effective_from), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  share_percent REAL NOT NULL DEFAULT 100 CHECK(share_percent BETWEEN 0 AND 100), status TEXT NOT NULL DEFAULT 'active', api_secret_ciphertext TEXT,
  api_secret_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dashboard_daily (report_date TEXT NOT NULL, channel_id INTEGER NOT NULL, domain TEXT NOT NULL, requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, revenue REAL NOT NULL, settled_revenue REAL NOT NULL, PRIMARY KEY(report_date,channel_id,domain)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dashboard_rest_daily (report_date TEXT NOT NULL, channel_id INTEGER NOT NULL, network_code TEXT NOT NULL, domain TEXT NOT NULL, requests INTEGER NOT NULL, matched_requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, revenue REAL NOT NULL, settled_revenue REAL NOT NULL, PRIMARY KEY(report_date,channel_id,network_code,domain)) WITHOUT ROWID;
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
CREATE TABLE IF NOT EXISTS link_metadata (
  network_code TEXT NOT NULL, domain TEXT NOT NULL COLLATE NOCASE, is_manual INTEGER NOT NULL DEFAULT 0,
  monitor_domains_json TEXT NOT NULL DEFAULT '[]', channel_id INTEGER, notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(network_code,domain), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT NOT NULL, channel_id INTEGER NOT NULL, source_file TEXT NOT NULL,
  total_rows INTEGER NOT NULL, accepted_rows INTEGER NOT NULL, rejected_rows INTEGER NOT NULL, status TEXT NOT NULL,
  error_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS managed_ad_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  subdomain TEXT NOT NULL, inventory_type TEXT NOT NULL, size TEXT NOT NULL, source_row_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','created','failed')), provider_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, description TEXT NOT NULL DEFAULT '', adsense_enabled INTEGER NOT NULL DEFAULT 0, placement TEXT NOT NULL DEFAULT '', target_window TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', gam_network_code TEXT, gam_parent_ad_unit TEXT, publish_error TEXT NOT NULL DEFAULT '', published_at TEXT);
CREATE TABLE IF NOT EXISTS report_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT 'account_reports_read',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS "revenue_facts" (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER, url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', ad_unit_id TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, raw_json TEXT NOT NULL DEFAULT '{}', UNIQUE(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS soap_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, network_code TEXT NOT NULL UNIQUE,
  credential_ciphertext TEXT NOT NULL, api_version TEXT NOT NULL DEFAULT 'v202602',
  account_email TEXT NOT NULL DEFAULT '', advertiser TEXT NOT NULL DEFAULT '', bd TEXT NOT NULL DEFAULT '',
  advertiser_share_percent REAL NOT NULL DEFAULT 0, operation_status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'untested', last_test_at TEXT, last_test_status TEXT,
  last_test_summary TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, rest_report_name TEXT NOT NULL DEFAULT '', rest_channel_id INTEGER, rest_upstream_account_id INTEGER, rest_money_divisor INTEGER, rest_sync_enabled INTEGER NOT NULL DEFAULT 0, rest_last_preview_at TEXT, rest_last_preview_rows INTEGER NOT NULL DEFAULT 0, rest_network_timezone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS soap_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, soap_account_id INTEGER NOT NULL, channel_id INTEGER,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, status TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, stage TEXT NOT NULL DEFAULT '', timings_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS upstream_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, soap_account_id INTEGER, share_percent REAL NOT NULL DEFAULT 100 CHECK(share_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, advertiser TEXT NOT NULL DEFAULT '', bd TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS upstream_share_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, upstream_account_id INTEGER NOT NULL, share_percent REAL NOT NULL CHECK(share_percent BETWEEN 0 AND 100), effective_from TEXT NOT NULL, created_by TEXT NOT NULL, UNIQUE(upstream_account_id,effective_from), FOREIGN KEY(upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','channel')), channel_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active', is_super_admin INTEGER NOT NULL DEFAULT 0, sidebar_permissions TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS regression_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), feishu_enabled INTEGER NOT NULL DEFAULT 0,
  min_revenue REAL NOT NULL DEFAULT 50, min_drop_percent REAL NOT NULL DEFAULT 2,
  webhook_ciphertext TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_report_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
  webhook_ciphertext TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_report_deliveries (
  report_date TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
  sent_at TEXT, error TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO bot_report_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS regression_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, soap_account_id INTEGER NOT NULL,
  cadence TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  baseline_start TEXT NOT NULL DEFAULT '', baseline_end TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS regression_snapshots (
  run_id INTEGER NOT NULL, domain TEXT NOT NULL, revenue REAL NOT NULL,
  requests INTEGER NOT NULL, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
  PRIMARY KEY(run_id,domain), FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS regression_daily_snapshots (
  run_id INTEGER NOT NULL, soap_account_id INTEGER NOT NULL, report_date TEXT NOT NULL,
  domain TEXT NOT NULL, revenue REAL NOT NULL, requests INTEGER NOT NULL,
  impressions INTEGER NOT NULL, clicks INTEGER NOT NULL,
  PRIMARY KEY(run_id,report_date,domain),
  FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS regression_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, soap_account_id INTEGER NOT NULL,
  cadence TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  domain TEXT NOT NULL, old_revenue REAL NOT NULL, new_revenue REAL NOT NULL,
  old_requests INTEGER NOT NULL, new_requests INTEGER NOT NULL,
  old_impressions INTEGER NOT NULL, new_impressions INTEGER NOT NULL,
  old_clicks INTEGER NOT NULL, new_clicks INTEGER NOT NULL,
  alert_status TEXT NOT NULL DEFAULT 'not_triggered', alert_error TEXT NOT NULL DEFAULT '',
  drop_start_date TEXT, send_attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
  notified_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES regression_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(soap_account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO regression_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS gam_diagnostic_reports (
  account_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('device','browser','demand')),
  network_code TEXT NOT NULL, report_name TEXT NOT NULL DEFAULT '', last_synced_at TEXT,
  last_attempt_at TEXT, last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(account_id,kind), FOREIGN KEY(account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gam_diagnostic_facts (
  account_id INTEGER NOT NULL, network_code TEXT NOT NULL, report_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('device','browser','demand')), category TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0,
  measurable_impressions INTEGER NOT NULL DEFAULT 0, viewable_impressions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,network_code,report_date,kind,category),
  FOREIGN KEY(account_id) REFERENCES soap_accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_gam_diagnostic_lookup ON gam_diagnostic_facts(report_date,kind,account_id);
CREATE INDEX IF NOT EXISTS idx_regression_runs_due ON regression_runs(soap_account_id,cadence,finished_at);
CREATE INDEX IF NOT EXISTS idx_regression_runs_retention ON regression_runs(cadence,finished_at);
CREATE INDEX IF NOT EXISTS idx_regression_events_filter ON regression_events(created_at,soap_account_id,cadence,domain);
CREATE INDEX IF NOT EXISTS idx_regression_daily_lookup ON regression_daily_snapshots(soap_account_id,report_date,domain,run_id DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_account_unit ON revenue_facts(account, ad_unit, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_ad_unit_id ON revenue_facts(ad_unit_id, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_dashboard ON revenue_facts(report_date, channel_id, account, ad_unit, domain, revenue, requests, matched_requests, impressions, clicks);
CREATE INDEX IF NOT EXISTS idx_revenue_domain ON revenue_facts(domain, report_date);
CREATE INDEX IF NOT EXISTS idx_revenue_source_domain ON revenue_facts(source_file, domain);
CREATE INDEX IF NOT EXISTS idx_revenue_scope_date ON revenue_facts(channel_id, report_date);
