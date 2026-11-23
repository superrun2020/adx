package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelRegistrationRemainsPendingUntilReview(t *testing.T) {
	a := testApp(t)
	input := map[string]any{
		"contactName": "Jordan Example", "companyName": "Example Media Ltd", "email": "jordan@example.test",
		"password": "strong-password-123", "registrationNumber": "REG-12345", "country": "Hong Kong",
		"registeredAddress": "1 Example Street, Central", "phone": "+852 5555 1234",
		"domains":       []any{map[string]any{"domain": "example.com", "adxTxt": "google.com, pub-123, DIRECT, f08c47fec0942fa0"}},
		"signatureName": "Jordan Example", "signatureTitle": "Director",
		"signatureData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
		"accepted":      true, "contractVersion": channelAgreementVersion,
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/register-channel", bytes.NewReader(body))
	request.Host = "adxpub.geekforest.ai"
	request.RemoteAddr = "192.0.2.10:1234"
	response := httptest.NewRecorder()
	a.routes().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	var status string
	var channelID sql.NullInt64
	if err := a.db.QueryRow("SELECT status,channel_id FROM users WHERE email=?", "jordan@example.test").Scan(&status, &channelID); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || channelID.Valid {
		t.Fatalf("new applicant status=%q channelID=%v", status, channelID)
	}

	loginBody, _ := json.Marshal(map[string]string{"email": "jordan@example.test", "password": "strong-password-123"})
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(loginBody))
	login.Host = "adxpub.geekforest.ai"
	login.RemoteAddr = "192.0.2.10:1234"
	loginResponse := httptest.NewRecorder()
	a.routes().ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusForbidden || !bytes.Contains(loginResponse.Body.Bytes(), []byte("registration_pending_review")) {
		t.Fatalf("pending login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
}

func TestRegistrationApprovalActivatesOnlyMappedChannelAndStoresCounterSignature(t *testing.T) {
	a := testApp(t)
	statements := []string{
		"INSERT INTO users(id,email,name,password_hash,role,status) VALUES(99,'jordan@example.test','Jordan Example','unused','channel','pending')",
		"INSERT INTO users(id,email,name,password_hash,role,status) VALUES(9,'operator@example.test','Platform Operator','unused','admin','active')",
		"INSERT INTO channel_registrations(id,user_id,company_name,contact_name,registration_number,country,registered_address,organization_email,phone,status) VALUES(1,99,'Example Media Ltd','Jordan Example','REG-12345','Hong Kong','1 Example Street, Central','jordan@example.test','+852 5555 1234','signed')",
		"INSERT INTO channel_registration_contracts(registration_id,version,contract_text,contract_hash,signer_name,signer_title,signer_email,signature_data,signature_hash,signed_at) VALUES(1,'v1','signed contract','contract-hash','Jordan Example','Director','jordan@example.test','signature-data','signature-hash','2026-11-23T00:00:00Z')",
		"INSERT INTO channel_registration_domains(registration_id,domain,adx_txt) VALUES(1,'example.com','google.com, pub-123, DIRECT, f08c47fec0942fa0')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,enabled,created_by) VALUES(1,'Network A','123456','test-cipher','active',1,'test')",
		"INSERT INTO link_metadata(network_code,domain,is_manual,monitor_domains_json,notes,updated_by) VALUES('123456','example.com',0,'[]','','test')",
	}
	for _, statement := range statements {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	input := map[string]any{
		"channelName": "Example Media", "sharePercent": 80, "effectiveFrom": "2026-11-23",
		"domains":               []any{map[string]any{"domain": "example.com", "gamAccountId": 1}},
		"reviewerSignatureName": "Platform Operator", "reviewerSignatureTitle": "运营负责人",
		"reviewerSignatureData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
		"reviewerAccepted":      true, "reviewNote": "",
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/admin/channel-registrations/1/approve", bytes.NewReader(body))
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 9, Email: "operator@example.test", Name: "Platform Operator", Role: "admin"}))
	response := httptest.NewRecorder()
	a.approveChannelRegistration(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("approve status=%d body=%s", response.Code, response.Body.String())
	}
	var status string
	var channelID int64
	if err := a.db.QueryRow("SELECT status,channel_id FROM users WHERE id=99").Scan(&status, &channelID); err != nil {
		t.Fatal(err)
	}
	if status != "active" || channelID < 1 {
		t.Fatalf("approved user status=%q channelID=%d", status, channelID)
	}
	var assignedChannel int64
	var txt string
	if err := a.db.QueryRow("SELECT channel_id,adx_txt FROM channel_domains WHERE domain='example.com'").Scan(&assignedChannel, &txt); err != nil {
		t.Fatal(err)
	}
	if assignedChannel != channelID || txt == "" {
		t.Fatalf("domain assignment channel=%d txt=%q", assignedChannel, txt)
	}
	var signer, title, signature, signatureHash string
	if err := a.db.QueryRow("SELECT counter_signer,counter_signer_title,counter_signature_data,counter_signature_hash FROM channel_registration_contracts WHERE registration_id=1").Scan(&signer, &title, &signature, &signatureHash); err != nil {
		t.Fatal(err)
	}
	if signer != "Platform Operator" || title != "运营负责人" || signature == "" || len(signatureHash) != 64 {
		t.Fatalf("counter signature not stored: signer=%q title=%q signaturePresent=%t hash=%q", signer, title, signature != "", signatureHash)
	}
}

func TestRegistrationContractPreviewMatchesSignedSnapshot(t *testing.T) {
	input := channelRegistrationInput{
		CompanyName: "Example Media Ltd", RegisteredAddress: "1 Example Street", ContactName: "Jordan Example",
		Phone: "+852 5555 1234", Email: "jordan@example.test", SignatureName: "Jordan Example",
		RegistrationNumber: "REG-12345", Country: "Hong Kong",
	}
	preview := renderRegistrationContract(input)
	if strings.Contains(preview, "[") || strings.Contains(preview, "]") {
		t.Fatalf("contract still has placeholders: %s", preview)
	}
	for _, value := range []string{input.CompanyName, input.RegisteredAddress, input.ContactName, input.Phone, input.Email, input.RegistrationNumber, input.Country} {
		if !strings.Contains(preview, value) {
			t.Fatalf("contract snapshot missing %q", value)
		}
	}
	if preview != renderRegistrationContract(input) {
		t.Fatal("same registration produced a different signed snapshot")
	}
}

func TestChannelReportUsesAssignedDomainOwnerWithLegacyFallback(t *testing.T) {
	a := testApp(t)
	statements := []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Old owner','old@example.test',100)",
		"INSERT INTO channels(id,name,email,share_percent) VALUES(2,'New owner','new@example.test',100)",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,100,'1900-01-01','test')",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(2,100,'1900-01-01','test')",
		"INSERT INTO channel_domains(channel_id,domain) VALUES(2,'owner.example.com')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,revenue,source_file) VALUES(1,'2026-11-19','https://child.owner.example.com/page','child.owner.example.com','acct','unit-a',10,'gam-rest:123:2026-11-19')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,revenue,source_file) VALUES(1,'2026-11-19','https://legacy.example.net/page','legacy.example.net','acct','unit-b',5,'gam-rest:123:2026-11-19')",
	}
	for _, statement := range statements {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	requestRows := func(channelID int64) []any {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/reports?start=2026-11-19&end=2026-11-19&dimensions=url&source=rest", nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{Role: "channel", ChannelID: sql.NullInt64{Int64: channelID, Valid: true}}))
		response := httptest.NewRecorder()
		a.reports(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("reports status=%d body=%s", response.Code, response.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload["items"].([]any)
	}
	oldOwnerRows := requestRows(1)
	if len(oldOwnerRows) != 1 || oldOwnerRows[0].(map[string]any)["url"] != "legacy.example.net" {
		t.Fatalf("old owner rows=%v", oldOwnerRows)
	}
	newOwnerRows := requestRows(2)
	if len(newOwnerRows) != 1 || newOwnerRows[0].(map[string]any)["url"] != "child.owner.example.com" {
		t.Fatalf("new owner rows=%v", newOwnerRows)
	}
}
