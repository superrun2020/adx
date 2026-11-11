package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestReportMultipleDomains(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',100)"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		domain  string
		revenue int
	}{
		{"alpha.example.test", 10}, {"beta.example.test", 20}, {"other.test", 30},
	} {
		_, err := a.db.Exec("INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,requests,impressions,revenue,source_file) VALUES(1,'2026-11-10',?,?,'acct','unit','42',10,10,?,'gam-rest:test')", "https://"+item.domain, item.domain, item.revenue)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := func(domain, mode string, pageTwo, export bool) (int, map[string]any, string) {
		values := url.Values{"start": {"2026-11-10"}, "end": {"2026-11-10"}, "dimensions": {"url"}, "domain": {domain}, "domainMatch": {mode}}
		if pageTwo {
			values.Set("pageSize", "1")
			values.Set("page", "2")
		}
		path := "/api/reports"
		if export {
			path += "/export"
		}
		req := httptest.NewRequest(http.MethodGet, path+"?"+values.Encode(), nil)
		req = req.WithContext(context.WithValue(req.Context(), userKey{}, user{ID: 1, Role: "admin"}))
		response := httptest.NewRecorder()
		if export {
			a.reportsExport(response, req)
			return response.Code, nil, response.Body.String()
		}
		a.reports(response, req)
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return response.Code, body, ""
	}
	for _, item := range []struct {
		domain, mode string
		want         int
	}{
		{"alpha.example.test", "exact", 1},
		{"alpha.example.test, beta.example.test", "exact", 2},
		{"alpha.example.test;ALPHA.EXAMPLE.TEST；beta.example.test", "exact", 2},
		{"alpha.example\nbeta.example", "contains", 2},
		{"example.test", "contains", 2},
	} {
		status, body, _ := request(item.domain, item.mode, false, false)
		if status != 200 || int(body["total"].(float64)) != item.want {
			t.Fatalf("domain=%q mode=%s: status=%d body=%v", item.domain, item.mode, status, body)
		}
	}
	status, body, _ := request("alpha.example.test,beta.example.test", "exact", true, false)
	if status != 200 || int(body["total"].(float64)) != 2 || len(body["items"].([]any)) != 1 {
		t.Fatalf("pagination: status=%d body=%v", status, body)
	}
	status, _, csv := request("alpha.example.test,beta.example.test", "exact", false, true)
	if status != 200 || !strings.Contains(csv, "alpha.example.test") || !strings.Contains(csv, "beta.example.test") || strings.Contains(csv, "other.test") {
		t.Fatalf("CSV: status=%d body=%s", status, csv)
	}
	for _, domain := range []string{strings.Repeat("x", 254), strings.Join(func() []string {
		items := make([]string, 21)
		for i := range items {
			items[i] = "site" + strconv.Itoa(i) + ".test"
		}
		return items
	}(), ",")} {
		status, _, _ := request(domain, "exact", false, false)
		if status != 400 {
			t.Fatalf("invalid domain %q status=%d", domain, status)
		}
	}
}
