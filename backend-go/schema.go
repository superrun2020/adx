package main

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"strings"
)

//go:embed schema.sql
var schemaFS embed.FS

func (a *app) hasColumn(table, column string) bool {
	rows, err := queryMaps(a.db, "SELECT name FROM pragma_table_info(?) WHERE name=?", table, column)
	return err == nil && len(rows) > 0
}
func (a *app) ensureColumn(table, column, definition string) error {
	if a.hasColumn(table, column) {
		return nil
	}
	_, err := a.db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
	return err
}
func (a *app) migrateAdUnitID() error {
	if a.hasColumn("revenue_facts", "ad_unit_id") {
		return nil
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		"CREATE TABLE revenue_facts_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, report_date TEXT NOT NULL, hour INTEGER, url TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ad_unit TEXT NOT NULL DEFAULT '', ad_unit_id TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, matched_requests INTEGER NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, raw_json TEXT NOT NULL DEFAULT '{}', UNIQUE(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country), FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE)",
		"INSERT INTO revenue_facts_v2 (id,channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,imported_at,raw_json) SELECT id,channel_id,report_date,hour,url,domain,account,ad_unit,'',country,requests,matched_requests,impressions,clicks,revenue,source_file,imported_at,raw_json FROM revenue_facts",
		"DROP TABLE revenue_facts",
		"ALTER TABLE revenue_facts_v2 RENAME TO revenue_facts",
	}
	for _, statement := range statements {
		if _, err = tx.Exec(statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (a *app) ensureSchema() error {
	script, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		return err
	}
	parts := strings.SplitN(string(script), "CREATE INDEX IF NOT EXISTS", 2)
	if len(parts) != 2 {
		return errors.New("invalid_schema_sql")
	}
	if _, err = a.db.Exec(parts[0]); err != nil {
		return fmt.Errorf("schema_tables: %w", err)
	}
	for _, item := range []struct{ table, column, definition string }{
		{"channels", "api_secret_ciphertext", "TEXT"},
		{"managed_ad_units", "description", "TEXT NOT NULL DEFAULT ''"}, {"managed_ad_units", "adsense_enabled", "INTEGER NOT NULL DEFAULT 0"}, {"managed_ad_units", "placement", "TEXT NOT NULL DEFAULT ''"}, {"managed_ad_units", "target_window", "TEXT NOT NULL DEFAULT ''"}, {"managed_ad_units", "label", "TEXT NOT NULL DEFAULT ''"},
		{"managed_ad_units", "gam_network_code", "TEXT"}, {"managed_ad_units", "gam_parent_ad_unit", "TEXT"}, {"managed_ad_units", "publish_error", "TEXT NOT NULL DEFAULT ''"}, {"managed_ad_units", "published_at", "TEXT"},
		{"soap_accounts", "rest_report_name", "TEXT NOT NULL DEFAULT ''"}, {"soap_accounts", "rest_channel_id", "INTEGER"}, {"soap_accounts", "rest_upstream_account_id", "INTEGER"}, {"soap_accounts", "rest_money_divisor", "INTEGER"}, {"soap_accounts", "rest_sync_enabled", "INTEGER NOT NULL DEFAULT 0"}, {"soap_accounts", "rest_last_preview_at", "TEXT"}, {"soap_accounts", "rest_last_preview_rows", "INTEGER NOT NULL DEFAULT 0"}, {"soap_accounts", "rest_network_timezone", "TEXT NOT NULL DEFAULT ''"},
		{"soap_accounts", "account_email", "TEXT NOT NULL DEFAULT ''"}, {"soap_accounts", "advertiser", "TEXT NOT NULL DEFAULT ''"}, {"soap_accounts", "bd", "TEXT NOT NULL DEFAULT ''"}, {"soap_accounts", "advertiser_share_percent", "REAL NOT NULL DEFAULT 0"}, {"soap_accounts", "operation_status", "TEXT NOT NULL DEFAULT 'unknown'"}, {"soap_accounts", "enabled", "INTEGER NOT NULL DEFAULT 1"}, {"soap_accounts", "notes", "TEXT NOT NULL DEFAULT ''"},
		{"upstream_accounts", "soap_account_id", "INTEGER"}, {"upstream_accounts", "advertiser", "TEXT NOT NULL DEFAULT ''"}, {"upstream_accounts", "bd", "TEXT NOT NULL DEFAULT ''"},
		{"revenue_facts", "raw_json", "TEXT NOT NULL DEFAULT '{}'"},
		{"soap_sync_runs", "stage", "TEXT NOT NULL DEFAULT ''"}, {"soap_sync_runs", "timings_json", "TEXT NOT NULL DEFAULT '{}'"},
		{"users", "is_super_admin", "INTEGER NOT NULL DEFAULT 0"}, {"users", "sidebar_permissions", "TEXT"},
		{"regression_events", "drop_start_date", "TEXT"},
		{"regression_events", "send_attempts", "INTEGER NOT NULL DEFAULT 0"}, {"regression_events", "last_attempt_at", "TEXT"},
	} {
		if err = a.ensureColumn(item.table, item.column, item.definition); err != nil {
			return fmt.Errorf("schema_column_%s_%s: %w", item.table, item.column, err)
		}
	}
	if err = a.migrateAdUnitID(); err != nil {
		return fmt.Errorf("schema_revenue: %w", err)
	}
	if _, err = a.db.Exec("CREATE INDEX IF NOT EXISTS" + parts[1]); err != nil {
		return fmt.Errorf("schema_indexes: %w", err)
	}
	if _, err = a.db.Exec("INSERT OR IGNORE INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) SELECT id,share_percent,'1900-01-01','migration' FROM channels"); err != nil {
		return err
	}
	if _, err = a.db.Exec("INSERT OR IGNORE INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) SELECT id,100,'1900-01-01','migration' FROM upstream_accounts"); err != nil {
		return err
	}
	if _, err = a.db.Exec("INSERT OR IGNORE INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) SELECT id,share_percent,'2026-10-11','migration' FROM upstream_accounts"); err != nil {
		return err
	}
	if _, err = a.db.Exec("UPDATE users SET is_super_admin=1 WHERE id=(SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY CASE WHEN lower(email)='eddyappcone.kr@gmail.com' THEN 0 ELSE 1 END,id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND status='active' AND is_super_admin=1)"); err != nil {
		return err
	}
	return a.ensureAdmin()
}
func (a *app) ensureAdmin() error {
	var id int64
	err := a.db.QueryRow("SELECT id FROM users WHERE role='admin' AND status='active' LIMIT 1").Scan(&id)
	if err == nil {
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(os.Getenv("ADX_ADMIN_EMAIL")))
	password := os.Getenv("ADX_ADMIN_PASSWORD")
	min := 10
	if a.production {
		min = 12
	}
	valid := email != "" && len(password) >= min && !strings.Contains(strings.ToLower(password), "replace") && !strings.Contains(strings.ToLower(password), "change") && !strings.Contains(strings.ToLower(password), "example.com")
	if !valid {
		if a.production {
			return errors.New("production_admin_credentials_required")
		}
		return nil
	}
	hash, err := passwordHash(password)
	if err != nil {
		return err
	}
	_, err = a.db.Exec("INSERT INTO users(email,name,password_hash,role,status,is_super_admin) VALUES(?,?,?,'admin','active',1)", email, "平台管理员", hash)
	return err
}
