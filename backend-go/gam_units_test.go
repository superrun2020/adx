package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGamSelectedSiteDomain(t *testing.T) {
	for _, item := range []struct {
		selected, expected string
		valid              bool
	}{
		{"", "example.test", true},
		{"news.example.test", "news.example.test", true},
		{"https://news.example.test/article", "news.example.test", true},
		{"example.test.other.net", "", false},
		{"other.test", "", false},
	} {
		actual, err := gamSelectedSiteDomain("https://example.test", item.selected)
		if (err == nil) != item.valid || actual != item.expected {
			t.Errorf("selected=%q domain=%q err=%v", item.selected, actual, err)
		}
	}
}

func TestDisabledGamAccountCannotCreateAdUnits(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,enabled,created_by) VALUES(1,'Disabled','123456','cipher','active',0,'test')"); err != nil {
		t.Fatal(err)
	}
	_, err := a.createGamDirect(nil, map[string]any{"gamAccountId": float64(1)}, "test", "", "", "")
	if err == nil || err.Error() != "invalid_gam_account_status" {
		t.Fatalf("disabled account create err=%v", err)
	}
}

func TestGamCreateRejectsLocalNameAndCodeDuplicates(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'First','123456','cipher','active','test')"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`INSERT INTO gam_ad_unit_creations(gam_account_id,network_code,site_name,site_url,domain,parent_ad_unit,display_name,ad_unit_code,sizes_json,created_by) VALUES(1,'123456','networks/123456/sites/1','https://example.test','example.test','networks/123456/adUnits/9','Banner A','banner-a','["300x250"]','test')`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units", nil)
	for _, tc := range []struct{ name, code, want string }{
		{"banner a", "new-code", "ad_unit_name_already_created"},
		{"New name", "BANNER-A", "ad_unit_already_created"},
	} {
		input := map[string]any{"gamAccountId": float64(1), "siteName": "networks/123456/sites/1", "name": tc.name, "code": tc.code, "size": "300x250"}
		_, err := a.createGamDirect(r, input, "test", "", "test-token", "networks/123456/adUnits/9")
		if err == nil || err.Error() != tc.want {
			t.Fatalf("name=%q code=%q err=%v; want %s", tc.name, tc.code, err, tc.want)
		}
	}
}

func TestGamSiteDomainsAreAccountScoped(t *testing.T) {
	a := testApp(t)
	statements := []string{
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'First','123456','cipher','active','test'),(2,'Second','999999','cipher','active','test')",
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',75)",
		`INSERT INTO revenue_facts(channel_id,report_date,url,domain,ad_unit,source_file,raw_json) VALUES
		(1,'2026-11-01','https://news.123456.example.com','news.123456.example.com','261104-news.example.com-banner1','gam-rest:123456:2026-11-01_2026-11-01','{"dimensionValues":[{"stringValue":"20261101"},{"intValue":"13"},{"stringValue":"https://news.123456.example.com"}]}'),
		(1,'2026-11-01','https://sports.123456.example.com','sports.123456.example.com','261104-sports.example.com-INT','gam-rest:123456:2026-11-01_2026-11-01','{"dimensionValues":[{"stringValue":"20261101"},{"intValue":"13"},{"stringValue":"https://sports.123456.example.com"}]}'),
		(1,'2026-11-01','https://shop.999999.example.com','shop.999999.example.com','261104-shop.example.com-banner1','gam-rest:999999:2026-11-01_2026-11-01','{"dimensionValues":[{"stringValue":"20261101"},{"intValue":"13"},{"stringValue":"https://shop.999999.example.com"}]}'),
		(1,'2026-11-01','https://fake.123456.example.com','fake.123456.example.com','Manual','manual-import','{}'),
		(1,'2026-11-01','https://261104-finance.example.com','261104-finance.example.com','261104-finance.example.com-banner1','gam-rest:123456:2026-11-01_2026-11-01','{}'),
		(1,'2026-11-01','https://legacy.example.com','legacy.example.com','261104-legacy.example.com-banner1','gam-rest:123456:2026-11-01_2026-11-01','{"dimensionValues":[{"stringValue":"20261101"},{"intValue":"13"},{"stringValue":"different.example.com"}]}')`,
		"INSERT INTO gam_ad_unit_creations(gam_account_id,network_code,site_name,site_url,domain,parent_ad_unit,display_name,ad_unit_code,sizes_json,created_by) VALUES(1,'123456','networks/123456/sites/1','https://123456.example.com','manual.123456.example.com','networks/123456/adUnits/9','Manual','manual','[]','test')",
		"INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('" + sha256Hex("test-session") + "',1,datetime('now','+1 day'))",
	}
	for _, statement := range statements {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []struct {
		id       string
		expected []string
	}{
		{"1", []string{"news.123456.example.com", "sports.123456.example.com"}},
		{"2", []string{"shop.999999.example.com"}},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/admin/gam-accounts/"+item.id+"/site-domains", nil)
		request.Header.Set("Authorization", "Bearer test-session")
		response := httptest.NewRecorder()
		a.routes().ServeHTTP(response, request)
		if response.Code != 200 {
			t.Fatalf("account %s: status=%d body=%s", item.id, response.Code, response.Body.String())
		}
		var result struct {
			Items []string `json:"items"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Items) != len(item.expected) {
			t.Fatalf("account %s domains=%v", item.id, result.Items)
		}
		for index, expected := range item.expected {
			if result.Items[index] != expected {
				t.Fatalf("account %s domains=%v", item.id, result.Items)
			}
		}
	}
}

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
		case "/v1/networks/123456":
			value = map[string]any{"name": "networks/123456", "effectiveRootAdUnit": "networks/123456/adUnits/9"}
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
	plan := map[string]any{"gamAccountId": 1, "siteName": "networks/123456/sites/1", "domain": "news.example.test", "name": "Banner", "code": "banner-300x250", "sizes": []string{"300x250"}}
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
	if remote["parentAdUnit"] != "networks/123456/adUnits/9" {
		t.Fatalf("expected top-level ad unit, got parent %v", remote["parentAdUnit"])
	}
	if !a.exists("SELECT id FROM gam_ad_unit_creations WHERE ad_unit_code='banner-300x250' AND domain='news.example.test'") {
		t.Fatal("child domain not stored with creation")
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
	plan["domain"] = "external.test"
	plan["code"] = "external"
	plan["name"] = "External"
	badDomainBody, _ := json.Marshal(plan)
	badDomainRequest := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units", strings.NewReader(string(badDomainBody)))
	badDomainRequest.Header.Set("Authorization", "Bearer test-session")
	badDomainResponse := httptest.NewRecorder()
	a.routes().ServeHTTP(badDomainResponse, badDomainRequest)
	if badDomainResponse.Code != 400 || posts != 1 {
		t.Fatalf("external domain accepted: status=%d posts=%d", badDomainResponse.Code, posts)
	}
	plan["domain"] = "news.example.test"
	plan["parentAdUnit"] = "networks/123456/adUnits/8"
	plan["code"] = "nested"
	plan["name"] = "Nested"
	badBody, _ := json.Marshal(plan)
	badRequest := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units", strings.NewReader(string(badBody)))
	badRequest.Header.Set("Authorization", "Bearer test-session")
	badResponse := httptest.NewRecorder()
	a.routes().ServeHTTP(badResponse, badRequest)
	if badResponse.Code != 400 || posts != 1 {
		t.Fatalf("nested ad unit accepted: status=%d posts=%d", badResponse.Code, posts)
	}
}
