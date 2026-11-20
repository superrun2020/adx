package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoverageSchemaUpgradePreservesExistingWebhookAndIncomeSwitch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := sql.Open(sqliteDriver, sqliteDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("CREATE TABLE regression_settings(id INTEGER PRIMARY KEY,feishu_enabled INTEGER NOT NULL DEFAULT 0,min_revenue REAL NOT NULL DEFAULT 50,min_drop_percent REAL NOT NULL DEFAULT 2,webhook_ciphertext TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO regression_settings(id,feishu_enabled,webhook_ciphertext) VALUES(1,0,'existing-cipher')")
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ADX_DB_PATH", path)
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	config, err := a.currentRegressionConfig()
	if err != nil || config.Enabled || !config.CoverageEnabled || config.MinCoverageDropPoints != 30 ||
		config.MinCoverageRequests != 100 || config.Ciphertext != "existing-cipher" {
		t.Fatalf("coverage schema upgrade config=%+v error=%v", config, err)
	}
}

func TestCoverageAlertUsesSameHourAndExcludesArchivedUnits(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email) VALUES(1,'Default','default@example.test'),(2,'Rinser','rinser@example.test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,status,rest_network_timezone,rest_channel_id,rest_upstream_account_id,rest_report_name,rest_money_divisor) VALUES(1,'GAM','123','test','admin','active','Asia/Singapore',1,1,'networks/123/reports/1',1)",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id,status) VALUES(1,'acct','Upstream',1,'active')",
		"INSERT INTO gam_domain_channel_assignments(root_domain,channel_id,effective_from,created_by) VALUES('example.test',2,'1900-01-01','test')",
		"INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,ip,created_at) VALUES('test','gam.ad_unit_archive','ad_unit','123','{\"names\":[\"networks/123/adUnits/200\"]}','','2026-11-20 03:00:00')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(2,'2026-11-19',11,'news.example.test','news.example.test','acct','unit-100','100',1000,990,'gam-rest:123:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(2,'2026-11-20',11,'news.example.test','news.example.test','acct','unit-100','100',2000,20,'gam-rest:123:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(1,'2026-11-19',11,'paused.test','paused.test','acct','unit-200','200',500,500,'gam-rest:123:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(1,'2026-11-20',11,'paused.test','paused.test','acct','unit-200','200',500,0,'gam-rest:123:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(1,'2026-11-19',11,'small.test','small.test','acct','unit-300','300',20,20,'gam-rest:123:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,source_file) VALUES(1,'2026-11-20',11,'small.test','small.test','acct','unit-300','300',20,0,'gam-rest:123:test')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	cipher, err := a.encryptCredential(map[string]any{"url": "https://open.feishu.cn/open-apis/bot/v2/hook/test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("UPDATE regression_settings SET feishu_enabled=0,coverage_feishu_enabled=1,webhook_ciphertext=? WHERE id=1", cipher); err != nil {
		t.Fatal(err)
	}
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 20, 4, 15, 0, 0, time.UTC)
	sends := 0
	sender := func(_ context.Context, _, _, message string) error {
		sends++
		if !strings.Contains(message, "news.example.test（渠道：Rinser）：99.00% → 1.00%") ||
			strings.Contains(message, "paused.test") || strings.Contains(message, "small.test") ||
			!strings.Contains(message, "数据：2026-11-20 11:00–11:59（Asia/Singapore；对比 2026-11-19 同小时）") {
			t.Errorf("unexpected message: %s", message)
		}
		if sends == 1 {
			return errors.New("temporary failure")
		}
		return nil
	}
	for _, instant := range []time.Time{now, now.Add(time.Minute), now.Add(16 * time.Minute), now.Add(17 * time.Minute)} {
		if err := a.runCoverageAlertsAt(context.Background(), account, instant, sender); err != nil {
			t.Fatal(err)
		}
	}
	if sends != 2 {
		t.Fatalf("sends=%d, want failed attempt and one retry", sends)
	}
	rows, err := queryMaps(a.db, "SELECT domain,status,attempts FROM coverage_alerts")
	if err != nil || len(rows) != 1 || rows[0]["domain"] != "news.example.test" || rows[0]["status"] != "sent" || numberValue(rows[0]["attempts"]) != 2 {
		t.Fatalf("alerts=%v error=%v", rows, err)
	}
	response := httptest.NewRecorder()
	a.coverageEvents(response, httptest.NewRequest("GET", "/api/admin/regression/coverage-events?accountId=1&domain=news.example.test", nil))
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 {
		t.Fatalf("coverage history status=%d body=%s error=%v", response.Code, response.Body.String(), err)
	}
	items := body["items"].([]any)
	if len(items) != 1 || numberValue(items[0].(map[string]any)["baselineCoverage"]) != 99 || numberValue(items[0].(map[string]any)["currentCoverage"]) != 1 {
		t.Fatalf("coverage history items=%v", items)
	}
}

func TestCoverageThresholdRequiresBothHoursAndPercentagePoints(t *testing.T) {
	settings := regressionConfig{MinCoverageDropPoints: 30, MinCoverageRequests: 100}
	for _, item := range []struct {
		Before, After coverageCount
		Qualified     bool
	}{
		{coverageCount{100, 99}, coverageCount{200, 2}, true},
		{coverageCount{99, 99}, coverageCount{200, 0}, false},
		{coverageCount{100, 99}, coverageCount{99, 0}, false},
		{coverageCount{100, 70}, coverageCount{200, 50}, true},
		{coverageCount{100, 70}, coverageCount{200, 100}, false},
	} {
		if coverageQualified(coveragePair{Before: item.Before, After: item.After}, settings) != item.Qualified {
			t.Fatalf("coverage pair=%+v", item)
		}
	}
}
