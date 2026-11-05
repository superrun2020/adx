package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestYearRangeIncludesBothEndpointsInDashboardAndReports(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		date    string
		revenue float64
	}{
		{"2025-11-04", 8}, {"2025-11-05", 1}, {"2026-11-04", 2},
	} {
		_, err := a.db.Exec("INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,requests,matched_requests,impressions,revenue,source_file) VALUES(1,?,'https://example.test','example.test','123','unit','42',10,9,8,?,?)", item.date, item.revenue, "gam-rest:123:"+item.date)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := a.refreshDashboardDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path    string
		handler http.HandlerFunc
		field   string
	}{
		{"/api/dashboard?start=2025-11-05&end=2026-11-04", a.dashboard, "summary"},
		{"/api/reports?start=2025-11-05&end=2026-11-04&dimensions=url&source=rest", a.reports, "items"},
	} {
		request := httptest.NewRequest(http.MethodGet, tc.path, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Role: "admin"}))
		response := httptest.NewRecorder()
		tc.handler(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", tc.path, response.Code, response.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		var revenue float64
		if tc.field == "summary" {
			revenue = payload["summary"].(map[string]any)["revenue"].(float64)
			if got := payload["topUrls"].([]any)[0].(map[string]any)["impressions"].(float64); got != 16 {
				t.Fatalf("%s top impressions=%v, want 16", tc.path, got)
			}
		} else {
			revenue = payload["items"].([]any)[0].(map[string]any)["revenue"].(float64)
		}
		if revenue != 3 {
			t.Fatalf("%s revenue=%v, want 3", tc.path, revenue)
		}
	}
}

func TestDashboardDailyAndMonthlyLinkRanking(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		date, domain string
		revenue      float64
	}{
		{"2026-11-04", "first.example.test", 1},
		{"2026-11-04", "second.example.test", 10},
		{"2026-11-05", "first.example.test", 5},
		{"2026-11-05", "second.example.test", 2},
	} {
		_, err := a.db.Exec("INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,impressions,revenue,source_file) VALUES(1,?,?,?,'123','unit','42',8,?,'gam-rest:123')", item.date, "https://"+item.domain, item.domain, item.revenue)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := a.refreshDashboardDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, top   string
		revenue     float64
		impressions float64
	}{
		{"/api/dashboard?start=2026-11-05&end=2026-11-05", "first.example.test", 5, 8},
		{"/api/dashboard?start=2026-11-01&end=2026-11-05", "second.example.test", 12, 16},
	} {
		request := httptest.NewRequest(http.MethodGet, tc.path, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Role: "admin"}))
		response := httptest.NewRecorder()
		a.dashboard(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", tc.path, response.Code, response.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		top := payload["topUrls"].([]any)
		if len(top) != 2 || top[0].(map[string]any)["url"] != tc.top || top[0].(map[string]any)["revenue"] != tc.revenue || top[0].(map[string]any)["impressions"] != tc.impressions {
			t.Fatalf("%s top=%+v", tc.path, top)
		}
	}
}
