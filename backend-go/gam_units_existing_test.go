package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestCreateGamDirectExistingRemoteUnit(t *testing.T) {
	const network = "123456"
	const siteName = "networks/123456/sites/1"
	const root = "networks/123456/adUnits/0"
	const remoteName = "networks/123456/adUnits/42"

	for _, tc := range []struct {
		name, remoteDisplayName string
		wantCreated             bool
	}{
		{name: "matching remote unit is linked", remoteDisplayName: "news.example.com-banner1", wantCreated: true},
		{name: "conflicting remote unit is rejected", remoteDisplayName: "different placement", wantCreated: false},
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
						"displayName": tc.remoteDisplayName, "adUnitCode": "news.example.com-banner1",
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
			if tc.wantCreated {
				if err != nil || item["status"] != "created" || item["providerId"] != remoteName {
					t.Fatalf("matching remote unit should link locally: item=%v err=%v", item, err)
				}
			} else if err == nil {
				t.Fatalf("conflicting remote unit should fail: item=%v", item)
			}
			var count int
			if err := a.db.QueryRow("SELECT COUNT(*) FROM gam_ad_unit_creations").Scan(&count); err != nil {
				t.Fatal(err)
			}
			wantCount := 0
			if tc.wantCreated {
				wantCount = 1
			}
			if count != wantCount || postCount != 0 {
				t.Fatalf("local rows=%d, remote POSTs=%d; want rows=%d, POSTs=0", count, postCount, wantCount)
			}
		})
	}
}
