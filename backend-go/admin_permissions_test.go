package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestLinksOnlyAdminReceivesRestrictedGamAccountFields(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,account_email,advertiser_share_percent,notes,status,created_by) VALUES('GAM','123456','cipher','private@example.test',65,'private note','active','test')"); err != nil {
		t.Fatal(err)
	}
	u := user{Role: "admin", SidebarPermissions: sql.NullString{String: adminPermissionsJSON([]string{"links"}), Valid: true}}
	request := httptest.NewRequest(http.MethodGet, "/api/admin/gam-accounts", nil)
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, u))
	response := httptest.NewRecorder()
	a.gamAccounts(response, request)
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	items, ok := payload["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("payload=%s", response.Body.String())
	}
	account := items[0].(map[string]any)
	if account["name"] != "GAM" || account["networkCode"] != "123456" || account["accountEmail"] != nil || account["advertiserSharePercent"] != nil || account["notes"] != nil {
		t.Fatalf("restricted account fields=%v", account)
	}
}

func TestBotReportPermissionIsSeparateFromRegression(t *testing.T) {
	u := user{Role: "admin", SidebarPermissions: sql.NullString{String: adminPermissionsJSON([]string{"bot-report"}), Valid: true}}
	if !u.allowedRequest(httptest.NewRequest(http.MethodGet, "/api/admin/bot-report/settings", nil)) ||
		u.allowedRequest(httptest.NewRequest(http.MethodGet, "/api/admin/regression/settings", nil)) {
		t.Fatal("bot report permission must be scoped to its own module")
	}
}

func TestAdUnitWritesRequireAdUnitSidebarAccess(t *testing.T) {
	path := "/api/admin/gam-accounts/1/ad-units/777"
	archive := "/api/admin/gam-accounts/1/ad-units/batch-archive"
	for _, item := range []struct {
		view        string
		read, write bool
	}{{"gam", true, false}, {"ad-units", true, true}, {"links", false, false}} {
		u := user{Role: "admin", SidebarPermissions: sql.NullString{String: adminPermissionsJSON([]string{item.view}), Valid: true}}
		if got := u.allowedRequest(httptest.NewRequest(http.MethodGet, path, nil)); got != item.read {
			t.Errorf("%s detail read=%v", item.view, got)
		}
		if got := u.allowedRequest(httptest.NewRequest(http.MethodPatch, path, nil)); got != item.write {
			t.Errorf("%s edit=%v", item.view, got)
		}
		if got := u.allowedRequest(httptest.NewRequest(http.MethodPost, archive, nil)); got != item.write {
			t.Errorf("%s archive=%v", item.view, got)
		}
	}
}

func TestChannelsOnlyAdminReadsGamDomainsWithoutLinkWriteAccess(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO channels(id,name,email) VALUES(7,'Channel','channel@example.test')"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,rest_channel_id,status,created_by) VALUES('GAM','123456','cipher',7,'active','test')"); err != nil {
		t.Fatal(err)
	}
	u := user{Role: "admin", SidebarPermissions: sql.NullString{String: adminPermissionsJSON([]string{"channels"}), Valid: true}}
	for _, item := range []struct {
		method, path string
		allowed      bool
	}{
		{http.MethodGet, "/api/admin/gam-accounts", true},
		{http.MethodGet, "/api/admin/gam-accounts/1/sites", true},
		{http.MethodGet, "/api/admin/gam-accounts/1/site-domains", true},
		{http.MethodGet, "/api/admin/link-metadata", true},
		{http.MethodPut, "/api/admin/link-metadata", false},
		{http.MethodPost, "/api/admin/link-metadata", false},
		{http.MethodPost, "/api/admin/gam-accounts", false},
	} {
		if got := u.allowedRequest(httptest.NewRequest(item.method, item.path, nil)); got != item.allowed {
			t.Errorf("%s %s allowed=%t want=%t", item.method, item.path, got, item.allowed)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/admin/gam-accounts", nil)
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, u))
	response := httptest.NewRecorder()
	a.gamAccounts(response, request)
	var payload map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &payload) != nil {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	account := payload["items"].([]any)[0].(map[string]any)
	if account["channelId"] != float64(7) || account["credentialConfigured"] != nil {
		t.Fatalf("restricted account=%v", account)
	}
}

func TestLegacyAdminMigrationPrefersNamedActiveOwner(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "older@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "AdminPass123!")
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	hash, err := passwordHash("AdminPass123!")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("UPDATE users SET is_super_admin=0 WHERE email='older@example.test'"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("INSERT INTO users(email,name,password_hash,role,status,is_super_admin) VALUES('disabled@example.test','Disabled',?,'admin','disabled',1),('eddyappcone.kr@gmail.com','Eddy',?,'admin','active',0)", hash, hash); err != nil {
		t.Fatal(err)
	}
	if err = a.ensureSchema(); err != nil {
		t.Fatal(err)
	}
	if !a.exists("SELECT 1 FROM users WHERE email='eddyappcone.kr@gmail.com' AND is_super_admin=1") ||
		a.exists("SELECT 1 FROM users WHERE email='older@example.test' AND is_super_admin=1") {
		t.Fatal("migration did not grant the named active owner highest access")
	}
}
