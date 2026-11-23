package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed contracts/xpertmobi-template-v1.txt
var xpertmobiAgreementTemplate string

const channelAgreementVersion = "xpertmobi-electronic-v1"

type registrationDomainInput struct {
	Domain string
	AdxTxt string
}

type channelRegistrationInput struct {
	ContactName        string
	CompanyName        string
	Email              string
	Password           string
	RegistrationNumber string
	Country            string
	RegisteredAddress  string
	Phone              string
	Domains            []registrationDomainInput
	SignatureName      string
	SignatureTitle     string
	SignatureData      string
	Accepted           bool
	ContractVersion    string
	Website            string
}

var signatureDataPattern = regexp.MustCompile("^data:image/(png|jpeg);base64,")

func publicContractText() string {
	text := strings.Replace(xpertmobiAgreementTemplate,
		"甲方：\n联系地址： 业务联系人：\n联系电话：\n电子邮箱：",
		"乙方：[公司法定名称]\n联系地址：[公司注册地址] 业务联系人：[联系人姓名]\n联系电话：[联系电话]\n电子邮箱：[签约邮箱]\n注册编号：[注册编号]\n注册国家/地区：[注册国家/地区]", 1)
	text = strings.Replace(text, "起始于： 2025 年10 月 01 日", "起始于：双方电子签署并完成平台复核之日（以系统签署记录为准）", 1)
	text = strings.Replace(text, "本合同经双方盖章后即告生效", "本合同经双方电子签署并完成平台复核后即告生效", 1)
	text = strings.Replace(text, "甲方：香港摩比互聯網廣告傳媒有限公司XPERTMOBI INTERNET ADVERTISING MEDIA CO.，LIMITED | 乙方：",
		"甲方：香港摩比互聯網廣告傳媒有限公司 XPERTMOBI INTERNET ADVERTISING MEDIA CO.，LIMITED | 乙方：[公司法定名称]", 1)
	text = strings.Replace(text, "联系人： | 联系人：", "联系人：Rinser | 联系人：[签署人姓名]", 1)
	text = strings.Replace(text, "日期：   2026/6/1 | 日期：2026/5/1", "日期：电子签署时间以系统记录为准 | 日期：电子签署时间以系统记录为准", 1)
	return text
}

func renderRegistrationContract(input channelRegistrationInput) string {
	text := publicContractText()
	for placeholder, value := range map[string]string{
		"[公司法定名称]": input.CompanyName, "[公司注册地址]": input.RegisteredAddress,
		"[联系人姓名]": input.ContactName, "[联系电话]": input.Phone,
		"[签约邮箱]": input.Email, "[签署人姓名]": input.SignatureName,
		"[注册编号]": input.RegistrationNumber, "[注册国家/地区]": input.Country,
	} {
		text = strings.ReplaceAll(text, placeholder, value)
	}
	return text
}

func contractTextHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func parseRegistrationSignature(value string) (string, string, error) {
	if len(value) > 320000 {
		return "", "", errors.New("invalid_registration_signature")
	}
	match := signatureDataPattern.FindStringIndex(value)
	if match == nil {
		return "", "", errors.New("invalid_registration_signature")
	}
	image, err := base64.StdEncoding.DecodeString(value[match[1]:])
	if err != nil || len(image) < 40 || len(image) > 240000 {
		return "", "", errors.New("invalid_registration_signature")
	}
	isPNG := len(image) > 8 && string(image[:8]) == "\x89PNG\r\n\x1a\n"
	isJPEG := len(image) > 3 && image[0] == 0xff && image[1] == 0xd8 && image[2] == 0xff
	if !isPNG && !isJPEG {
		return "", "", errors.New("invalid_registration_signature")
	}
	sum := sha256.Sum256(image)
	return value, hex.EncodeToString(sum[:]), nil
}

