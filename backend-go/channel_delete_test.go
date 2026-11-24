package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelDeleteRetainsFactsAndRevokesAccess(t *testing.T) {
	a := testApp(t)
	queries := []string{
		"INSERT INTO channels(id,name,email,share_percent,api_secret_hash) VALUES(77,'Channel','channel@example.test',90,'old-api')",
		"INSERT INTO users(id,email,name,password_hash,role,status,channel_id) VALUES(77,'channel@example.test','Channel','old-hash','channel','active',77)",
		"INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('" + sha256Hex("operator") + "',1,datetime('now','+1 day')),('old-session',77,datetime('now','+1 day'))",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,source_file,revenue) VALUES(77,'2026-11-24','example.com','example.com','test',12)",
	}
	for _, q := range queries {
		if _, err := a.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer operator")
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		return w
	}
	reset := call("POST", "/api/admin/channels/77/password", `{"password":"abc"}`)
	if reset.Code != 200 {
		t.Fatalf("reset %d %s", reset.Code, reset.Body.String())
	}
	var hash string
	if err := a.db.QueryRow("SELECT password_hash FROM users WHERE id=77").Scan(&hash); err != nil || !passwordMatches("abc", hash) {
		t.Fatalf("password not changed: %v", err)
	}
	if a.exists("SELECT 1 FROM sessions WHERE user_id=77") {
		t.Fatal("old sessions survived reset")
	}
	w := call(http.MethodDelete, "/api/admin/channels/77", "")
	if w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}
	if !a.exists("SELECT 1 FROM channels WHERE id=77 AND status='deleted' AND api_secret_hash IS NULL") || !a.exists("SELECT 1 FROM users WHERE id=77 AND status='disabled'") {
		t.Fatal("channel access still enabled")
	}
	if !a.exists("SELECT 1 FROM revenue_facts WHERE channel_id=77 AND revenue=12") {
		t.Fatal("financial history removed")
	}
	if strings.Contains(call("GET", "/api/admin/channels", "").Body.String(), "channel@example.test") {
		t.Fatal("deleted channel listed")
	}
	if w := call("DELETE", "/api/admin/channels/77", ""); w.Code != 200 {
		t.Fatal("repeated deletion failed")
	}
	if w := call("POST", "/api/admin/channels/77/password", `{"password":"abc"}`); w.Code != 404 {
		t.Fatal("deleted channel reset allowed")
	}
}

func TestCannotDeleteChannelUsedForGamSync(t *testing.T) {
	a := testApp(t)
	for _, q := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(77,'Channel','channel@example.test',90)",
		"INSERT INTO soap_accounts(name,network_code,credential_ciphertext,status,created_by,rest_channel_id) VALUES('GAM','123456','cipher','active','test',77)",
		"INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('" + sha256Hex("operator") + "',1,datetime('now','+1 day'))",
	} {
		if _, err := a.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest("DELETE", "/api/admin/channels/77", nil)
	r.Header.Set("Authorization", "Bearer operator")
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	if w.Code != 409 || !a.exists("SELECT 1 FROM channels WHERE id=77 AND status='active'") {
		t.Fatalf("mapped channel deleted: %d", w.Code)
	}
}
