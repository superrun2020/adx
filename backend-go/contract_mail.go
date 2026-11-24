package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func contractEmailConfigured() bool {
	return os.Getenv("CONTRACT_SMTP_HOST") != "" && os.Getenv("CONTRACT_SMTP_USER") != "" &&
		os.Getenv("CONTRACT_SMTP_PASSWORD") != "" && os.Getenv("CONTRACT_MAIL_FROM") != ""
}

func contractEmailRequired() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("CONTRACT_EMAIL_VERIFICATION_REQUIRED")), "true") ||
		strings.TrimSpace(os.Getenv("CONTRACT_SMTP_HOST")) != ""
}

func contractMailPort() (int, error) {
	port, err := strconv.Atoi(envDefault("CONTRACT_SMTP_PORT", "587"))
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("invalid_contract_smtp_port")
	}
	return port, nil
}

type smtpLoginAuth struct {
	username, password string
	step               int
}

func (auth *smtpLoginAuth) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", nil, nil
}
func (auth *smtpLoginAuth) Next(_ []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	auth.step++
	if auth.step == 1 {
		return []byte(auth.username), nil
	}
	if auth.step == 2 {
		return []byte(auth.password), nil
	}
	return nil, errors.New("smtp_login_unexpected_challenge")
}

func sendContractVerificationEmail(ctx context.Context, recipient, code string) error {
	if !contractEmailConfigured() {
		return errors.New("contract_email_unconfigured")
	}
	from := strings.TrimSpace(os.Getenv("CONTRACT_MAIL_FROM"))
	address, err := mail.ParseAddress(from)
	if err != nil || address.Address != from || strings.ContainsAny(recipient, "\r\n") {
		return errors.New("invalid_contract_mail_address")
	}
	host := strings.TrimSpace(os.Getenv("CONTRACT_SMTP_HOST"))
	port, err := contractMailPort()
	if err != nil {
		return err
	}
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))
	mode := strings.ToLower(envDefault("CONTRACT_SMTP_TLS_MODE", "starttls"))
	if mode == "implicit" {
		secured := tls.Client(connection, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err = secured.HandshakeContext(ctx); err != nil {
			return err
		}
		connection = secured
	} else if mode != "starttls" {
		return errors.New("invalid_contract_smtp_tls_mode")
	}
	client, err := smtp.NewClient(connection, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if mode == "starttls" {
		if err = client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	ok, mechanisms := client.Extension("AUTH")
	if !ok {
		return errors.New("smtp_auth_unavailable")
	}
	var authentication smtp.Auth
	if strings.Contains(strings.ToUpper(mechanisms), "PLAIN") {
		authentication = smtp.PlainAuth("", os.Getenv("CONTRACT_SMTP_USER"), os.Getenv("CONTRACT_SMTP_PASSWORD"), host)
	} else if strings.Contains(strings.ToUpper(mechanisms), "LOGIN") {
		authentication = &smtpLoginAuth{username: os.Getenv("CONTRACT_SMTP_USER"), password: os.Getenv("CONTRACT_SMTP_PASSWORD")}
	} else {
		return errors.New("smtp_auth_method_unsupported")
	}
	if err = client.Auth(authentication); err != nil {
		return err
	}
	if err = client.Mail(from); err != nil {
		return err
	}
	if err = client.Rcpt(recipient); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	content := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: AdX contract signing verification code\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour one-time code for signing the AdX cooperation agreement is: %s\r\nThe code expires in 15 minutes. If you did not request it, ignore this email.\r\n", from, recipient, code)
	if _, err = io.WriteString(writer, content); err != nil {
		_ = writer.Close()
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func newContractEmailCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", value.Int64()), nil
}

func prepareContractDetails(input *channelRegistrationInput, u user) bool {
	input.ContactName, input.CompanyName, input.Email = u.Name, u.CompanyName, u.Email
	input.RegistrationNumber = strings.TrimSpace(input.RegistrationNumber)
	input.Country = strings.TrimSpace(input.Country)
	input.RegisteredAddress = strings.TrimSpace(input.RegisteredAddress)
	input.Phone = strings.TrimSpace(input.Phone)
	input.SignatureName = strings.TrimSpace(input.SignatureName)
	input.SignatureTitle = strings.TrimSpace(input.SignatureTitle)
	return len(input.CompanyName) >= 2 && len(input.RegistrationNumber) >= 2 && len(input.RegistrationNumber) <= 100 &&
		len(input.Country) >= 2 && len(input.Country) <= 100 && len(input.RegisteredAddress) >= 8 && len(input.RegisteredAddress) <= 800 &&
		len(input.Phone) >= 5 && len(input.Phone) <= 80 && input.SignatureName == u.Name &&
		len(input.SignatureTitle) >= 2 && len(input.SignatureTitle) <= 150 && input.ContractVersion == channelAgreementVersion &&
		len(input.Domains) == 0 && input.Website == ""
}

func (a *app) sendChannelContractCode(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u.Status != "pending" || u.ChannelID.Valid || a.exists("SELECT 1 FROM channel_registrations WHERE user_id=?", u.ID) {
		writeError(w, 409, "channel_contract_not_signable")
		return
	}
	if !contractEmailConfigured() {
		writeError(w, 503, "contract_email_unconfigured")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var input channelRegistrationInput
	if json.NewDecoder(r.Body).Decode(&input) != nil || !prepareContractDetails(&input, u) {
		writeError(w, 400, "invalid_contract_details")
		return
	}
	var lastSent string
	err := a.db.QueryRowContext(r.Context(), "SELECT sent_at FROM channel_contract_email_codes WHERE user_id=?", u.ID).Scan(&lastSent)
	if err != nil && err != sql.ErrNoRows {
		serverError(w, err)
		return
	}
	if last, parseErr := time.Parse(time.RFC3339Nano, lastSent); parseErr == nil && time.Since(last) < time.Minute {
		writeError(w, 429, "contract_code_rate_limited")
		return
	}
	code, err := newContractEmailCode()
	if err != nil {
		serverError(w, err)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		serverError(w, err)
		return
	}
	now := time.Now().UTC()
	_, err = a.db.ExecContext(r.Context(), "INSERT INTO channel_contract_email_codes(user_id,email,contract_hash,code_hash,expires_at,sent_at,attempts,consumed_at) VALUES(?,?,?,?,?,?,0,NULL) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,contract_hash=excluded.contract_hash,code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0,consumed_at=NULL", u.ID, u.Email, contractTextHash(renderRegistrationContract(input)), string(hash), now.Add(15*time.Minute).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		serverError(w, err)
		return
	}
	if err = sendContractVerificationEmail(r.Context(), u.Email, code); err != nil {
		_, _ = a.db.ExecContext(r.Context(), "DELETE FROM channel_contract_email_codes WHERE user_id=? AND code_hash=?", u.ID, string(hash))
		writeError(w, 503, "contract_email_send_failed")
		return
	}
	a.audit(u.Email, "channel.contract_code_sent", "user", u.ID, "", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "email": u.Email, "expiresInSeconds": 900})
}

func (a *app) verifyChannelContractCode(u user, input channelRegistrationInput, snapshot string) (string, error) {
	code := strings.TrimSpace(input.VerificationCode)
	if len(code) != 6 {
		return "", errors.New("invalid_contract_code")
	}
	var email, hash, contractHash, expires string
	var attempts int
	var consumed sql.NullString
	err := a.db.QueryRow("SELECT email,code_hash,contract_hash,expires_at,attempts,consumed_at FROM channel_contract_email_codes WHERE user_id=?", u.ID).Scan(&email, &hash, &contractHash, &expires, &attempts, &consumed)
	if err != nil || consumed.Valid || attempts >= 5 || email != u.Email || contractHash != contractTextHash(snapshot) {
		return "", errors.New("invalid_contract_code")
	}
	deadline, err := time.Parse(time.RFC3339Nano, expires)
	if err != nil || !deadline.After(time.Now().UTC()) {
		return "", errors.New("contract_code_expired")
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(code)) != nil {
		_, _ = a.db.Exec("UPDATE channel_contract_email_codes SET attempts=attempts+1 WHERE user_id=? AND consumed_at IS NULL", u.ID)
		return "", errors.New("invalid_contract_code")
	}
	return hash, nil
}
