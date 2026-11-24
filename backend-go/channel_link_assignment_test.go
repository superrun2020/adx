package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAssignedWebsiteSeparatesNetworksAndTransfersTXT(t *testing.T) {
	a := testApp(t)
	for _, q := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(7,'A','a@example.test',75),(8,'B','b@example.test',75)",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'One','123456','cipher','active','test'),(2,'Two','999999','cipher','active','test')",
		"INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('" + sha256Hex("site-session") + "',1,datetime('now','+1 day'))",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,url,account,ad_unit,revenue,source_file) VALUES(7,'2026-11-01','news.example.com','news.example.com','one','banner',3,'gam-rest:123456:day'),(7,'2026-11-01','news.example.com','news.example.com','two','banner',11,'gam-rest:999999:day')",
	} {
		if _, err := a.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(http.MethodPut, "/api/admin/channels/8/link", strings.NewReader(`{"gamAccountId":1,"domain":"news.example.com","adxTxt":"google.com, pub-123, DIRECT"}`))
	request.Header.Set("Authorization", "Bearer site-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("assignment %d %s", response.Code, response.Body.String())
	}
	for _, row := range []struct{ id, amount int64 }{{7, 11}, {8, 3}} {
		var amount int64
		if err := a.db.QueryRow("SELECT SUM(rf.revenue) FROM revenue_facts rf WHERE " + channelDomainScopeSQL("rf", row.id)).Scan(&amount); err != nil || amount != row.amount {
			t.Fatalf("channel %d sum %d err %v", row.id, amount, err)
		}
	}
	var txt string
	if err := a.db.QueryRow("SELECT adxTxt FROM (" + assignedSitesSQL() + ") WHERE channelId=8 AND networkCode='123456'").Scan(&txt); err != nil || txt != "google.com, pub-123, DIRECT" {
		t.Fatalf("assigned TXT %q err %v", txt, err)
	}
	if a.exists("SELECT 1 FROM (" + assignedSitesSQL() + ") WHERE channelId=7") {
		t.Fatal("TXT visible to previous channel")
	}
}
