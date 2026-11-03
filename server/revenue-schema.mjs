// Existing rows have no reliable Google ad unit ID to backfill. Rebuild the
// business key once so identically named units can coexist after REST upgrades.
export function ensureAdUnitIdDimension(db) {
  if (db.prepare("SELECT 1 FROM pragma_table_info('revenue_facts') WHERE name='ad_unit_id'").get()) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec("CREATE TABLE revenue_facts_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER, url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', ad_unit_id TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, raw_json TEXT NOT NULL DEFAULT '{}', UNIQUE(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE)");
    db.exec("INSERT INTO revenue_facts_v2 (id,channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,imported_at,raw_json) SELECT id,channel_id,report_date,hour,url,domain,account,ad_unit,'',country,requests,matched_requests,impressions,clicks,revenue,source_file,imported_at,raw_json FROM revenue_facts");
    db.exec('DROP TABLE revenue_facts');
    db.exec('ALTER TABLE revenue_facts_v2 RENAME TO revenue_facts');
    db.exec('CREATE INDEX idx_revenue_scope_date ON revenue_facts(channel_id, report_date)');
    db.exec('CREATE INDEX idx_revenue_dashboard ON revenue_facts(report_date, channel_id, account, ad_unit, domain, revenue, requests, matched_requests, impressions, clicks)');
    db.exec('CREATE INDEX idx_revenue_domain ON revenue_facts(domain, report_date)');
    db.exec('CREATE INDEX idx_revenue_account_unit ON revenue_facts(account, ad_unit, report_date)');
    db.exec('CREATE INDEX idx_revenue_ad_unit_id ON revenue_facts(ad_unit_id, report_date)');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
