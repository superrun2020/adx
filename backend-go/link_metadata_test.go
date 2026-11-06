package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLinkMetadataCreateAndEdit(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'First','123456','cipher','active','test'),(2,'Second','999999','cipher','active','test')",
		"INSERT INTO channels(id,name,email,share_percent,status) VALUES(7,'Channel','channel@example.test',100,'active')",
		"INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('" + sha256Hex("link-session") + "',1,datetime('now','+1 day'))",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "/api/admin/link-metadata", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer link-session")
		response := httptest.NewRecorder()
		a.routes().ServeHTTP(response, request)
		return response
	}
	created := call(http.MethodPost, `{"gamAccountId":1,"domain":"https://news.example.com/path","monitorDomains":["example.com"],"channelId":7,"notes":"first"}`)
	if created.Code != 201 {
		t.Fatalf("create %d %s", created.Code, created.Body.String())
	}
	if !a.exists("SELECT 1 FROM link_metadata WHERE network_code='123456' AND domain='example.com' AND is_manual=1") ||
		!a.exists("SELECT 1 FROM link_metadata WHERE network_code='123456' AND domain='news.example.com' AND channel_id=7") {
		t.Fatal("expected local root and subdomain")
	}
	if duplicate := call(http.MethodPost, `{"gamAccountId":1,"domain":"news.example.com"}`); duplicate.Code != 409 {
		t.Fatalf("duplicate %d %s", duplicate.Code, duplicate.Body.String())
	}
	if invalid := call(http.MethodPost, `{"gamAccountId":1,"domain":"bad host"}`); invalid.Code != 400 {
		t.Fatalf("invalid %d %s", invalid.Code, invalid.Body.String())
	}
	changed := call(http.MethodPut, `{"originalNetworkCode":"123456","originalDomain":"news.example.com","gamAccountId":2,"domain":"blog.example.com","notes":"moved"}`)
	if changed.Code != 200 || a.exists("SELECT 1 FROM link_metadata WHERE network_code='123456' AND domain='news.example.com'") ||
		!a.exists("SELECT 1 FROM link_metadata WHERE network_code='999999' AND domain='blog.example.com' AND notes='moved'") {
		t.Fatalf("move %d %s", changed.Code, changed.Body.String())
	}
	listed := call(http.MethodGet, "")
	var payload map[string]any
	if listed.Code != 200 || json.Unmarshal(listed.Body.Bytes(), &payload) != nil || len(payload["items"].([]any)) != 2 {
		t.Fatalf("list %d %s", listed.Code, listed.Body.String())
	}

	a.gamTokens[1] = &gamTokenEntry{cipher: "cipher", token: "test-token", expires: time.Now().Add(time.Hour)}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/networks/123456/sites/1" {
			t.Errorf("wrong GAM site %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "networks/123456/sites/1", "url": "https://example.com"})
	}))
	defer remote.Close()
	a.gamClient, a.gamAPIBase = remote.Client(), remote.URL+"/v1/"
	gamEdit := call(http.MethodPut, `{"originalNetworkCode":"123456","originalDomain":"example.com","gamAccountId":1,"domain":"example.com","siteName":"networks/123456/sites/1","notes":"GAM site"}`)
	if gamEdit.Code != 200 || !a.exists("SELECT 1 FROM link_metadata WHERE network_code='123456' AND domain='example.com' AND is_manual=0 AND notes='GAM site'") {
		t.Fatalf("GAM edit %d %s", gamEdit.Code, gamEdit.Body.String())
	}
	if moved := call(http.MethodPut, `{"originalNetworkCode":"123456","originalDomain":"example.com","gamAccountId":1,"domain":"other.com","siteName":"networks/123456/sites/1"}`); moved.Code != 400 {
		t.Fatalf("GAM move %d %s", moved.Code, moved.Body.String())
	}
}
