package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
)

const gamAccountColumns = "id,name,network_code networkCode,account_email accountEmail,advertiser,bd,advertiser_share_percent advertiserSharePercent,operation_status operationStatus,enabled,notes,CASE WHEN length(credential_ciphertext)>0 THEN 1 ELSE 0 END credentialConfigured,status,last_test_at lastTestAt,last_test_status lastTestStatus,last_test_summary lastTestSummary,rest_report_name reportName,rest_channel_id channelId,rest_upstream_account_id upstreamAccountId,rest_money_divisor moneyDivisor,rest_sync_enabled syncEnabled,rest_last_preview_at lastPreviewAt,rest_last_preview_rows lastPreviewRows,rest_network_timezone timeZone,created_at createdAt"

type gamMetadata struct {
	email, advertiser, bd, operation, notes string
	share                                   float64
	enabled                                 int
}

func parseGamMetadata(input map[string]any) (gamMetadata, error) {
	meta := gamMetadata{email: fieldString(input, "accountEmail"), advertiser: fieldString(input, "advertiser"), bd: fieldString(input, "bd"), operation: fieldString(input, "operationStatus"), notes: fieldString(input, "notes"), enabled: 1}
	if meta.operation == "" {
		meta.operation = "unknown"
	}
	if meta.email != "" {
		parsed, err := mail.ParseAddress(meta.email)
		if err != nil || parsed.Address != meta.email {
			return meta, errors.New("invalid_gam_account_email")
		}
	}
	if len(meta.advertiser) > 200 || len(meta.bd) > 200 || len(meta.notes) > 2000 || (meta.operation != "normal" && meta.operation != "limited" && meta.operation != "unknown") {
		return meta, errors.New("invalid_gam_account_metadata")
	}
	if value, exists := input["advertiserSharePercent"]; exists && value != nil {
		var ok bool
		meta.share, ok = fieldFloat(input, "advertiserSharePercent")
		if !ok || meta.share < 0 || meta.share > 100 {
			return meta, errors.New("invalid_gam_account_share")
		}
	}
	if value, exists := input["enabled"]; exists {
		flag, ok := value.(bool)
		if !ok {
			return meta, errors.New("invalid_gam_account_enabled")
		}
		if !flag {
			meta.enabled = 0
		}
	}
	return meta, nil
}

