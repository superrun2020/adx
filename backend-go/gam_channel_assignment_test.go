package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateInternalChannelWithoutLogin(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,datetime('now','+1 day'))", sha256Hex("test-session")); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"name": "Rinser", "sharePercent": 70})
	request := httptest.NewRequest(http.MethodPost, "/api/admin/channels", strings.NewReader(string(payload)))
	request.Header.Set("Authorization", "Bearer test-session")
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Channel struct {
			ID           int64
			Email        string
			InternalOnly int64
		}
		Secret string
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Channel.ID == 0 || body.Channel.Email != "" || body.Channel.InternalOnly != 1 || body.Secret != "" {
		t.Fatalf("unexpected internal channel: %+v", body)
	}
	if a.exists("SELECT id FROM users WHERE channel_id=?", body.Channel.ID) {
		t.Fatal("internal channel must not create a login")
	}
}

func TestGamChannelAssignmentsRespectCutoverDate(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email) VALUES(1,'Zhao','zhao@example.test'),(2,'Rinser','rinser@example.test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,rest_channel_id) VALUES(1,'GAM','123456','cipher','test',2)",
		"INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(1,1,'1900-01-01','test'),(1,2,'2026-11-16','test')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	assignments, err := a.gamChannelAssignments(1, 2, "2026-11-16")
	if err != nil {
		t.Fatal(err)
	}
	if channelForGamDate(assignments, "2026-11-15") != 1 || channelForGamDate(assignments, "2026-11-16") != 2 {
		t.Fatalf("bad assignment: %+v", assignments)
	}
	if channel, err := a.gamChannelForDate(1, 2, "2026-11-15"); err != nil || channel != 1 {
		t.Fatalf("historical channel=%d error=%v", channel, err)
	}
}
