package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateInternalChannelWithoutLogin(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,datetime('now','+1 day'))", sha256Hex("test-session")); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"name": "Rinser", "sharePercent": 70})
	request := httptest.NewRequest(http.MethodPost, "/api/admin/channels", strings.NewReader(string(payload)))
	request.Header.Set("Authorization", "Bearer test-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Channel struct {
			ID           int64
			Email        string
			InternalOnly int64
		}
		Secret string
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Channel.ID == 0 || body.Channel.Email != "" || body.Channel.InternalOnly != 1 || body.Secret != "" {
		t.Fatalf("unexpected internal channel: %+v", body)
	}
	if a.exists("SELECT id FROM users WHERE channel_id=?", body.Channel.ID) {
		t.Fatal("internal channel must not create a login")
	}
}

func TestGamChannelAssignmentsRespectCutoverDate(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email) VALUES(1,'Zhao','zhao@example.test'),(2,'Rinser','rinser@example.test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,rest_channel_id) VALUES(1,'GAM','123456','cipher','test',2)",
		"INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(1,1,'1900-01-01','test'),(1,2,'2026-11-16','test')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	assignments, err := a.gamChannelAssignments(1, 2, "2026-11-16")
	if err != nil {
		t.Fatal(err)
	}
	if channelForGamDate(assignments, "2026-11-15") != 1 || channelForGamDate(assignments, "2026-11-16") != 2 {
		t.Fatalf("bad assignment: %+v", assignments)
	}
	if channel, err := a.gamChannelForDate(1, 2, "2026-11-15"); err != nil || channel != 1 {
		t.Fatalf("historical channel=%d error=%v", channel, err)
	}
}

func TestGamDomainAssignmentIncludesChildrenAndRespectsDate(t *testing.T) {
	assignments := []gamDomainChannelAssignment{
		{RootDomain: "youxiglobal.xyz", Date: "2026-11-18", ChannelID: 1},
		{RootDomain: "news.youxiglobal.xyz", Date: "2026-11-19", ChannelID: 3},
	}
	for _, item := range []struct {
		date, domain string
		want         int64
	}{
		{"2026-11-17", "news.youxiglobal.xyz", 2},
		{"2026-11-18", "youxiglobal.xyz", 1},
		{"2026-11-18", "deep.news.youxiglobal.xyz", 1},
		{"2026-11-19", "deep.news.youxiglobal.xyz", 3},
		{"2026-11-19", "fake-youxiglobal.xyz", 2},
		{"2026-11-19", "youxiglobal.xyz.evil.net", 2},
	} {
		if got := channelForGamDomainDate(assignments, item.date, item.domain, 2); got != item.want {
			t.Errorf("%s %s: channel=%d want=%d", item.date, item.domain, got, item.want)
		}
	}
}

func TestAccountReassignmentPreservesDomainOwner(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email) VALUES(1,'Zhao','zhao@example.test'),(2,'Rinser','rinser@example.test'),(3,'Next','next@example.test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,enabled,rest_report_name,rest_channel_id,rest_upstream_account_id,created_by) VALUES(1,'GAM','123456','cipher','active',1,'networks/123456/reports/11',2,1,'test')",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id,status) VALUES(1,'upstream','Upstream',1,'active')",
		"INSERT INTO gam_domain_channel_assignments(root_domain,channel_id,effective_from,created_by) VALUES('youxiglobal.xyz',1,'2026-11-18','test')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,source_file,revenue) VALUES(1,'2026-11-18','https://news.youxiglobal.xyz','news.youxiglobal.xyz','upstream','gam-rest:123456:today',10),(2,'2026-11-18','https://other.test','other.test','upstream','gam-rest:123456:today',20)",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := a.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := assignChannelAccounts(tx, 3, []int64{1}, "2026-11-18", "test"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if !a.exists("SELECT 1 FROM revenue_facts WHERE domain='news.youxiglobal.xyz' AND channel_id=1") ||
		!a.exists("SELECT 1 FROM revenue_facts WHERE domain='other.test' AND channel_id=3") {
		t.Fatal("account reassignment changed domain-specific ownership")
	}
}

func TestChannelCreationBindsAccountLinksAndCurrentFacts(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Zhao','zhao@example.test',70)",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,70,'1900-01-01','test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,enabled,rest_report_name,rest_channel_id,rest_upstream_account_id,rest_money_divisor,created_by) VALUES(1,'GAM','123456','cipher','active',1,'networks/123456/reports/11',1,1,1,'test')",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id,status) VALUES(1,'upstream','Upstream',1,'active')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,source_file,revenue) VALUES(1,'2026-11-15','https://site.test','site.test','upstream','gam-rest:123456:old',10),(1,'2026-11-16','https://site.test','site.test','upstream','gam-rest:123456:new',20)",
		"INSERT INTO link_metadata(network_code,domain,channel_id,updated_by) VALUES('123456','site.test',1,'test')",
		"INSERT INTO channel_domains(channel_id,domain) VALUES(1,'site.test')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,datetime('now','+1 day'))", sha256Hex("test-session")); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"name": "Rinser", "sharePercent": 70, "effectiveFrom": "2026-11-16", "gamAccountIds": []int64{1}})
	request := httptest.NewRequest(http.MethodPost, "/api/admin/channels", strings.NewReader(string(payload)))
	request.Header.Set("Authorization", "Bearer test-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var newID int64
	if err := a.db.QueryRow("SELECT id FROM channels WHERE name='Rinser' AND share_percent=70 AND internal_only=1").Scan(&newID); err != nil {
		t.Fatal(err)
	}
	if !a.exists("SELECT 1 FROM soap_accounts WHERE id=1 AND rest_channel_id=? AND channel_locked_to_account=1", newID) {
		t.Fatal("account not linked")
	}
	if !a.exists("SELECT 1 FROM revenue_facts WHERE report_date='2026-11-15' AND channel_id=1") || !a.exists("SELECT 1 FROM revenue_facts WHERE report_date='2026-11-16' AND channel_id=?", newID) {
		t.Fatal("fact ownership dates wrong")
	}
	if !a.exists("SELECT 1 FROM link_metadata WHERE network_code='123456' AND domain='site.test' AND channel_id=?", newID) {
		t.Fatal("link metadata not linked")
	}
	if !a.exists("SELECT 1 FROM gam_channel_assignments WHERE soap_account_id=1 AND channel_id=1 AND effective_from='1900-01-01'") || !a.exists("SELECT 1 FROM gam_channel_assignments WHERE soap_account_id=1 AND channel_id=? AND effective_from='2026-11-16'", newID) {
		t.Fatal("history missing")
	}
	if a.exists("SELECT 1 FROM dashboard_rest_daily WHERE channel_id=1 AND report_date='2026-11-16'") || !a.exists("SELECT 1 FROM dashboard_rest_daily WHERE channel_id=? AND report_date='2026-11-16'", newID) {
		t.Fatal("dashboard not refreshed")
	}
	listRequest := httptest.NewRequest(http.MethodGet, "/api/admin/channels", nil)
	listRequest.Header.Set("Authorization", "Bearer test-session")
	listResponse := httptest.NewRecorder()
	a.routes().ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), "gamAccountIds") || !strings.Contains(listResponse.Body.String(), "[1]") {
		t.Fatalf("channel account listing missing: status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
}
