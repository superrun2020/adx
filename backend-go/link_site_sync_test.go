package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLinkSiteSyncDistinguishesParentDuplicate(t *testing.T) {
	a := testApp(t)
	a.gamTokens[1] = &gamTokenEntry{cipher: "cipher", token: "token", expires: time.Now().Add(time.Hour)}
	parent := map[string]any{"url": "example.com", "name": "networks/123456/sites/1", "approvalStatus": "DRAFT"}
	child := map[string]any{"url": "news.example.com", "name": "networks/123456/sites/2", "approvalStatus": "DRAFT"}
	created, allowCreate := false, false
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/networks/123456/sites" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		if r.Method == "POST" {
			posts++
			var req map[string]any
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req["url"] != child["url"] {
				t.Errorf("wrong site: %v", req)
			}
			if !allowCreate {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "Entity already exists."}})
				return
			}
			created = true
			json.NewEncoder(w).Encode(child)
			return
		}
		rows := []map[string]any{parent}
		if created {
			rows = append(rows, child)
		}
		json.NewEncoder(w).Encode(map[string]any{"sites": rows})
	}))
	defer srv.Close()
	a.gamClient, a.gamAPIBase = srv.Client(), srv.URL+"/v1/"
	fields := linkFields{network: "123456", domain: "news.example.com", account: map[string]any{"id": 1, "credential_ciphertext": "cipher"}}
	for _, want := range []string{"parent_only", "created", "verified"} {
		result, err := a.syncLinkSite(httptest.NewRequest("POST", "/", nil), fields)
		if err != nil || result["status"] != want {
			t.Fatalf("want %s: %v %v", want, result, err)
		}
		allowCreate = true
	}
	if posts != 2 {
		t.Fatalf("unexpected create attempts: %d", posts)
	}
}
