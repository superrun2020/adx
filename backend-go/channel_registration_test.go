package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestChannelRegistrationRemainsPendingUntilReview(t *testing.T) {
	a := testApp(t)
	input := map[string]any{
		"contactName": "Jordan Example", "companyName": "Example Media Ltd", "email": "jordan@example.test",
		"password": "x",
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
	if a.exists("SELECT 1 FROM channel_registrations WHERE organization_email='jordan@example.test'") {
		t.Fatal("registration must not sign a contract automatically")
	}
	adminList := func(want string) {
		t.Helper()
		response := httptest.NewRecorder()
		a.channelRegistrations(response, httptest.NewRequest(http.MethodGet, "/api/admin/channel-registrations", nil))
		if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte("\"status\":\""+want+"\"")) {
			t.Fatalf("admin list missing %s: status=%d body=%s", want, response.Code, response.Body.String())
		}
	}
	adminList("registered")

	loginBody, _ := json.Marshal(map[string]string{"email": "jordan@example.test", "password": "x"})
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(loginBody))
	login.Host = "adxpub.geekforest.ai"
	login.RemoteAddr = "192.0.2.10:1234"
	loginResponse := httptest.NewRecorder()
	a.routes().ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("pending login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("pending login did not receive a session")
	}
	call := func(method, path string, payload any) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if payload != nil {
			body, _ = json.Marshal(payload)
		}
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		request.Host = "adxpub.geekforest.ai"
		request.AddCookie(cookies[0])
		response := httptest.NewRecorder()
		a.routes().ServeHTTP(response, request)
		return response
	}
	if dashboard := call(http.MethodGet, "/api/dashboard?start=2026-11-23&end=2026-11-23", nil); dashboard.Code != http.StatusForbidden {
		t.Fatalf("pending account read dashboard: %d %s", dashboard.Code, dashboard.Body.String())
	}
	if pendingPDF := call(http.MethodGet, "/api/channel/contract/pdf", nil); pendingPDF.Code != http.StatusForbidden {
		t.Fatalf("pending account downloaded final PDF: %d", pendingPDF.Code)
	}
	contract := call(http.MethodGet, "/api/channel/contract", nil)
	if contract.Code != http.StatusOK || !bytes.Contains(contract.Body.Bytes(), []byte("\"status\":\"registered\"")) {
		t.Fatalf("unsigned contract status=%d body=%s", contract.Code, contract.Body.String())
	}
	signature := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
	_, companySignatureHash, err := parseRegistrationSignature(signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("INSERT INTO contract_signature_templates(id,signer_name,signer_title,signature_data,signature_hash,updated_by) VALUES(1,'Haijun Lyu','VP',?,?, 'admin@example.test')", signature, companySignatureHash); err != nil {
		t.Fatal(err)
	}
	sign := call(http.MethodPost, "/api/channel/contract/sign", map[string]any{
		"registrationNumber": "REG-12345", "country": "Hong Kong", "registeredAddress": "1 Example Street, Central",
		"phone": "+852 5555 1234", "signatureName": "Jordan Example", "signatureTitle": "Director",
		"signatureData": signature, "accepted": true, "contractVersion": channelAgreementVersion,
	})
	if sign.Code != http.StatusCreated {
		t.Fatalf("sign status=%d body=%s", sign.Code, sign.Body.String())
	}
	contract = call(http.MethodGet, "/api/channel/contract", nil)
	if contract.Code != http.StatusOK || !bytes.Contains(contract.Body.Bytes(), []byte("\"status\":\"signed\"")) {
		t.Fatalf("signed contract status=%d body=%s", contract.Code, contract.Body.String())
	}
	adminList("signed")
	var registrationID int64
	if err := a.db.QueryRow("SELECT id FROM channel_registrations WHERE organization_email='jordan@example.test'").Scan(&registrationID); err != nil {
		t.Fatal(err)
	}
	approval, _ := json.Marshal(map[string]any{
		"channelName": "Example Media", "sharePercent": 75, "effectiveFrom": "2026-11-23", "domains": []any{},
		"reviewerSignatureName": "平台管理员", "reviewerSignatureTitle": "运营负责人",
		"reviewerSignatureData": signature, "reviewerAccepted": true, "contractVersion": channelAgreementVersion,
	})
	adminRequest := httptest.NewRequest(http.MethodPost, "/api/admin/channel-registrations/1/approve", bytes.NewReader(approval))
	adminRequest.SetPathValue("id", strconv.FormatInt(registrationID, 10))
	adminRequest = adminRequest.WithContext(context.WithValue(adminRequest.Context(), userKey{}, user{ID: 1, Email: "admin@example.test", Name: "平台管理员", Role: "admin"}))
	adminResponse := httptest.NewRecorder()
	a.approveChannelRegistration(adminResponse, adminRequest)
	if adminResponse.Code != http.StatusOK {
		t.Fatalf("no-domain approval status=%d body=%s", adminResponse.Code, adminResponse.Body.String())
	}
	adminList("approved")
	var fixedSigner, fixedTitle, fixedHash string
	if err := a.db.QueryRow("SELECT counter_signer,counter_signer_title,counter_signature_hash FROM channel_registration_contracts WHERE registration_id=?", registrationID).Scan(&fixedSigner, &fixedTitle, &fixedHash); err != nil {
		t.Fatal(err)
	}
	if fixedSigner != "Haijun Lyu" || fixedTitle != "VP" || fixedHash != companySignatureHash {
		t.Fatalf("wrong fixed party-A signature: signer=%q title=%q hash=%q", fixedSigner, fixedTitle, fixedHash)
	}
	finalPDF := call(http.MethodGet, "/api/channel/contract/pdf", nil)
	if finalPDF.Code != http.StatusOK || !bytes.HasPrefix(finalPDF.Body.Bytes(), []byte("%PDF-")) || finalPDF.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("final PDF status=%d contentType=%q", finalPDF.Code, finalPDF.Header().Get("Content-Type"))
	}
	var savedPDF []byte
	if err := a.db.QueryRow("SELECT signed_pdf FROM channel_registration_contracts WHERE registration_id=?", registrationID).Scan(&savedPDF); err != nil || !bytes.Equal(savedPDF, finalPDF.Body.Bytes()) {
		t.Fatalf("final PDF not retained: %v", err)
	}
	var queuedMail int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM channel_contract_mail_deliveries WHERE registration_id=? AND status='pending'", registrationID).Scan(&queuedMail); err != nil || queuedMail != 2 {
		t.Fatalf("signed PDF was not queued for both parties: count=%d err=%v", queuedMail, err)
	}
	var assigned int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM channel_domains WHERE channel_id=(SELECT channel_id FROM users WHERE email='jordan@example.test')").Scan(&assigned); err != nil || assigned != 0 {
		t.Fatalf("domains must be assigned later by operations: count=%d err=%v", assigned, err)
	}
}

