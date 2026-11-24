package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestContractSMTPLive(t *testing.T) {
	if os.Getenv("CONTRACT_SMTP_LIVE_TEST") != "1" {
		t.Skip("live mail test not requested")
	}
	if err := sendContractVerificationEmail(context.Background(), os.Getenv("CONTRACT_MAIL_FROM"), "TEST01"); err != nil {
		t.Fatal(err)
	}
}

func TestContractVerificationCanFailClosedWithoutSMTP(t *testing.T) {
	t.Setenv("CONTRACT_SMTP_HOST", "")
	t.Setenv("CONTRACT_EMAIL_VERIFICATION_REQUIRED", "true")
	if !contractEmailRequired() || contractEmailConfigured() {
		t.Fatal("contract verification must remain required when SMTP is unavailable")
	}
}

func TestContractSigningCodeBindsEmailAndFrozenAgreement(t *testing.T) {
	t.Setenv("CONTRACT_SMTP_HOST", "smtp.example.test")
	a := testApp(t)
	_, err := a.db.Exec("INSERT INTO users(id,email,name,company_name,password_hash,role,status) VALUES(88,'signer@example.test','Jordan Example','Example Media Ltd','unused','channel','pending')")
	if err != nil {
		t.Fatal(err)
	}
	u := user{ID: 88, Email: "signer@example.test", Name: "Jordan Example", CompanyName: "Example Media Ltd", Role: "channel", Status: "pending", ChannelID: sql.NullInt64{}}
	signature := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
	input := channelRegistrationInput{RegistrationNumber: "REG-12345", Country: "Hong Kong", RegisteredAddress: "1 Example Street", Phone: "+852 5555 1234", SignatureName: u.Name, SignatureTitle: "Director", SignatureData: signature, Accepted: true, ContractVersion: channelAgreementVersion, VerificationCode: "123456"}
	if !prepareContractDetails(&input, u) {
		t.Fatal("invalid fixture")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.db.Exec("INSERT INTO channel_contract_email_codes(user_id,email,contract_hash,code_hash,expires_at,sent_at) VALUES(?,?,?,?,?,?)", u.ID, u.Email, contractTextHash(renderRegistrationContract(input)), string(hash), time.Now().UTC().Add(15*time.Minute).Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	call := func(value channelRegistrationInput) *httptest.ResponseRecorder {
		body, _ := json.Marshal(value)
		request := httptest.NewRequest(http.MethodPost, "/api/channel/contract/sign", bytes.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, u))
		response := httptest.NewRecorder()
		a.signChannelContract(response, request)
		return response
	}
	changed := input
	changed.RegisteredAddress = "2 Different Street"
	if response := call(changed); response.Code != http.StatusBadRequest {
		t.Fatalf("different contract accepted: %d %s", response.Code, response.Body.String())
	}
	wrong := input
	wrong.VerificationCode = "654321"
	if response := call(wrong); response.Code != http.StatusBadRequest {
		t.Fatalf("wrong code accepted: %d %s", response.Code, response.Body.String())
	}
	if response := call(input); response.Code != http.StatusCreated {
		t.Fatalf("verified contract rejected: %d %s", response.Code, response.Body.String())
	}
	var consumed sql.NullString
	if err := a.db.QueryRow("SELECT consumed_at FROM channel_contract_email_codes WHERE user_id=?", u.ID).Scan(&consumed); err != nil || !consumed.Valid {
		t.Fatalf("code was not consumed: %v", err)
	}
}
