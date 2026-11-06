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

func diagnosticTestApp(t *testing.T) *app {
	t.Helper()
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "admin@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "test-password-123")
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.reportCache.close(); a.db.Close() })
	_, err = a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by,rest_money_divisor) VALUES(1,'Test','123456','stub','active','test',1000000)")
	if err != nil {
		t.Fatal(err)
	}
	a.gamTokens[1] = &gamTokenEntry{cipher: "stub", token: "test-token", expires: time.Now().Add(time.Hour)}
	return a
}

func TestGamAdUnitSizesUsesSelectedNetwork(t *testing.T) {
	a := diagnosticTestApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/networks/123456/adUnitSizes" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"adUnitSizes": []any{map[string]any{"size": map[string]any{"sizeType": "PIXEL", "width": 320, "height": 50}, "environmentType": "BROWSER"}}})
	}))
	defer server.Close()
	a.gamClient = server.Client()
	a.gamAPIBase = server.URL + "/v1/"
	req := httptest.NewRequest(http.MethodGet, "/api/admin/gam-accounts/1/ad-unit-sizes", nil)
	req.SetPathValue("id", "1")
	recorder := httptest.NewRecorder()
	if err := a.listGamAccountAdUnitSizes(recorder, req); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), "PIXEL") {
		t.Fatalf("unexpected response: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestDiagnosticSyncIsSeparateFromRevenueFacts(t *testing.T) {
	a := diagnosticTestApp(t)
	const name = "networks/123456/reports/7"
	const result = name + "/results/1"
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/networks/123456/reports":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			body["name"] = name
			_ = json.NewEncoder(w).Encode(body)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/"+name+":run":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "networks/123456/operations/reports/runs/1", "done": true, "response": map[string]any{"reportResult": result}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/"+result+":fetchRows":
			_ = json.NewEncoder(w).Encode(map[string]any{"dateRanges": []any{map[string]any{"startDate": map[string]any{"year": 2026, "month": 11, "day": 4}, "endDate": map[string]any{"year": 2026, "month": 11, "day": 4}}}, "rows": []any{map[string]any{"dimensionValues": []any{map[string]any{"stringValue": "20261104"}, map[string]any{"stringValue": "Desktop"}}, "metricValueGroups": []any{map[string]any{"primaryValues": []any{map[string]any{"intValue": "100"}, map[string]any{"doubleValue": 2500000}, map[string]any{"intValue": "80"}, map[string]any{"intValue": "40"}}}}}}})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	a.gamClient = server.Client()
	a.gamAPIBase = server.URL + "/v1/"
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.syncDiagnosticKind(context.Background(), account, "device", "2026-11-04", "2026-11-04"); err != nil {
		t.Fatal(err)
	}
	var revenue float64
	var viewable int64
	if err := a.db.QueryRow("SELECT revenue,viewable_impressions FROM gam_diagnostic_facts").Scan(&revenue, &viewable); err != nil {
		t.Fatal(err)
	}
	if revenue != 2.5 || viewable != 40 {
		t.Fatalf("diagnostics revenue=%v viewable=%d", revenue, viewable)
	}
	if a.exists("SELECT 1 FROM revenue_facts") {
		t.Fatal("diagnostic data polluted revenue_facts")
	}
	if len(methods) != 3 {
		t.Fatalf("unexpected GAM requests: %v", methods)
	}
	recorder := httptest.NewRecorder()
	a.diagnosticReport(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/reports/diagnostics?start=2026-11-04&end=2026-11-04&kind=device", nil))
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), "viewability") || !strings.Contains(recorder.Body.String(), "50") {
		t.Fatalf("unexpected diagnostic response: %d %s", recorder.Code, recorder.Body.String())
	}
}
