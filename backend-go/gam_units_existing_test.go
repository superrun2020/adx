package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateGamDirectExistingRemoteUnit(t *testing.T) {
	const network = "123456"
	const siteName = "networks/123456/sites/1"
	const root = "networks/123456/adUnits/0"
	const remoteName = "networks/123456/adUnits/42"

	for _, tc := range []struct {
		name, remoteDisplayName, remoteCode, wantError string
	}{
		{name: "matching remote unit is rejected", remoteDisplayName: "news.example.com-banner1", remoteCode: "news.example.com-banner1", wantError: "ad_unit_already_exists_in_gam"},
		{name: "conflicting remote code is rejected", remoteDisplayName: "different placement", remoteCode: "news.example.com-banner1", wantError: "ad_unit_already_exists_in_gam"},
		{name: "matching remote name is rejected", remoteDisplayName: "news.example.com-banner1", remoteCode: "different-code", wantError: "ad_unit_name_already_exists_in_gam"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
			t.Setenv("ADX_ADMIN_EMAIL", "admin@example.test")
			t.Setenv("ADX_ADMIN_PASSWORD", "test-password-123")
			a, err := newApp(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer a.db.Close()
			defer a.reportCache.close()
			if _, err := a.db.Exec("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,status,created_by) VALUES(?,?,'stub','active',?)", "Test network", network, "admin@example.test"); err != nil {
				t.Fatal(err)
			}

			postCount := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test-token" {
					t.Errorf("unexpected authorization header")
				}
				if r.Method == http.MethodPost {
					postCount++
					t.Errorf("existing remote ad unit must not be created twice")
					w.WriteHeader(http.StatusConflict)
					return
				}
				switch r.URL.Path {
				case "/v1/" + siteName:
					_ = json.NewEncoder(w).Encode(map[string]any{"name": siteName, "url": "https://example.com"})
				case "/v1/networks/" + network + "/adUnits":
					_ = json.NewEncoder(w).Encode(map[string]any{"adUnits": []any{map[string]any{
						"name": remoteName, "parentAdUnit": root,
						"displayName": tc.remoteDisplayName, "adUnitCode": tc.remoteCode,
						"adUnitSizes": []any{map[string]any{
							"size":            map[string]any{"width": 320, "height": 50, "sizeType": "PIXEL"},
							"environmentType": "BROWSER",
						}},
					}}})
				default:
					t.Errorf("unexpected GAM request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			a.gamClient = server.Client()
			a.gamAPIBase = server.URL + "/v1/"

			input := map[string]any{
				"gamAccountId": float64(1), "siteName": siteName, "domain": "news.example.com",
				"name": "news.example.com-banner1", "code": "news.example.com-banner1",
				"sizes": []any{"320x50"},
			}
			r := httptest.NewRequest(http.MethodPost, "http://localhost/api/admin/gam-ad-units", nil)
			item, err := a.createGamDirect(r, input, "admin@example.test", "127.0.0.1", "test-token", root)
			if err == nil || err.Error() != tc.wantError {
				t.Fatalf("existing remote unit should fail: item=%v err=%v", item, err)
			}
			var count int
			if err := a.db.QueryRow("SELECT COUNT(*) FROM gam_ad_unit_creations").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 || postCount != 0 {
				t.Fatalf("local rows=%d, remote POSTs=%d; want neither", count, postCount)
			}
		})
	}
}

func TestBatchGamAdUnitsAcceptsInternalAccountID(t *testing.T) {
	const network = "123456"
	const siteName = "networks/123456/sites/1"
	const root = "networks/123456/adUnits/0"

	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "admin@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "test-password-123")
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	if _, err := a.db.Exec("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,status,created_by) VALUES(?,?,'stub','active',?)", "Test network", network, "admin@example.test"); err != nil {
		t.Fatal(err)
	}
	a.gamTokens[1] = &gamTokenEntry{cipher: "stub", token: "test-token", expires: time.Now().Add(time.Hour)}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected authorization header")
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/networks/"+network:
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "networks/" + network, "effectiveRootAdUnit": root})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/"+siteName:
			_ = json.NewEncoder(w).Encode(map[string]any{"name": siteName, "url": "https://example.com"})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/networks/"+network+"/adUnits":
			_ = json.NewEncoder(w).Encode(map[string]any{"adUnits": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/networks/"+network+"/adUnits":
			var unit map[string]any
			if err := json.NewDecoder(r.Body).Decode(&unit); err != nil {
				t.Errorf("decode create request: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			unit["name"] = "networks/" + network + "/adUnits/42"
			_ = json.NewEncoder(w).Encode(unit)
		default:
			t.Errorf("unexpected GAM request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	a.gamClient = server.Client()
	a.gamAPIBase = server.URL + "/v1/"

	body := `{"gamAccountId":1,"items":[{"siteName":"` + siteName + `","domain":"news.example.com","name":"news.example.com-banner2","code":"news.example.com-banner2","sizes":["320x50"]}]}`
	r := httptest.NewRequest(http.MethodPost, "http://localhost/api/admin/gam-ad-units/batch", strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), userKey{}, user{Email: "admin@example.test"}))
	response := httptest.NewRecorder()
	if err := a.batchGamAdUnits(response, r); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", response.Code, response.Body.String())
	}
	var result struct {
		Created int `json:"created"`
		Failed  int `json:"failed"`
		Results []struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Created != 1 || result.Failed != 0 || len(result.Results) != 1 || result.Results[0].Status != "created" {
		t.Fatalf("unexpected batch result: %+v", result)
	}
	var count int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM gam_ad_unit_creations WHERE status='created'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("created records=%d, want 1", count)
	}
	duplicateBody := `{"gamAccountId":1,"items":[{"siteName":"` + siteName + `","name":"Repeated","code":"unique-one","sizes":["320x50"]},{"siteName":"` + siteName + `","name":"repeated","code":"unique-two","sizes":["320x50"]}]}`
	duplicateRequest := httptest.NewRequest(http.MethodPost, "/api/admin/gam-ad-units/batch", strings.NewReader(duplicateBody))
	duplicateRequest = duplicateRequest.WithContext(context.WithValue(duplicateRequest.Context(), userKey{}, user{Email: "admin@example.test"}))
	if err := a.batchGamAdUnits(httptest.NewRecorder(), duplicateRequest); err == nil || err.Error() != "duplicate_ad_unit_name" {
		t.Fatalf("duplicate batch name err=%v", err)
	}
}
