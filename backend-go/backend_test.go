package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestGamDatesUseEachNetworkTimezone(t *testing.T) {
	instant := time.Date(2026, 11, 4, 1, 30, 0, 0, time.UTC)
	for _, item := range []struct{ zone, today, yesterday string }{
		{"America/Los_Angeles", "2026-11-03", "2026-11-02"},
		{"Asia/Tokyo", "2026-11-04", "2026-11-03"},
	} {
		got, err := localGamDateAt(item.zone, instant, 0)
		if err != nil || got != item.today {
			t.Fatalf("%s today=%s err=%v", item.zone, got, err)
		}
		got, err = localGamDateAt(item.zone, instant, -1)
		if err != nil || got != item.yesterday {
			t.Fatalf("%s yesterday=%s err=%v", item.zone, got, err)
		}
	}
	if _, err := localGamDateAt("", instant, 0); err == nil {
		t.Fatal("missing network timezone must not silently use UTC")
	}
}

func TestFreshDatabaseAndRoutes(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "admin@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "test-password-123")
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	for _, table := range []string{"users", "revenue_facts", "soap_accounts", "gam_ad_unit_creations", "dashboard_daily"} {
		if !a.exists("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", table) {
			t.Fatalf("missing table %s", table)
		}
	}
	if !a.hasColumn("revenue_facts", "ad_unit_id") {
		t.Fatal("missing ad_unit_id")
	}
	if !a.exists("SELECT id FROM users WHERE email='admin@example.test' AND role='admin'") {
		t.Fatal("missing bootstrap admin")
	}
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/health", nil)
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatalf("health %d %s", response.Code, response.Body.String())
	}
}

func TestGamHTTPRetryAndNetworkGuard(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/networks/123456" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("request %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		if calls == 1 {
			w.WriteHeader(503)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "temporary"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "networks/123456"})
	}))
	defer server.Close()
	a := &app{gamClient: server.Client(), gamAPIBase: server.URL + "/v1/"}
	result, err := a.gamRequest(context.Background(), "123456", "test-token", "networks/123456", http.MethodGet, nil, nil)
	if err != nil || result["name"] != "networks/123456" || calls != 2 {
		t.Fatalf("result=%v err=%v calls=%d", result, err, calls)
	}
	_, err = a.gamRequest(context.Background(), "123456", "test-token", "networks/999999", http.MethodGet, nil, nil)
	if err == nil || err.Error() != "invalid_gam_resource" {
		t.Fatalf("unexpected guard error: %v", err)
	}
}

func TestRestReportRowNormalization(t *testing.T) {
	row := map[string]any{"dimensionValues": []any{map[string]any{"stringValue": "20261101"}, map[string]any{"intValue": "13"}, map[string]any{"stringValue": "https://example.test"}, map[string]any{"stringValue": "US"}, map[string]any{"stringValue": "unit"}, map[string]any{"stringValue": "42"}}, "metricValueGroups": []any{map[string]any{"primaryValues": []any{map[string]any{"intValue": "10"}, map[string]any{"intValue": "9"}, map[string]any{"intValue": "8"}, map[string]any{"intValue": "1"}, map[string]any{"doubleValue": 1250000.0}}}}}
	facts, err := normalizeRestRows([]any{row}, 1, "upstream", "gam-rest:test", 1000000)
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 1 || facts[0]["reportDate"] != "2026-11-01" || facts[0]["adUnitId"] != "42" || facts[0]["revenue"] != 1.25 {
		t.Fatalf("facts=%v", facts)
	}
	sizes, err := parseGamSizes([]any{"300x250", "fluid", "out-of-page"})
	if err != nil || len(sizes) != 3 {
		t.Fatalf("sizes=%v err=%v", sizes, err)
	}
	if !reflect.DeepEqual(sizes[0]["size"], map[string]any{"width": 300, "height": 250, "sizeType": "PIXEL"}) {
		t.Fatalf("size=%v", sizes[0])
	}
}
