package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDashboardRestSourceMatchesReportSource(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','test@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		domain, source string
		revenue        float64
	}{
		{"rest.example.test", "gam-rest:123456:window", 10},
		{"legacy.example.test", "legacy-import", 90},
	} {
		if _, err := a.db.Exec("INSERT INTO revenue_facts(channel_id,report_date,domain,url,account,ad_unit,impressions,revenue,source_file) VALUES(1,'2026-11-01',?,?, 'account','unit',1,?,?)", row.domain, "https://"+row.domain, row.revenue, row.source); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.refreshDashboardRestDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/dashboard?start=2026-11-01&end=2026-11-01&source=rest", nil)
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Role: "admin"}))
	response := httptest.NewRecorder()
	a.dashboard(response, request)
	if response.Code != 200 {
		t.Fatalf("dashboard status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	summary := payload["summary"].(map[string]any)
	if summary["revenue"] != float64(10) {
		t.Fatalf("REST dashboard revenue=%v", summary["revenue"])
	}
}

func TestDashboardHighlightsRespectAccountTimezonesAndRestSource(t *testing.T) {
	a := testApp(t)
	instant := time.Date(2026, 11, 4, 1, 30, 0, 0, time.UTC)
	accounts := []map[string]any{
		{"name": "Los Angeles", "network_code": "123456", "rest_network_timezone": "America/Los_Angeles"},
		{"name": "Tokyo", "network_code": "789012", "rest_network_timezone": "Asia/Tokyo"},
	}
	periods, warnings := dashboardPeriods(accounts, instant)
	if len(warnings) != 0 || periods[0].today != "2026-11-03" || periods[1].today != "2026-11-04" {
		t.Fatalf("periods=%+v warnings=%v", periods, warnings)
	}
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','test@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		date, domain, source string
		revenue              float64
	}{
		{"2026-11-03", "la.example.test", "gam-rest:123456:window", 5},
		{"2026-11-04", "tokyo.example.test", "gam-rest:789012:window", 7},
		{"2026-11-04", "wrong-day.example.test", "gam-rest:123456:window", 50},
		{"2026-11-04", "legacy.example.test", "legacy-import", 80},
	} {
		if _, err := a.db.Exec("INSERT INTO revenue_facts(channel_id,report_date,domain,url,account,ad_unit,impressions,revenue,source_file) VALUES(1,?,?,?,?,?,1,?,?)", row.date, row.domain, "https://"+row.domain, "account", "unit", row.revenue, row.source); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.refreshDashboardRestDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	rows, err := a.queryDashboardHighlights(periods, false, 0, false)
	if err != nil || len(rows) != 2 || rows[0]["url"] != "tokyo.example.test" || rows[1]["url"] != "la.example.test" {
		t.Fatalf("daily highlights=%v err=%v", rows, err)
	}
}