func TestDeletePendingChannelRegistration(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		`INSERT INTO users(id,email,name,password_hash,role,status,sidebar_permissions) VALUES
			(90,'unsigned@example.test','Unsigned','unused','channel','pending',NULL),
			(91,'signed@example.test','Signed','unused','channel','pending',NULL),
			(92,'reports@example.test','Reports','unused','admin','active','["reports"]')`,
		`INSERT INTO channel_registrations(user_id,company_name,contact_name,registration_number,country,registered_address,organization_email,phone,status)
			VALUES(91,'Example Ltd','Signed','123','UK','Example Street','signed@example.test','12345','signed')`,
		`INSERT INTO channel_contract_email_codes(user_id,email,contract_hash,code_hash,expires_at,sent_at)
			VALUES(90,'unsigned@example.test','contract','code',datetime('now','+1 hour'),datetime('now'))`,
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for token, id := range map[string]int64{"admin": 1, "pending": 90, "reports": 92} {
		if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 hour'))", sha256Hex(token), id); err != nil {
			t.Fatal(err)
		}
	}
	handler := a.routes()
	request := func(method, path, token string, want int) {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s %s as %s returned %d, want %d: %s", method, path, token, res.Code, want, res.Body.String())
		}
	}
	path := "/api/admin/channel-registrations/pending/"
	request(http.MethodDelete, path+"90", "pending", http.StatusForbidden)
	request(http.MethodDelete, path+"90", "reports", http.StatusForbidden)
	request(http.MethodDelete, path+"91", "admin", http.StatusConflict)
	request(http.MethodDelete, path+"90", "admin", http.StatusOK)
	request(http.MethodGet, "/api/auth/me", "pending", http.StatusUnauthorized)
	request(http.MethodDelete, path+"90", "admin", http.StatusConflict)
	if a.exists("SELECT 1 FROM users WHERE id=90") || a.exists("SELECT 1 FROM sessions WHERE user_id=90") || a.exists("SELECT 1 FROM channel_contract_email_codes WHERE user_id=90") {
		t.Fatal("deleted user, session or verification code still exists")
	}
	if !a.exists("SELECT 1 FROM channel_registrations WHERE user_id=91 AND status='signed'") || !a.exists("SELECT 1 FROM audit_logs WHERE action='channel.registration_deleted' AND target_id=90") {
		t.Fatal("expected signed registration and deletion audit to be present")
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
	signature := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
	_, signatureHash, err := parseRegistrationSignature(signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("INSERT INTO contract_signature_templates(id,signer_name,signer_title,signature_data,signature_hash,updated_by) VALUES(1,'Haijun Lyu','VP',?,?, 'admin@example.test')", signature, signatureHash); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("UPDATE channel_registration_contracts SET contract_hash=?,signature_data=?,signature_hash=? WHERE registration_id=1", contractTextHash("signed contract"), signature, signatureHash); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{
		"channelName": "Example Media", "sharePercent": 80, "effectiveFrom": "2026-11-23",
		"domains":               []any{map[string]any{"domain": "example.com", "gamAccountId": 1}},
		"reviewerSignatureName": "Platform Operator", "reviewerSignatureTitle": "运营负责人",
		"reviewerSignatureData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
		"reviewerAccepted":      true, "reviewNote": "", "contractVersion": channelAgreementVersion,
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
	var signer, title, storedSignature, storedHash string
	if err := a.db.QueryRow("SELECT counter_signer,counter_signer_title,counter_signature_data,counter_signature_hash FROM channel_registration_contracts WHERE registration_id=1").Scan(&signer, &title, &storedSignature, &storedHash); err != nil {
		t.Fatal(err)
	}
	if signer != "Platform Operator" || title != "运营负责人" || storedSignature == "" || len(storedHash) != 64 {
		t.Fatalf("counter signature not stored: signer=%q title=%q signaturePresent=%t hash=%q", signer, title, storedSignature != "", storedHash)
	}
	// Simulate a newer legacy signed version whose PDF has not been generated yet.
	_, err = a.db.Exec(`INSERT INTO channel_registration_contracts
		(registration_id,version,contract_text,contract_hash,signer_name,signer_title,signer_email,signature_data,signature_hash,signed_at,
		counter_signer,counter_signer_title,counter_signature_data,counter_signature_hash,countersigned_at)
		SELECT registration_id,'v2',contract_text,contract_hash,signer_name,signer_title,signer_email,signature_data,signature_hash,signed_at,
		counter_signer,counter_signer_title,counter_signature_data,counter_signature_hash,countersigned_at FROM channel_registration_contracts WHERE registration_id=1 AND version='v1'`)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan *httptest.ResponseRecorder, 2)
	for i := 0; i < cap(results); i++ {
		go func() {
			res := httptest.NewRecorder()
			a.sendContractPDF(res, httptest.NewRequest(http.MethodGet, "/", nil), 1)
			results <- res
		}()
	}
	first, second := <-results, <-results
	var canonical []byte
	if err := a.db.QueryRow("SELECT signed_pdf FROM channel_registration_contracts WHERE registration_id=1 AND version='v2'").Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	if len(canonical) == 0 || first.Code != 200 || second.Code != 200 || !bytes.Equal(first.Body.Bytes(), canonical) || !bytes.Equal(second.Body.Bytes(), canonical) {
		t.Fatal("concurrent downloads did not return the stored PDF for the latest signed version")
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

func TestChannelDomainsIncludeOperationsLinkAssignments(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Old channel','old@example.test',75)",
		"INSERT INTO channels(id,name,email,share_percent) VALUES(2,'New channel','new@example.test',75)",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,status,enabled,created_by) VALUES(1,'GAM','123456','cipher','active',1,'test')",
		"INSERT INTO link_metadata(network_code,domain,is_manual,monitor_domains_json,channel_id,notes,updated_by) VALUES('123456','news.example.com',0,'[]',2,'','test')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/channel/domains", nil)
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{Role: "channel", ChannelID: sql.NullInt64{Int64: 2, Valid: true}}))
	response := httptest.NewRecorder()
	a.channelDomains(response, request)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte("news.example.com")) {
		t.Fatalf("assigned site missing: status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := a.db.Exec("UPDATE link_metadata SET channel_id=1 WHERE domain='news.example.com'"); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	a.channelDomains(response, request)
	if response.Code != http.StatusOK || bytes.Contains(response.Body.Bytes(), []byte("news.example.com")) {
		t.Fatalf("transferred site still visible: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPartyASignatureTemplateIsRestrictedAndHashed(t *testing.T) {
	a := testApp(t)
	signature := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
	payload, _ := json.Marshal(map[string]any{"signerName": "Haijun Lyu", "signerTitle": "VP", "signatureData": signature})
	request := httptest.NewRequest(http.MethodPut, "/api/admin/contract-signature", bytes.NewReader(payload))
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 2, Email: "admin@example.test", Name: "Admin", Role: "admin"}))
	response := httptest.NewRecorder()
	a.updateContractSignatureTemplate(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-superadmin updated signature template: %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPut, "/api/admin/contract-signature", bytes.NewReader(payload))
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Email: "root@example.test", Name: "Root", Role: "admin", IsSuperAdmin: true}))
	response = httptest.NewRecorder()
	a.updateContractSignatureTemplate(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("superadmin update status=%d %s", response.Code, response.Body.String())
	}
	_, digest, err := parseRegistrationSignature(signature)
	if err != nil {
		t.Fatal(err)
	}
	item, found := a.one("SELECT signer_name signerName,signer_title signerTitle,signature_hash signatureHash FROM contract_signature_templates WHERE id=1")
	if !found || fieldString(item, "signerName") != "Haijun Lyu" || fieldString(item, "signerTitle") != "VP" || fieldString(item, "signatureHash") != digest {
		t.Fatalf("invalid saved signer template: %#v", item)
	}
}
