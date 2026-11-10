package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReportNumericSortBeforePagination(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	insert, err := a.db.Prepare("INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,requests,impressions,revenue,source_file) VALUES(1,'2026-11-09',?,?,'acct','unit','42',?,?,?,'gam-rest:test')")
	if err != nil {
		t.Fatal(err)
	}
	defer insert.Close()
	for _, row := range []struct {
		domain   string
		requests int
		revenue  float64
	}{
		{"nine.example.test", 9, 30}, {"hundred.example.test", 100, 2}, {"twenty.example.test", 20, 10},
	} {
		if _, err := insert.Exec("https://"+row.domain, row.domain, row.requests, row.requests, row.revenue); err != nil {
			t.Fatal(err)
		}
	}
	get := func(query string) (int, map[string]any) {
		request := httptest.NewRequest(http.MethodGet, "/api/reports?start=2026-11-09&end=2026-11-09&dimensions=url&pageSize=1&source=rest&"+query, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Role: "admin"}))
		response := httptest.NewRecorder()
		a.reports(response, request)
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return response.Code, body
	}
	for _, tc := range []struct {
		query string
		field string
		want  float64
	}{
		{"sortBy=requests&sortDir=asc&page=1", "requests", 9},
		{"sortBy=requests&sortDir=asc&page=2", "requests", 20},
		{"sortBy=requests&sortDir=desc&page=1", "requests", 100},
		{"sortBy=requests&sortDir=desc&page=2", "requests", 20},
		{"sortBy=revenue&sortDir=asc&page=2", "revenue", 10},
	} {
		status, body := get(tc.query)
		if status != 200 {
			t.Fatalf("%s: %d %+v", tc.query, status, body)
		}
		items := body["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)[tc.field] != tc.want {
			t.Fatalf("%s: %+v", tc.query, items)
		}
	}
	if status, _ := get("sortBy=requests%3BDROP+TABLE+revenue_facts&sortDir=asc"); status != 400 {
		t.Fatalf("invalid sort status=%d", status)
	}
	if status, _ := get("sortBy=requests&sortDir=sideways"); status != 400 {
		t.Fatalf("invalid direction status=%d", status)
	}
}

func TestRegressionNumericSortBeforePagination(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by) VALUES(1,'GAM','123456','test','admin')",
		"INSERT INTO regression_runs(id,soap_account_id,cadence,period_start,period_end,status) VALUES(1,1,'day','2026-11-09','2026-11-09','success')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	insert, err := a.db.Prepare("INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks) VALUES(1,1,'day','2026-11-09','2026-11-09','example.test',?,0,0,0,0,0,0,0)")
	if err != nil {
		t.Fatal(err)
	}
	defer insert.Close()
	for n := 1; n <= 101; n++ {
		if _, err := insert.Exec(n); err != nil {
			t.Fatal(err)
		}
	}
	get := func(query string) (int, map[string]any) {
		response := httptest.NewRecorder()
		a.regressionEvents(response, httptest.NewRequest(http.MethodGet, "/api/admin/regression/events?"+query, nil))
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return response.Code, body
	}
	for _, tc := range []struct {
		query string
		want  float64
	}{
		{"sortBy=oldRevenue&sortDir=asc&page=1", 1},
		{"sortBy=oldRevenue&sortDir=asc&page=2", 101},
		{"sortBy=oldRevenue&sortDir=desc&page=1", 101},
		{"sortBy=oldRevenue&sortDir=desc&page=2", 1},
	} {
		status, body := get(tc.query)
		if status != 200 {
			t.Fatalf("%s: %d %+v", tc.query, status, body)
		}
		items := body["items"].([]any)
		if len(items) == 0 || items[0].(map[string]any)["oldRevenue"] != tc.want {
			t.Fatalf("%s: %+v", tc.query, items)
		}
	}
	if status, _ := get("sortBy=oldRevenue&sortDir=invalid"); status != 400 {
		t.Fatalf("invalid sort status=%d", status)
	}
}
