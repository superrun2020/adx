package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelPreviewScopesReadsAndRejectsWrites(t *testing.T) {
	a := testApp(t)
	for _, query := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(100,'First','one@example.test',90),(200,'Second','two@example.test',90)",
		"INSERT INTO users(id,email,name,password_hash,role,status,channel_id,sidebar_permissions) VALUES(90,'one@example.test','First','unused','channel','active',100,NULL),(91,'pending@example.test','Pending','unused','channel','pending',NULL,NULL),(92,'reports@example.test','Reports','unused','admin','active',NULL,'[\"reports\"]'),(93,'channels@example.test','Channels','unused','admin','active',NULL,'[\"channels\"]')",
		"INSERT INTO channel_domains(channel_id,domain) VALUES(100,'one.example.test'),(200,'two.example.test')",
	} {
		if _, err := a.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	for token, id := range map[string]int64{"publisher": 90, "reports": 92, "ops": 93} {
		if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 hour'))", sha256Hex(token), id); err != nil {
			t.Fatal(err)
		}
	}
	handler := a.routes()
	request := func(method, path, host, token string, want int) string {
		t.Helper()
		req := httptest.NewRequest(method, "https://"+host+path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, response.Code, want, response.Body.String())
		}
		return response.Body.String()
	}
	prefix := "/api/admin/channel-preview/"
	host := a.adminHost
	request(http.MethodGet, prefix+"90/api/auth/me", host, "", http.StatusUnauthorized)
	request(http.MethodGet, prefix+"90/api/auth/me", host, "reports", http.StatusForbidden)
	request(http.MethodGet, prefix+"90/api/auth/me", a.publisherHost, "publisher", http.StatusForbidden)
	body := request(http.MethodGet, prefix+"90/api/channel/domains?channelId=200", host, "ops", http.StatusOK)
	if !strings.Contains(body, "one.example.test") || strings.Contains(body, "two.example.test") {
		t.Fatal("preview did not use the selected publisher's domain scope")
	}
	request(http.MethodGet, prefix+"90/api/auth/me", host, "ops", http.StatusOK)
	request(http.MethodGet, prefix+"91/api/channel/contract", host, "ops", http.StatusOK)
	request(http.MethodGet, prefix+"91/api/dashboard", host, "ops", http.StatusForbidden)
	request(http.MethodGet, prefix+"93/api/auth/me", host, "ops", http.StatusNotFound)
	request(http.MethodGet, prefix+"90/api/channel/api-secret", host, "ops", http.StatusNotFound)
	request(http.MethodPost, prefix+"91/api/channel/contract/sign", host, "ops", http.StatusNotFound)
	request(http.MethodGet, "/api/auth/me", host, "ops", http.StatusOK)
	if !a.exists("SELECT 1 FROM audit_logs WHERE actor_email='channels@example.test' AND action='auth.channel_preview' AND target_id=90") {
		t.Fatal("preview access was not audited")
	}
}