func (a *app) gamAccount(id int64) (map[string]any, error) {
	if id < 1 {
		return nil, errors.New("gam_account_not_found")
	}
	account, err := firstMap(a.db, "SELECT * FROM soap_accounts WHERE id=?", id)
	if err != nil {
		return nil, errors.New("gam_account_not_found")
	}
	return account, nil
}
func (a *app) publicGamAccount(id int64) map[string]any {
	account, _ := firstMap(a.db, "SELECT "+gamAccountColumns+" FROM soap_accounts WHERE id=?", id)
	return account
}
func (a *app) gamAccounts(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT "+gamAccountColumns+" FROM soap_accounts ORDER BY id DESC")
}
func (a *app) createGamAccount(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	name, network := fieldString(input, "name"), fieldString(input, "networkCode")
	credentials := object(input["credentials"])
	if name == "" || len(name) > 200 || !networkPattern.MatchString(network) || credentials == nil || importString(credentials["client_email"]) == "" || importString(credentials["private_key"]) == "" {
		return errors.New("invalid_gam_account")
	}
	meta, err := parseGamMetadata(input)
	if err != nil {
		return err
	}
	cipher, err := a.encryptCredential(credentials)
	if err != nil {
		return err
	}
	_, err = a.db.ExecContext(r.Context(), "INSERT INTO soap_accounts(name,network_code,credential_ciphertext,account_email,advertiser,bd,advertiser_share_percent,operation_status,enabled,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(network_code) DO UPDATE SET name=excluded.name,credential_ciphertext=excluded.credential_ciphertext,status='untested',last_test_at=NULL,last_test_status=NULL,last_test_summary='',rest_report_name='',rest_sync_enabled=0,rest_last_preview_at=NULL,rest_last_preview_rows=0,updated_at=CURRENT_TIMESTAMP", name, network, cipher, meta.email, meta.advertiser, meta.bd, meta.share, meta.operation, meta.enabled, meta.notes, currentUser(r).Email)
	if err != nil {
		return err
	}
	saved, err := firstMap(a.db, "SELECT id FROM soap_accounts WHERE network_code=?", network)
	if err != nil {
		return err
	}
	id := intMap(saved, "id")
	a.audit(currentUser(r).Email, "gam_account.save", "gam_account", id, marshalText(map[string]any{"name": name, "networkCode": network}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "item": a.publicGamAccount(id)})
	return nil
}
func (a *app) updateGamAccount(w http.ResponseWriter, r *http.Request) error {
	before, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	name, network := fieldString(input, "name"), fieldString(input, "networkCode")
	if name == "" || len(name) > 200 || !networkPattern.MatchString(network) {
		return errors.New("invalid_gam_account")
	}
	if network != importString(before["network_code"]) {
		return errors.New("invalid_gam_network_change")
	}
	if a.exists("SELECT id FROM soap_accounts WHERE network_code=? AND id<>?", network, intMap(before, "id")) {
		return errors.New("duplicate_gam_network_code")
	}
	meta, err := parseGamMetadata(input)
	if err != nil {
		return err
	}
	cipher := importString(before["credential_ciphertext"])
	reset := false
	if raw, exists := input["credentials"]; exists {
		credentials := object(raw)
		if credentials == nil || importString(credentials["client_email"]) == "" || importString(credentials["private_key"]) == "" {
			return errors.New("invalid_gam_account_credentials")
		}
		cipher, err = a.encryptCredential(credentials)
		if err != nil {
			return err
		}
		reset = true
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), "UPDATE soap_accounts SET name=?,network_code=?,account_email=?,advertiser=?,bd=?,advertiser_share_percent=?,operation_status=?,enabled=?,notes=?,credential_ciphertext=?,rest_sync_enabled=CASE WHEN ?=1 OR ?=0 THEN 0 ELSE rest_sync_enabled END,updated_at=CURRENT_TIMESTAMP WHERE id=?", name, network, meta.email, meta.advertiser, meta.bd, meta.share, meta.operation, meta.enabled, meta.notes, cipher, reset, meta.enabled, intMap(before, "id"))
	if err != nil {
		return err
	}
	if reset {
		_, err = tx.ExecContext(r.Context(), "UPDATE soap_accounts SET status='untested',last_test_at=NULL,last_test_status=NULL,last_test_summary='',rest_report_name='',rest_last_preview_at=NULL,rest_last_preview_rows=0 WHERE id=?", intMap(before, "id"))
		if err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam_account.update", "gam_account", intMap(before, "id"), marshalText(map[string]any{"name": name, "networkCode": network, "enabled": meta.enabled, "connectionReset": reset}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "item": a.publicGamAccount(intMap(before, "id"))})
	return nil
}
func (a *app) testGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	id := intMap(account, "id")
	network, err := a.gamNetwork(r.Context(), account)
	if err != nil {
		detail := err.Error()
		if len(detail) > 500 {
			detail = detail[:500]
		}
		_, _ = a.db.Exec("UPDATE soap_accounts SET status='error',rest_sync_enabled=0,last_test_at=CURRENT_TIMESTAMP,last_test_status='failed',last_test_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", detail, id)
		a.audit(currentUser(r).Email, "gam_account.test", "gam_account", id, detail, clientIP(r))
		return err
	}
	label := importString(network["displayName"])
	if label == "" {
		label = importString(network["name"])
	}
	_, err = a.db.ExecContext(r.Context(), "UPDATE soap_accounts SET status='active',last_test_at=CURRENT_TIMESTAMP,last_test_status='success',last_test_summary=?,rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", "连接成功："+label, network["timeZone"], id)
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam_account.test", "gam_account", id, "success", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "network": network, "item": a.publicGamAccount(id)})
	return nil
}
func (a *app) reportGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" {
		return errors.New("invalid_gam_account_status")
	}
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	channelID, upstreamID, divisor := fieldID(input, "channelId"), fieldID(input, "upstreamAccountId"), int64(numberValue(input["moneyDivisor"]))
	if channelID == 0 || upstreamID == 0 {
		return errors.New("invalid_rest_report_mapping")
	}
	configured, err := a.configureGam(r.Context(), account, channelID, upstreamID, divisor, currentUser(r).Email)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "configured": configured, "item": a.publicGamAccount(intMap(account, "id"))})
	return nil
}
func (a *app) previewGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" {
		return errors.New("invalid_gam_account_status")
	}
	input, ok := optionalBodyMap(w, r)
	if !ok {
		return nil
	}
	preview, err := a.executeGam(r.Context(), account, fieldString(input, "start"), fieldString(input, "end"), false)
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam.report_preview", "gam_account", intMap(account, "id"), marshalText(map[string]any{"start": preview["start"], "end": preview["end"], "rows": preview["rows"], "revenue": preview["revenue"]}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "preview": preview, "item": a.publicGamAccount(intMap(account, "id"))})
	return nil
}
func (a *app) activateGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" {
		return errors.New("invalid_gam_account_status")
	}
	if err = a.activateGam(account, currentUser(r).Email); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "item": a.publicGamAccount(intMap(account, "id"))})
	return nil
}
func (a *app) pauseGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if err = a.pauseGam(account, currentUser(r).Email); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "item": a.publicGamAccount(intMap(account, "id"))})
	return nil
}
func (a *app) syncGamAccount(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" || intMap(account, "rest_sync_enabled") != 1 || intMap(account, "enabled") != 1 {
		return errors.New("invalid_gam_account_status")
	}
	input, ok := optionalBodyMap(w, r)
	if !ok {
		return nil
	}
	result, err := a.executeGam(r.Context(), account, fieldString(input, "start"), fieldString(input, "end"), true)
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam.sync_manual", "gam_account", intMap(account, "id"), marshalText(map[string]any{"start": result["start"], "end": result["end"], "rows": result["rows"]}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "result": result})
	return nil
}
func (a *app) gamSyncRuns(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT r.id,r.soap_account_id gamAccountId,s.name gamAccountName,r.window_start windowStart,r.window_end windowEnd,r.status,r.stage,r.rows_read rowsRead,r.rows_written rowsWritten,r.timings_json timingsJson,r.error,r.started_at startedAt,r.finished_at finishedAt FROM soap_sync_runs r JOIN soap_accounts s ON s.id=r.soap_account_id ORDER BY r.id DESC LIMIT 100")
}
func (a *app) listGamAccountAdUnits(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" {
		return errors.New("invalid_gam_account_status")
	}
	query := r.URL.Query()
	search := strings.TrimSpace(query.Get("search"))
	statuses := strings.Split(query.Get("statuses"), ",")
	filters := make([]string, 0)
	if len(search) > 100 {
		return errors.New("invalid_ad_unit_filter")
	}
	for _, status := range statuses {
		if status != "" && status != "ACTIVE" && status != "INACTIVE" {
			return errors.New("invalid_ad_unit_filter")
		}
	}
	if search != "" {
		encoded, _ := json.Marshal("*" + strings.ReplaceAll(search, "*", "") + "*")
		filters = append(filters, "displayName = "+string(encoded))
	}
	chosen := make([]string, 0)
	for _, status := range statuses {
		if status != "" {
			chosen = append(chosen, status)
		}
	}
	if len(chosen) == 1 {
		filters = append(filters, "status = "+chosen[0])
	}
	if len(chosen) >= 2 {
		filters = append(filters, "status != ARCHIVED")
	}
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return err
	}
	network := importString(account["network_code"])
	values := url.Values{"pageSize": {"100"}}
	if page := query.Get("pageToken"); page != "" {
		values.Set("pageToken", page)
	}
	if len(filters) > 0 {
		values.Set("filter", strings.Join(filters, " AND "))
	}
	result, err := a.gamRequest(r.Context(), network, token, "networks/"+network+"/adUnits", http.MethodGet, values, nil)
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0)
	for _, value := range array(result["adUnits"]) {
		unit := object(value)
		sizes := unit["adUnitSizes"]
		if sizes == nil {
			sizes = []any{}
		}
		items = append(items, map[string]any{"name": unit["name"], "displayName": unit["displayName"], "adUnitCode": unit["adUnitCode"], "parentAdUnit": unit["parentAdUnit"], "status": unit["status"], "adUnitSizes": sizes})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": items, "nextPageToken": importString(result["nextPageToken"])})
	return nil
}
func (a *app) listGamAccountSites(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		writeError(w, 404, "gam_account_not_found")
		return nil
	}
	if account["status"] != "active" {
		return errors.New("invalid_gam_account_status")
	}
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return err
	}
	network := importString(account["network_code"])
	values := url.Values{"pageSize": {"100"}}
	if page := r.URL.Query().Get("pageToken"); page != "" {
		values.Set("pageToken", page)
	}
	result, err := a.gamRequest(r.Context(), network, token, "networks/"+network+"/sites", http.MethodGet, values, nil)
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0)
	for _, value := range array(result["sites"]) {
		site := object(value)
		items = append(items, map[string]any{"name": site["name"], "url": site["url"], "approvalStatus": site["approvalStatus"], "childNetworkCode": site["childNetworkCode"]})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": items, "nextPageToken": importString(result["nextPageToken"])})
	return nil
}
