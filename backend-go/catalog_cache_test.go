package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCatalogCacheCoalescesRefreshAndDoesNotCacheErrors(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'GAM','123456','cipher','active','test')"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	handler := a.cachedCatalog(func(w http.ResponseWriter, r *http.Request) error {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		writeJSON(w, 200, map[string]any{"ok": true, "items": []string{"example.com"}})
		return nil
	})
	get := func(query string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/admin/gam-accounts/1/sites"+query, nil)
		r.SetPathValue("id", "1")
		w := httptest.NewRecorder()
		if err := handler(w, r); err != nil {
			t.Error(err)
		}
		return w
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); get("") }()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("duplicate work: %d", calls.Load())
	}
	if w := get(""); w.Header().Get("Server-Timing") != "catalog-cache;desc=\"hit\";dur=0" {
		t.Fatal("cache miss")
	}
	get("?refresh=1")
	if calls.Load() != 2 {
		t.Fatal("manual refresh must fetch")
	}
	if _, err := a.db.Exec("UPDATE soap_accounts SET credential_ciphertext='new-cipher' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	get("")
	if calls.Load() != 3 {
		t.Fatal("credential changes must bypass old cache")
	}
	var failures int
	bad := a.cachedCatalog(func(w http.ResponseWriter, r *http.Request) error {
		failures++
		writeError(w, 502, "upstream_failed")
		return nil
	})
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("GET", "/api/admin/gam-accounts/1/sites?pageToken=bad", nil)
		r.SetPathValue("id", "1")
		if err := bad(httptest.NewRecorder(), r); err != nil {
			t.Fatal(err)
		}
	}
	if failures != 2 {
		t.Fatal("errors were cached")
	}
}
