package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSettlementBreakdownUsesUpstream85ThenChannel90(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','test@example.test',90)",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,90,'1900-01-01','test')",
		"INSERT INTO upstream_accounts(id,account_key,name,share_percent,status) VALUES(1,'acct','Upstream',85,'active')",
		"INSERT INTO upstream_share_versions(upstream_account_id,share_percent,effective_from,created_by) VALUES(1,85,'1900-01-01','test')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,revenue,source_file) VALUES(1,'2026-11-19','https://example.test','example.test','acct','unit','unit-1',100,'gam-rest:123:2026-11-19')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.refreshDashboardDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.refreshDashboardRestDaily(0, "", ""); err != nil {
		t.Fatal(err)
	}
	check := func(path string, u user, handler http.HandlerFunc) map[string]any {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, u))
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != 200 {
			t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	admin := user{ID: 1, Role: "admin"}
	path := "/api/dashboard?start=2026-11-19&end=2026-11-19&source=rest"
	summary := check(path, admin, a.dashboard)["summary"].(map[string]any)
	for field, expected := range map[string]float64{"revenue": 100, "upstreamSettlement": 85, "platformProfit": 8.5, "channelRevenue": 76.5} {
		if math.Abs(numberValue(summary[field])-expected) > 1e-6 {
			t.Fatalf("%s=%v, want %v", field, summary[field], expected)
		}
	}
	channel := user{ID: 2, Role: "channel", ChannelID: sql.NullInt64{Int64: 1, Valid: true}}
	channelSummary := check(path, channel, a.dashboard)["summary"].(map[string]any)
	if math.Abs(numberValue(channelSummary["revenue"])-76.5) > 1e-6 {
		t.Fatalf("channel summary=%v", channelSummary)
	}
	if _, found := channelSummary["upstreamSettlement"]; found {
		t.Fatal("channel must not see upstream settlement")
	}
	items := check("/api/reports?start=2026-11-19&end=2026-11-19&dimensions=adUnitId&source=rest", admin, a.reports)["items"].([]any)
	row := items[0].(map[string]any)
	for field, expected := range map[string]float64{"revenue": 100, "upstreamRevenue": 85, "grossProfit": 8.5, "channelRevenue": 76.5} {
		if math.Abs(numberValue(row[field])-expected) > 1e-6 {
			t.Fatalf("report %s=%v, want %v", field, row[field], expected)
		}
	}
}
