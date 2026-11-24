package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
)

func TestJungleLabsAgreementUsesVerifiedPartyDetails(t *testing.T) {
	text := publicContractText()
	for _, required := range []string{
		"甲方：JUNGLELABS LTD", "公司注册号：17083142",
		"Initial Business Centre, Unit 7 Wilson Business Park, Manchester, United Kingdom, M40 8WN",
		"notice@junglelabs.uk", "乙方：[公司法定名称]",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("agreement is missing %q", required)
		}
	}
	for _, obsolete := range []string{"XPERTMOBI", "Rinser", "香港摩比", "2025 年10 月 01 日"} {
		if strings.Contains(text, obsolete) {
			t.Fatalf("agreement still contains obsolete party detail %q", obsolete)
		}
	}
}

func TestSignedContractEmailContainsDownloadablePDF(t *testing.T) {
	t.Setenv("CONTRACT_MAIL_FROM", "sender@example.test")
	pdf := []byte("%PDF-1.7\nfinal agreement")
	raw := signedContractEmailMessage("channel@example.test", 42, pdf)
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	from, err := mail.ParseAddress(message.Header.Get("From"))
	if err != nil || from.Name != "AdX Admin" || from.Address != "sender@example.test" {
		t.Fatalf("unexpected sender: %s", message.Header.Get("From"))
	}
	if message.Header.Get("To") != "channel@example.test" || message.Header.Get("Reply-To") != partyAContractEmail {
		t.Fatalf("wrong mail headers: %#v", message.Header)
	}
	mediaType, params, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/mixed" {
		t.Fatalf("invalid MIME type: %s %v", mediaType, err)
	}
	parts := multipart.NewReader(message.Body, params["boundary"])
	if _, err = parts.NextPart(); err != nil {
		t.Fatal(err)
	}
	attachment, err := parts.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(attachment.Header.Get("Content-Disposition"), "junglelabs-adx-contract-42.pdf") {
		t.Fatal("signed PDF attachment is missing")
	}
	decoded, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, attachment))
	if err != nil || !bytes.Equal(decoded, pdf) {
		t.Fatalf("PDF attachment changed: %v", err)
	}
}

func TestSignedContractDeliveryRetriesAndDoesNotResend(t *testing.T) {
	a := testApp(t)
	pdf := []byte("%PDF-1.7\nsigned")
	digest := sha256.Sum256(pdf)
	statements := []string{
		"INSERT INTO users(id,email,name,company_name,password_hash,role,status) VALUES(91,'channel@example.test','Jordan','Example Ltd','unused','channel','active')",
		"INSERT INTO channel_registrations(id,user_id,company_name,contact_name,registration_number,country,registered_address,organization_email,phone,status) VALUES(91,91,'Example Ltd','Jordan','REG-91','UK','1 Example Street','channel@example.test','12345678','approved')",
	}
	for _, statement := range statements {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	_, err := a.db.Exec("INSERT INTO channel_registration_contracts(registration_id,version,contract_text,contract_hash,signer_name,signer_title,signer_email,signature_data,signature_hash,signed_at,countersigned_at,signed_pdf,signed_pdf_sha256) VALUES(91,'v2','text','hash','Jordan','Director','channel@example.test','signature','signature-hash','2026-11-24T00:00:00Z','2026-11-24T01:00:00Z',?,?)", pdf, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := a.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = queueSignedContractEmail(tx, 91, "channel", "channel@example.test"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	called := 0
	fail := func(_ context.Context, recipient string, id int64, attachment []byte) error {
		called++
		if recipient != "channel@example.test" || id != 91 || !bytes.Equal(attachment, pdf) {
			t.Fatal("wrong recipient or signed PDF")
		}
		return errors.New("temporary failure")
	}
	if err = a.deliverSignedContractEmailWith(context.Background(), 91, "channel", fail); err == nil {
		t.Fatal("temporary send failure was ignored")
	}
	var status string
	var attempts int
	if err = a.db.QueryRow("SELECT status,attempts FROM channel_contract_mail_deliveries WHERE registration_id=91 AND purpose='channel'").Scan(&status, &attempts); err != nil || status != "failed" || attempts != 1 {
		t.Fatalf("failed delivery status=%s attempts=%d err=%v", status, attempts, err)
	}
	_, _ = a.db.Exec("UPDATE channel_contract_mail_deliveries SET last_attempt_at=datetime('now','-16 minutes') WHERE registration_id=91")
	succeed := func(_ context.Context, recipient string, id int64, attachment []byte) error {
		called++
		return nil
	}
	if err = a.deliverSignedContractEmailWith(context.Background(), 91, "channel", succeed); err != nil {
		t.Fatal(err)
	}
	if err = a.deliverSignedContractEmailWith(context.Background(), 91, "channel", succeed); err != nil {
		t.Fatal(err)
	}
	if err = a.db.QueryRow("SELECT status,attempts FROM channel_contract_mail_deliveries WHERE registration_id=91 AND purpose='channel'").Scan(&status, &attempts); err != nil || status != "sent" || attempts != 2 || called != 2 {
		t.Fatalf("delivery duplicated or not retried: status=%s attempts=%d calls=%d err=%v", status, attempts, called, err)
	}
}
