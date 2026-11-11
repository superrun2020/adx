package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEditAndArchiveExistingGamAdUnit(t *testing.T) {
	a := testApp(t)
	const network = "123456"
	const root = "networks/123456/adUnits/9"
	const name = "networks/123456/adUnits/777"
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,created_by) VALUES(1,'GAM',?,'stub','active','test')", network); err != nil {
		t.Fatal(err)
	}
	a.gamTokens[1] = &gamTokenEntry{cipher: "stub", token: "test-token", expires: time.Now().Add(time.Hour)}
	unit := map[string]any{"name": name, "parentAdUnit": root, "displayName": "Original", "adUnitCode": "immutable-code",
		"status": "ACTIVE", "description": "Before", "adUnitSizes": []any{
			map[string]any{"environmentType": "BROWSER", "size": map[string]any{"sizeType": "PIXEL", "width": 320, "height": 50}},
			map[string]any{"environmentType": "VIDEO_PLAYER", "size": map[string]any{"sizeType": "PIXEL", "width": 640, "height": 360}},
		}}
	patchCount, archiveCount := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing GAM token")
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/networks/"+network:
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "networks/" + network, "effectiveRootAdUnit": root})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/"+name:
			_ = json.NewEncoder(w).Encode(unit)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/networks/"+network+"/adUnits":
			_ = json.NewEncoder(w).Encode(map[string]any{"adUnits": []any{unit}})
		case r.Method == http.MethodPatch && r.URL.Path == "/v1/"+name:
			patchCount++
			if r.URL.Query().Get("updateMask") != "displayName,description,adUnitSizes" {
				t.Errorf("updateMask=%q", r.URL.Query().Get("updateMask"))
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			if payload["adUnitCode"] != nil || len(payload["adUnitSizes"].([]any)) != 2 || payload["adUnitSizes"].([]any)[1].(map[string]any)["environmentType"] != "VIDEO_PLAYER" {
				t.Errorf("patch changed immutable code or video size: %v", payload)
			}
			for key, value := range payload {
				unit[key] = value
			}
			_ = json.NewEncoder(w).Encode(unit)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/networks/"+network+"/adUnits:batchArchive":
			archiveCount++
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if entries := payload["names"].([]any); len(entries) != 1 || entries[0] != name {
				t.Errorf("archive names=%v", payload)
			}
			unit["status"] = "ARCHIVED"
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected GAM request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	a.gamClient, a.gamAPIBase = server.Client(), server.URL+"/v1/"
	call := func(method, path, body, unitID string, handler func(http.ResponseWriter, *http.Request) error) (int, string, error) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.SetPathValue("id", "1")
		req.SetPathValue("unitId", unitID)
		req = req.WithContext(context.WithValue(req.Context(), userKey{}, user{Email: "admin@example.test", Role: "admin"}))
		res := httptest.NewRecorder()
		err := handler(res, req)
		return res.Code, res.Body.String(), err
	}
	base := "/api/admin/gam-accounts/1/ad-units/777"
	if status, body, err := call(http.MethodGet, base, "", "777", a.gamAdUnitDetail); err != nil || status != 200 || !strings.Contains(body, "immutable-code") {
		t.Fatalf("detail status=%d body=%s err=%v", status, body, err)
	}
	if _, _, err := call(http.MethodPatch, base, "{\"adUnitCode\":\"changed\"}", "777", a.updateGamAdUnit); err == nil || err.Error() != "invalid_ad_unit_update" {
		t.Fatalf("immutable code update err=%v", err)
	}
	status, body, err := call(http.MethodPatch, base, "{\"displayName\":\"Updated\",\"description\":\"After\",\"sizes\":[\"300x250\"]}", "777", a.updateGamAdUnit)
	if err != nil || status != 200 || patchCount != 1 || !strings.Contains(body, "Updated") {
		t.Fatalf("update status=%d body=%s patches=%d err=%v", status, body, patchCount, err)
	}
	archivePath := "/api/admin/gam-accounts/1/ad-units/batch-archive"
	if _, _, err := call(http.MethodPost, archivePath, "{\"names\":[\"networks/999999/adUnits/777\"]}", "", a.archiveGamAdUnits); err == nil {
		t.Fatal("cross-account archive accepted")
	}
	if _, _, err := call(http.MethodPost, archivePath, "{\"names\":[\""+root+"\"]}", "", a.archiveGamAdUnits); err == nil {
		t.Fatal("root unit archive accepted")
	}
	status, body, err = call(http.MethodPost, archivePath, "{\"names\":[\""+name+"\"]}", "", a.archiveGamAdUnits)
	if err != nil || status != 200 || archiveCount != 1 || !strings.Contains(body, "\"archived\":1") {
		t.Fatalf("archive status=%d body=%s archives=%d err=%v", status, body, archiveCount, err)
	}
	if _, _, err := call(http.MethodPatch, base, "{\"displayName\":\"Again\"}", "777", a.updateGamAdUnit); err == nil || err.Error() != "invalid_ad_unit_update" {
		t.Fatalf("archived unit update err=%v", err)
	}
	status, body, err = call(http.MethodGet, "/api/admin/gam-accounts/1/ad-units?statuses=ARCHIVED", "", "", a.listGamAccountAdUnits)
	if err != nil || status != 200 || !strings.Contains(body, "\"status\":\"ARCHIVED\"") {
		t.Fatalf("archived list status=%d body=%s err=%v", status, body, err)
	}
}