func (a *app) publicChannelContract(w http.ResponseWriter, r *http.Request) {
	if a.portalRole(r) != "channel" {
		writeError(w, 421, "unknown_host")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": channelAgreementVersion, "text": publicContractText()})
}

func validRegistrationInput(input channelRegistrationInput) bool {
	email := strings.ToLower(strings.TrimSpace(input.Email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || input.Website != "" ||
		len(input.Password) < 10 || len(input.Password) > 200 ||
		len(input.ContactName) < 2 || len(input.ContactName) > 200 ||
		len(input.CompanyName) < 2 || len(input.CompanyName) > 200 {
		return false
	}
	return true
}

func (a *app) registerChannel(w http.ResponseWriter, r *http.Request) {
	if a.portalRole(r) != "channel" {
		writeError(w, 421, "unknown_host")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var input channelRegistrationInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, 400, "invalid_registration")
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.ContactName = strings.TrimSpace(input.ContactName)
	input.CompanyName = strings.TrimSpace(input.CompanyName)
	if !validRegistrationInput(input) {
		writeError(w, 400, "invalid_registration")
		return
	}
	ip := clientIP(r)
	if a.attempts.check("register|" + ip + "|" + input.Email) {
		writeError(w, 429, "registration_rate_limited")
		return
	}
	if a.exists("SELECT 1 FROM users WHERE lower(email)=lower(?)", input.Email) ||
		a.exists("SELECT 1 FROM channels WHERE lower(email)=lower(?)", input.Email) {
		writeError(w, 409, "registration_email_unavailable")
		return
	}
	hash, err := passwordHash(input.Password)
	if err != nil {
		serverError(w, err)
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		serverError(w, err)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	ttl := sessionTTLHours()
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	userResult, err := tx.ExecContext(r.Context(), "INSERT INTO users(email,name,password_hash,company_name,role,channel_id,status) VALUES(?,?,?,?,'channel',NULL,'pending')",
		input.Email, input.ContactName, hash, input.CompanyName)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, 409, "registration_email_unavailable")
		} else {
			serverError(w, err)
		}
		return
	}
	userID, _ := userResult.LastInsertId()
	_, err = tx.ExecContext(r.Context(), "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))",
		sha256Hex(token), userID, "+"+strconv.Itoa(ttl)+" hours")
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	setSessionCookie(w, r, token, ttl)
	a.audit(input.Email, "channel.registration_created", "user", userID, marshalText(map[string]any{"company": input.CompanyName}), ip)
	writeJSON(w, 201, map[string]any{"ok": true, "status": "pending", "user": user{ID: userID, Email: input.Email, Name: input.ContactName, CompanyName: input.CompanyName, Role: "channel", Status: "pending"}.public()})
}

func (a *app) signChannelContract(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u.Status != "pending" || u.ChannelID.Valid {
		writeError(w, 409, "channel_contract_not_signable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var input channelRegistrationInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, 400, "invalid_contract_details")
		return
	}
	input.ContactName, input.CompanyName, input.Email = u.Name, u.CompanyName, u.Email
	input.RegistrationNumber = strings.TrimSpace(input.RegistrationNumber)
	input.Country = strings.TrimSpace(input.Country)
	input.RegisteredAddress = strings.TrimSpace(input.RegisteredAddress)
	input.Phone = strings.TrimSpace(input.Phone)
	input.SignatureName = strings.TrimSpace(input.SignatureName)
	input.SignatureTitle = strings.TrimSpace(input.SignatureTitle)
	if len(input.CompanyName) < 2 || len(input.RegistrationNumber) < 2 || len(input.RegistrationNumber) > 100 ||
		len(input.Country) < 2 || len(input.Country) > 100 ||
		len(input.RegisteredAddress) < 8 || len(input.RegisteredAddress) > 800 ||
		len(input.Phone) < 5 || len(input.Phone) > 80 ||
		input.SignatureName != u.Name || len(input.SignatureTitle) < 2 || len(input.SignatureTitle) > 150 ||
		!input.Accepted || input.ContractVersion != channelAgreementVersion || len(input.Domains) != 0 || input.Website != "" {
		writeError(w, 400, "invalid_contract_details")
		return
	}
	signature, signatureDigest, err := parseRegistrationSignature(input.SignatureData)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if a.exists("SELECT 1 FROM channel_registrations WHERE user_id=?", u.ID) {
		writeError(w, 409, "channel_contract_already_signed")
		return
	}
	signedAt := time.Now().UTC().Format(time.RFC3339Nano)
	snapshot := renderRegistrationContract(input)
	userAgent := strings.TrimSpace(r.UserAgent())
	if len(userAgent) > 500 {
		userAgent = userAgent[:500]
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(),
		"INSERT INTO channel_registrations(user_id,company_name,contact_name,registration_number,country,registered_address,organization_email,phone,status) VALUES(?,?,?,?,?,?,?,?,'signed')",
		u.ID, input.CompanyName, input.ContactName, input.RegistrationNumber, input.Country, input.RegisteredAddress, input.Email, input.Phone)
	if err != nil {
		writeError(w, 409, "channel_contract_already_signed")
		return
	}
	registrationID, _ := result.LastInsertId()
	_, err = tx.ExecContext(r.Context(),
		"INSERT INTO channel_registration_contracts(registration_id,version,contract_text,contract_hash,signer_name,signer_title,signer_email,signature_data,signature_hash,signed_at,signer_ip,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
		registrationID, channelAgreementVersion, snapshot, contractTextHash(snapshot), input.SignatureName, input.SignatureTitle,
		input.Email, signature, signatureDigest, signedAt, clientIP(r), userAgent)
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.audit(u.Email, "channel.contract_signed", "channel_registration", registrationID,
		marshalText(map[string]string{"contractVersion": channelAgreementVersion, "contractHash": contractTextHash(snapshot), "signatureHash": signatureDigest}), clientIP(r))
	writeJSON(w, 201, map[string]any{"ok": true, "status": "signed_pending_review", "contractHash": contractTextHash(snapshot)})
}

func (a *app) channelRegistrations(w http.ResponseWriter, r *http.Request) {
	items, err := queryMaps(a.db, "SELECT COALESCE(r.id,-u.id) id,u.id userId,COALESCE(r.company_name,u.company_name) companyName,"+
		"COALESCE(r.contact_name,u.name) contactName,COALESCE(r.registration_number,'') registrationNumber,COALESCE(r.country,'') country,"+
		"COALESCE(r.registered_address,'') registeredAddress,u.email,COALESCE(r.phone,'') phone,COALESCE(r.status,'registered') status,"+
		"r.channel_id channelId,COALESCE(r.review_note,'') reviewNote,COALESCE(r.created_at,u.created_at) createdAt,"+
		"COALESCE(c.name,'') channelName,co.version contractVersion,co.signer_name signerName,co.signer_title signerTitle,"+
		"co.signed_at signedAt,co.contract_hash contractHash,"+
		"(SELECT COUNT(*) FROM channel_domains cd WHERE cd.channel_id=r.channel_id) assignedDomainCount,"+
		"(SELECT COUNT(*) FROM soap_accounts s WHERE s.rest_channel_id=r.channel_id) gamAccountCount,"+
		"COALESCE((SELECT group_concat(cd.domain,', ') FROM channel_domains cd WHERE cd.channel_id=r.channel_id),'') assignedDomains "+
		"FROM users u LEFT JOIN channel_registrations r ON r.user_id=u.id LEFT JOIN channels c ON c.id=r.channel_id "+
		"LEFT JOIN channel_registration_contracts co ON co.registration_id=r.id WHERE u.role='channel' AND (r.id IS NOT NULL OR u.status='pending') "+
		"ORDER BY u.id DESC LIMIT 300")
	if err != nil {
		writeError(w, 500, "channel_registrations_unavailable")
		return
	}
	for _, item := range items {
		if intMap(item, "id") < 1 {
			item["domains"] = []any{}
			continue
		}
		domains, queryErr := queryMaps(a.db, "SELECT d.id,d.domain,d.adx_txt adxTxt,d.status,d.gam_account_id gamAccountId,COALESCE(s.name,'') accountName,COALESCE(lm.channel_id,cd.channel_id) currentChannelId,COALESCE(c.name,'') currentChannelName FROM channel_registration_domains d LEFT JOIN soap_accounts s ON s.id=d.gam_account_id LEFT JOIN link_metadata lm ON lower(lm.domain)=lower(d.domain) LEFT JOIN channel_domains cd ON lower(cd.domain)=lower(d.domain) LEFT JOIN channels c ON c.id=COALESCE(lm.channel_id,cd.channel_id) WHERE d.registration_id=? ORDER BY d.domain", item["id"])
		if queryErr != nil {
			writeError(w, 500, "channel_registration_domains_unavailable")
			return
		}
		item["domains"] = domains
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": items})
}

func (a *app) channelRegistrationDetail(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	registration, found := a.one("SELECT r.*,u.email,u.status userStatus,co.version contractVersion,co.contract_text contractText,co.contract_hash contractHash,co.signer_name signerName,co.signer_title signerTitle,co.signature_data signatureData,co.signature_hash signatureHash,co.signed_at signedAt,co.signer_ip signerIP,co.user_agent userAgent,co.counter_signer counterSigner,co.countersigned_at countersignedAt FROM channel_registrations r JOIN users u ON u.id=r.user_id LEFT JOIN channel_registration_contracts co ON co.registration_id=r.id WHERE r.id=?", id)
	if !found {
		writeError(w, 404, "channel_registration_not_found")
		return
	}
	domains, err := queryMaps(a.db, "SELECT id,domain,adx_txt adxTxt,status,gam_account_id gamAccountId FROM channel_registration_domains WHERE registration_id=? ORDER BY domain", id)
	if err != nil {
		writeError(w, 500, "channel_registration_domains_unavailable")
		return
	}
	registration["domains"] = domains
	writeJSON(w, 200, map[string]any{"ok": true, "item": registration})
}

type approvedRegistrationDomain struct {
	Domain    string
	AccountID int64
}

func parseApprovedRegistrationDomains(input map[string]any) ([]approvedRegistrationDomain, error) {
	values := array(input["domains"])
	if len(values) > 20 {
		return nil, errors.New("invalid_registration_domains")
	}
	out, seen := make([]approvedRegistrationDomain, 0, len(values)), map[string]bool{}
	for _, value := range values {
		item := object(value)
		domain, err := gamSiteDomain(fieldString(item, "domain"))
		accountID := fieldID(item, "gamAccountId")
		if err != nil || accountID < 1 || seen[domain] {
			return nil, errors.New("invalid_registration_domains")
		}
		seen[domain] = true
		out = append(out, approvedRegistrationDomain{Domain: domain, AccountID: accountID})
	}
	return out, nil
}

func (a *app) approveChannelRegistration(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id := pathID(r)
	domains, err := parseApprovedRegistrationDomains(input)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	share, valid := validShare(input, "sharePercent")
	name := strings.TrimSpace(fieldString(input, "channelName"))
	effective := fieldString(input, "effectiveFrom")
	reviewerName := strings.TrimSpace(fieldString(input, "reviewerSignatureName"))
	reviewerTitle := strings.TrimSpace(fieldString(input, "reviewerSignatureTitle"))
	reviewerAccepted, _ := input["reviewerAccepted"].(bool)
	if name == "" || len(name) > 200 || !valid || !validDate(effective) ||
		!reviewerAccepted || reviewerName != currentUser(r).Name ||
		len(reviewerTitle) < 2 || len(reviewerTitle) > 150 {
		writeError(w, 400, "invalid_channel_registration_approval")
		return
	}
	reviewerSignature, reviewerSignatureHash, err := parseRegistrationSignature(fieldString(input, "reviewerSignatureData"))
	if err != nil {
		writeError(w, 400, "invalid_reviewer_signature")
		return
	}
	reg, found := a.one("SELECT r.id,r.user_id,r.company_name,r.contact_name,u.email,r.status,u.status user_status FROM channel_registrations r JOIN users u ON u.id=r.user_id WHERE r.id=?", id)
	if !found {
		writeError(w, 404, "channel_registration_not_found")
		return
	}
	if fieldString(reg, "status") != "signed" || fieldString(reg, "user_status") != "pending" {
		writeError(w, 409, "channel_registration_not_reviewable")
		return
	}
	requestedRows, err := queryMaps(a.db, "SELECT id,domain,adx_txt FROM channel_registration_domains WHERE registration_id=?", id)
	if err != nil {
		writeError(w, 500, "channel_registration_domains_unavailable")
		return
	}
	requested := map[string]map[string]any{}
	for _, row := range requestedRows {
		requested[strings.ToLower(fieldString(row, "domain"))] = row
	}
	if len(domains) != len(requested) {
		writeError(w, 400, "approval_requires_all_registration_domains")
		return
	}
	for _, chosen := range domains {
		if _, exists := requested[strings.ToLower(chosen.Domain)]; !exists {
			writeError(w, 400, "approval_domain_not_requested")
			return
		}
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, 500, "channel_registration_approval_failed")
		return
	}
	defer tx.Rollback()
	for _, chosen := range domains {
		request, exists := requested[strings.ToLower(chosen.Domain)]
		if !exists || strings.TrimSpace(fieldString(request, "adx_txt")) == "" {
			writeError(w, 400, "approval_domain_or_adx_txt_missing")
			return
		}
		account, lookupErr := firstMap(tx, "SELECT id,network_code,name,status,enabled FROM soap_accounts WHERE id=?", chosen.AccountID)
		if lookupErr != nil || account == nil || fieldString(account, "status") != "active" || intMap(account, "enabled") != 1 {
			writeError(w, 400, "invalid_registration_gam_account")
			return
		}
		prefix := "gam-rest:" + fieldString(account, "network_code") + ":%"
		var known int
		knownErr := tx.QueryRowContext(r.Context(), "SELECT 1 FROM link_metadata WHERE network_code=? AND lower(domain)=lower(?) UNION SELECT 1 FROM revenue_facts WHERE source_file LIKE ? AND (lower(domain)=lower(?) OR lower(url)=lower(?)) LIMIT 1",
			fieldString(account, "network_code"), chosen.Domain, prefix, chosen.Domain, chosen.Domain).Scan(&known)
		if knownErr == sql.ErrNoRows {
			writeError(w, 400, "registration_domain_not_in_selected_gam_account")
			return
		}
		if knownErr != nil {
			writeError(w, 500, "registration_domain_validation_failed")
			return
		}
	}
	created, err := tx.ExecContext(r.Context(), "INSERT INTO channels(name,email,share_percent,status,internal_only) VALUES(?,?,?,'active',0)",
		name, strings.ToLower(fieldString(reg, "email")), share)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, 409, "registration_email_unavailable")
		} else {
			writeError(w, 500, "channel_creation_failed")
		}
		return
	}
	channelID, _ := created.LastInsertId()
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?)", channelID, share, "1900-01-01", currentUser(r).Email); err != nil {
		writeError(w, 500, "channel_share_setup_failed")
		return
	}
	if effective != "1900-01-01" {
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?)", channelID, share, effective, currentUser(r).Email); err != nil {
			writeError(w, 500, "channel_share_setup_failed")
			return
		}
	}
	signed, signedErr := firstMap(tx, "SELECT id,version FROM channel_registration_contracts WHERE registration_id=? ORDER BY id DESC LIMIT 1", id)
	if signedErr != nil || signed == nil {
		writeError(w, 409, "channel_registration_contract_not_signed")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, chosen := range domains {
		request := requested[strings.ToLower(chosen.Domain)]
		account, _ := firstMap(tx, "SELECT network_code FROM soap_accounts WHERE id=?", chosen.AccountID)
		network := fieldString(account, "network_code")
		if _, err = tx.ExecContext(r.Context(), "DELETE FROM channel_domains WHERE lower(domain)=lower(?)", chosen.Domain); err != nil {
			writeError(w, 500, "channel_domain_assignment_failed")
			return
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO channel_domains(channel_id,domain,gam_account_id,adx_txt) VALUES(?,?,?,?)",
			channelID, chosen.Domain, chosen.AccountID, fieldString(request, "adx_txt")); err != nil {
			writeError(w, 500, "channel_domain_assignment_failed")
			return
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO gam_domain_channel_assignments(root_domain,channel_id,effective_from,created_by) VALUES(?,?,?,?) ON CONFLICT(root_domain,effective_from) DO UPDATE SET channel_id=excluded.channel_id,created_by=excluded.created_by",
			chosen.Domain, channelID, effective, currentUser(r).Email); err != nil {
			writeError(w, 500, "channel_domain_assignment_failed")
			return
		}
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO link_metadata(network_code,domain,is_manual,monitor_domains_json,channel_id,notes,updated_by) VALUES(?,?,0,'[]',?,'',?) ON CONFLICT(network_code,domain) DO UPDATE SET channel_id=excluded.channel_id,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP",
			network, chosen.Domain, channelID, currentUser(r).Email); err != nil {
			writeError(w, 500, "channel_domain_link_failed")
			return
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE channel_registration_domains SET channel_id=?,gam_account_id=?,status='approved',approved_at=? WHERE registration_id=? AND lower(domain)=lower(?)",
			channelID, chosen.AccountID, now, id, chosen.Domain); err != nil {
			writeError(w, 500, "channel_registration_domain_update_failed")
			return
		}
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE users SET channel_id=?,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND role='channel'", channelID, reg["user_id"]); err != nil {
		writeError(w, 500, "channel_user_activation_failed")
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE channel_registrations SET status='approved',channel_id=?,reviewer_id=?,reviewer_signature=?,reviewed_at=?,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='signed'",
		channelID, currentUser(r).ID, currentUser(r).Name, now, strings.TrimSpace(fieldString(input, "reviewNote")), id); err != nil {
		writeError(w, 500, "channel_registration_approval_failed")
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE channel_registration_contracts SET counter_signer=?,counter_signer_title=?,counter_signature_data=?,counter_signature_hash=?,countersigned_at=? WHERE id=?",
		currentUser(r).Name, reviewerTitle, reviewerSignature, reviewerSignatureHash, now, signed["id"]); err != nil {
		writeError(w, 500, "channel_contract_countersign_failed")
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, 500, "channel_registration_approval_failed")
		return
	}
	a.audit(currentUser(r).Email, "channel.registration_approved", "channel_registration", id,
		marshalText(map[string]any{"channelId": channelID, "domains": domains, "sharePercent": share, "effectiveFrom": effective, "contractVersion": signed["version"]}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "channelId": channelID})
}

func (a *app) rejectChannelRegistration(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	note := strings.TrimSpace(fieldString(input, "reviewNote"))
	if len(note) < 3 || len(note) > 1000 {
		writeError(w, 400, "registration_review_note_required")
		return
	}
	id := pathID(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, 500, "channel_registration_rejection_failed")
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), "UPDATE channel_registrations SET status='rejected',reviewer_id=?,reviewer_signature=?,reviewed_at=?,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='signed'",
		currentUser(r).ID, currentUser(r).Name, time.Now().UTC().Format(time.RFC3339Nano), note, id)
	if err != nil {
		writeError(w, 500, "channel_registration_rejection_failed")
		return
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		writeError(w, 409, "channel_registration_not_reviewable")
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, 500, "channel_registration_rejection_failed")
		return
	}
	a.audit(currentUser(r).Email, "channel.registration_rejected", "channel_registration", id, marshalText(map[string]string{"note": note}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}
