package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	root := t.TempDir()
	t.Setenv("ADX_DB_PATH", filepath.Join(root, "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "admin@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "test-password-123")
	t.Setenv("NODE_ENV", "")
	t.Setenv("ADX_ENV", "")
	a, err := newApp(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.reportCache.close(); a.db.Close() })
	return a
}

func TestImportAndDashboard(t *testing.T) {
	a := testApp(t)
	for _, query := range []string{"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',75)", "INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,75,'1900-01-01','test')"} {
		if _, err := a.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,datetime('now','+1 day'))", sha256Hex("test-session")); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"channelId": 1, "fileName": "fixture.json", "payload": []any{map[string]any{"date": "2026-11-01", "url": "https://example.test/page", "ad_unit": "unit", "requests": 10, "impressions": 8, "revenue": 2.5}}}
	data, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/imports", strings.NewReader(string(data)))
	request.Header.Set("Authorization", "Bearer test-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("import status=%d body=%s", response.Code, response.Body.String())
	}
	var outcome map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &outcome); err != nil {
		t.Fatal(err)
	}
	if outcome["accepted"] != float64(1) {
		t.Fatalf("outcome=%v", outcome)
	}
	dashboard := httptest.NewRequest(http.MethodGet, "/api/dashboard?start=2026-11-01&end=2026-11-01", nil)
	dashboard.Header.Set("Authorization", "Bearer test-session")
	result := httptest.NewRecorder()
	a.routes().ServeHTTP(result, dashboard)
	if result.Code != 200 {
		t.Fatalf("dashboard=%d %s", result.Code, result.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(result.Body.Bytes(), &body)
	if body["summary"].(map[string]any)["revenue"] != 2.5 {
		t.Fatalf("dashboard=%v", body)
	}
}

func TestMockGamSyncWritesFactsAndRun(t *testing.T) {
	a := testApp(t)
	statements := []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',75)",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,75,'1900-01-01','test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,rest_report_name,rest_channel_id,rest_upstream_account_id,rest_money_divisor,rest_sync_enabled,rest_network_timezone,created_by) VALUES(1,'Test','123456','test-cipher','active','networks/123456/reports/11',1,1,1000000,1,'UTC','test')",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id,share_percent) VALUES(1,'upstream','Upstream',1,100)",
		"INSERT INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')",
	}
	for _, statement := range statements {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	a.gamTokens[1] = &gamTokenEntry{cipher: "test-cipher", token: "test-token", expires: time.Now().Add(time.Hour)}
	date := map[string]any{"year": 2026, "month": 11, "day": 1}
	definition := map[string]any{"dimensions": gamReportDimensions, "metrics": gamReportMetrics, "timeZoneSource": "PUBLISHER", "currencyCode": "USD", "reportType": "HISTORICAL", "dateRange": map[string]any{"fixed": map[string]any{"startDate": date, "endDate": date}}}
	report := map[string]any{"name": "networks/123456/reports/11", "reportDefinition": definition}
	row := map[string]any{"dimensionValues": []any{map[string]any{"stringValue": "20261101"}, map[string]any{"intValue": "13"}, map[string]any{"stringValue": "https://example.test"}, map[string]any{"stringValue": "US"}, map[string]any{"stringValue": "unit"}, map[string]any{"stringValue": "42"}}, "metricValueGroups": []any{map[string]any{"primaryValues": []any{map[string]any{"intValue": "10"}, map[string]any{"intValue": "9"}, map[string]any{"intValue": "8"}, map[string]any{"intValue": "1"}, map[string]any{"doubleValue": 1250000.0}}}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected token")
		}
		var value any
		switch r.URL.Path {
		case "/v1/networks/123456/reports/11":
			value = report
		case "/v1/networks/123456/reports/11:run":
			value = map[string]any{"name": "networks/123456/operations/reports/runs/99", "done": true, "response": map[string]any{"reportResult": "networks/123456/reports/11/results/22"}}
		case "/v1/networks/123456/reports/11/results/22:fetchRows":
			value = map[string]any{"dateRanges": []any{map[string]any{"startDate": date, "endDate": date}}, "rows": []any{row}}
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	a.gamClient = server.Client()
	a.gamAPIBase = server.URL + "/v1/"
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	result, err := a.executeGam(context.Background(), account, "2026-11-01", "2026-11-01", true)
	if err != nil {
		t.Fatal(err)
	}
	if result["rows"] != 1 || result["revenue"] != 1.25 {
		t.Fatalf("result=%v", result)
	}
	var revenue float64
	var source string
	err = a.db.QueryRow("SELECT revenue,source_file FROM revenue_facts LIMIT 1").Scan(&revenue, &source)
	if err != nil || revenue != 1.25 || source != "gam-rest:123456:2026-11-01_2026-11-01" {
		t.Fatalf("fact revenue=%v source=%v err=%v", revenue, source, err)
	}
	if !a.exists("SELECT id FROM soap_sync_runs WHERE status='success' AND rows_written=1") {
		t.Fatal("missing successful sync run")
	}
}
