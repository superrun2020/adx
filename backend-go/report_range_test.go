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
		} else {
			revenue = payload["items"].([]any)[0].(map[string]any)["revenue"].(float64)
		}
		if revenue != 3 {
			t.Fatalf("%s revenue=%v, want 3", tc.path, revenue)
		}
	}
}
