package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGamCreateRetryReconcilesRemoteSuccess(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'Test','123456','test-cipher','active','test')"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,datetime('now','+1 day'))", sha256Hex("test-session")); err != nil {
		t.Fatal(err)
	}
	a.gamTokens[1] = &gamTokenEntry{cipher: "test-cipher", token: "test-token", expires: time.Now().Add(time.Hour)}
	var remote map[string]any
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var value any
		switch r.URL.Path {
		case "/v1/networks/123456/sites/1":
			value = map[string]any{"name": "networks/123456/sites/1", "url": "https://example.test"}
		case "/v1/networks/123456/adUnits/9":
			value = map[string]any{"name": "networks/123456/adUnits/9"}
		case "/v1/networks/123456/adUnits":
			if r.Method == http.MethodPost {
				posts++
				if err := json.NewDecoder(r.Body).Decode(&remote); err != nil {
					t.Errorf("decode: %v", err)
				}
				remote["name"] = "networks/123456/adUnits/10"
				w.WriteHeader(502)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "response lost"}})
				return
			}
			units := []any{}
			if remote != nil {
				units = append(units, remote)
			}
			value = map[string]any{"adUnits": units}
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	a.gamClient = server.Client()
	a.gamAPIBase = server.URL + "/v1/"
	plan := map[string]any{"gamAccountId": 1, "siteName": "networks/123456/sites/1", "parentAdUnit": "networks/123456/adUnits/9", "name": "Banner", "code": "banner-300x250", "sizes": []string{"300x250"}}
	body, _ := json.Marshal(plan)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units", strings.NewReader(string(body)))
	request.Header.Set("Authorization", "Bearer test-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != 502 {
		t.Fatalf("first create status=%d body=%s", response.Code, response.Body.String())
	}
	if !a.exists("SELECT id FROM gam_ad_unit_creations WHERE status='failed' AND ad_unit_code='banner-300x250'") {
		t.Fatal("missing failed creation")
	}
	retry := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units/1/retry", nil)
	retry.Header.Set("Authorization", "Bearer test-session")
	retried := httptest.NewRecorder()
	a.routes().ServeHTTP(retried, retry)
	if retried.Code != 200 {
		t.Fatalf("retry status=%d body=%s", retried.Code, retried.Body.String())
	}
	if posts != 1 || !a.exists("SELECT id FROM gam_ad_unit_creations WHERE status='created' AND provider_id='networks/123456/adUnits/10'") {
		t.Fatalf("posts=%d retry=%s", posts, retried.Body.String())
	}
}
