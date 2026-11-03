package main

import (
	"net/http"
	"strconv"
	"strings"
)

func (a *app) upstreamAccounts(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT u.id,u.account_key accountKey,u.name,u.advertiser,u.bd,u.soap_account_id gamAccountId,s.name gamAccountName,s.network_code networkCode,u.share_percent sharePercent,u.status,u.created_at createdAt,u.updated_at updatedAt FROM upstream_accounts u LEFT JOIN soap_accounts s ON s.id=u.soap_account_id ORDER BY u.account_key")
}

func (a *app) createUpstreamAccount(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	key, name := fieldString(input, "accountKey"), fieldString(input, "name")
	if name == "" {
		name = key
	}
	share, valid := validShare(input, "sharePercent")
	gamID := fieldID(input, "gamAccountId")
	advertiser, bd := fieldString(input, "advertiser"), fieldString(input, "bd")
	if key == "" || name == "" || !valid || len(advertiser) > 200 || len(bd) > 200 ||
		(gamID > 0 && !a.exists("SELECT id FROM soap_accounts WHERE id=?", gamID)) {
		writeError(w, 400, "invalid_upstream_account")
		return
	}
	var gam any
	if gamID > 0 {
		gam = gamID
	}
	id, err := execID(a.db, "INSERT INTO upstream_accounts(account_key,name,soap_account_id,share_percent,advertiser,bd,status) VALUES(?,?,?,?,?,?,'active')", key, name, gam, share, advertiser, bd)
	if err != nil {
		writeError(w, 409, "account_exists")
		return
	}
	a.audit(currentUser(r).Email, "upstream_account.create", "upstream_account", id, marshalText(map[string]any{"accountKey": key, "name": name, "gamAccountId": gamID, "share": share, "advertiser": advertiser, "bd": bd}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	item, _ := a.one("SELECT id,account_key accountKey,name,advertiser,bd,soap_account_id gamAccountId,share_percent sharePercent,status FROM upstream_accounts WHERE id=?", id)
	writeJSON(w, 201, map[string]any{"ok": true, "item": item})
}

func (a *app) updateUpstreamAccount(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id := pathID(r)
	before, found := a.one("SELECT * FROM upstream_accounts WHERE id=?", id)
	if !found {
		writeError(w, 404, "upstream_account_not_found")
		return
	}
	name := fieldString(input, "name")
	share, valid := validShare(input, "sharePercent")
	status := "active"
	if fieldString(input, "status") == "disabled" {
		status = "disabled"
	}
	advertiser, bd := fieldString(input, "advertiser"), fieldString(input, "bd")
	if _, ok := input["advertiser"]; !ok {
		advertiser = strings.TrimSpace(fieldString(before, "advertiser"))
	}
	if _, ok := input["bd"]; !ok {
		bd = strings.TrimSpace(fieldString(before, "bd"))
	}
	if id == 0 || name == "" || !valid || len(advertiser) > 200 || len(bd) > 200 {
		writeError(w, 400, "invalid_upstream_account")
		return
	}
	var gam any = before["soap_account_id"]
	if _, set := input["gamAccountId"]; set {
		if parsed := fieldID(input, "gamAccountId"); parsed > 0 {
			gam = parsed
		} else {
			gam = nil
		}
	}
	if gam != nil && !a.exists("SELECT id FROM soap_accounts WHERE id=?", gam) {
		writeError(w, 400, "invalid_gam_account")
		return
	}
	_, err := a.db.Exec("UPDATE upstream_accounts SET name=?,soap_account_id=?,share_percent=?,advertiser=?,bd=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", name, gam, share, advertiser, bd, status, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if gam != before["soap_account_id"] || status != "active" {
		_, _ = a.db.Exec("UPDATE soap_accounts SET rest_sync_enabled=0 WHERE rest_upstream_account_id=?", id)
	}
	after, _ := a.one("SELECT id,account_key accountKey,name,advertiser,bd,soap_account_id gamAccountId,share_percent sharePercent,status FROM upstream_accounts WHERE id=?", id)
	a.audit(currentUser(r).Email, "upstream_account.update", "upstream_account", id, marshalText(map[string]any{"before": before, "after": after}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 200, map[string]any{"ok": true, "item": after})
}

func (a *app) adUnitDomains(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT id,ad_unit adUnit,domain,created_by createdBy,created_at createdAt,updated_at updatedAt FROM ad_unit_domains ORDER BY ad_unit")
}
func (a *app) createAdUnitDomain(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	unit, domain := fieldString(input, "adUnit"), normalizedDomain(fieldString(input, "domain"))
	if unit == "" || domain == "" {
		writeError(w, 400, "invalid_ad_unit_domain")
		return
	}
	id, err := execID(a.db, "INSERT INTO ad_unit_domains(ad_unit,domain,created_by) VALUES(?,?,?)", unit, domain, currentUser(r).Email)
	if err != nil {
		writeError(w, 409, "ad_unit_exists")
		return
	}
	a.audit(currentUser(r).Email, "ad_unit_domain.create", "ad_unit_domain", id, marshalText(map[string]string{"adUnit": unit, "domain": domain}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	item, _ := a.one("SELECT id,ad_unit adUnit,domain FROM ad_unit_domains WHERE id=?", id)
	writeJSON(w, 201, map[string]any{"ok": true, "item": item})
}
func (a *app) updateAdUnitDomain(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id, domain := pathID(r), normalizedDomain(fieldString(input, "domain"))
	if id == 0 || domain == "" {
		writeError(w, 400, "invalid_ad_unit_domain")
		return
	}
	before, found := a.one("SELECT * FROM ad_unit_domains WHERE id=?", id)
	if !found {
		writeError(w, 404, "ad_unit_domain_not_found")
		return
	}
	_, err := a.db.Exec("UPDATE ad_unit_domains SET domain=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", domain, id)
	if err != nil {
		serverError(w, err)
		return
	}
	after, _ := a.one("SELECT id,ad_unit adUnit,domain FROM ad_unit_domains WHERE id=?", id)
	a.audit(currentUser(r).Email, "ad_unit_domain.update", "ad_unit_domain", id, marshalText(map[string]any{"before": before, "after": after}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 200, map[string]any{"ok": true, "item": after})
}

func (a *app) shareRules(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.URL.Query().Get("channelId"), 10, 64)
	where := ""
	args := []any{}
	if id != 0 {
		where = "WHERE r.channel_id=?"
		args = append(args, id)
	}
	a.sendItems(w, "SELECT r.id,r.channel_id channelId,c.name channelName,r.scope_type scopeType,r.scope_value scopeValue,r.share_percent sharePercent,r.effective_from effectiveFrom,r.created_by createdBy FROM channel_share_rules r JOIN channels c ON c.id=r.channel_id "+where+" ORDER BY r.effective_from DESC,r.id DESC", args...)
}
func (a *app) createShareRule(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	channelID := fieldID(input, "channelId")
	scopeType, scopeValue := fieldString(input, "scopeType"), fieldString(input, "scopeValue")
	share, valid := validShare(input, "sharePercent")
	date := fieldString(input, "effectiveFrom")
	if date == "" {
		date = dateToday()
	}
	if channelID == 0 || (scopeType != "account" && scopeType != "ad_unit") || scopeValue == "" || !valid || !validDate(date) ||
		!a.exists("SELECT id FROM channels WHERE id=?", channelID) {
		writeError(w, 400, "invalid_share_rule")
		return
	}
	id, err := execID(a.db, "INSERT INTO channel_share_rules(channel_id,scope_type,scope_value,share_percent,effective_from,created_by) VALUES(?,?,?,?,?,?)", channelID, scopeType, scopeValue, share, date, currentUser(r).Email)
	if err != nil {
		writeError(w, 409, "share_rule_exists")
		return
	}
	a.audit(currentUser(r).Email, "share_rule.create", "share_rule", id, marshalText(input), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}

func (a *app) domainShareRules(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT r.id,r.upstream_account_id upstreamAccountId,u.name upstreamAccountName,r.channel_id channelId,c.name channelName,r.domain,r.share_percent sharePercent,r.effective_from effectiveFrom FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id JOIN channels c ON c.id=r.channel_id ORDER BY r.effective_from DESC,r.id DESC")
}
func (a *app) domainShareRuleInput(input map[string]any) (int64, int64, string, float64, string, bool) {
	upstreamID, channelID := fieldID(input, "upstreamAccountId"), fieldID(input, "channelId")
	domain := normalizedDomain(fieldString(input, "domain"))
	share, valid := validShare(input, "sharePercent")
	date := fieldString(input, "effectiveFrom")
	if date == "" {
		date = dateToday()
	}
	valid = valid && upstreamID > 0 && channelID > 0 && validDate(date) &&
		a.exists("SELECT id FROM upstream_accounts WHERE id=?", upstreamID) && a.exists("SELECT id FROM channels WHERE id=?", channelID)
	return upstreamID, channelID, domain, share, date, valid
}
func (a *app) createDomainShareRule(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	upstreamID, channelID, domain, share, date, valid := a.domainShareRuleInput(input)
	if !valid {
		writeError(w, 400, "invalid_domain_share_rule")
		return
	}
	id, err := execID(a.db, "INSERT INTO channel_domain_share_rules(upstream_account_id,channel_id,domain,share_percent,effective_from,created_by) VALUES(?,?,?,?,?,?)", upstreamID, channelID, domain, share, date, currentUser(r).Email)
	if err != nil {
		writeError(w, 409, "domain_share_rule_exists")
		return
	}
	a.audit(currentUser(r).Email, "domain_share_rule.create", "domain_share_rule", id, marshalText(input), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 201, map[string]any{"ok": true, "id": id})
}
func (a *app) updateDomainShareRule(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id := pathID(r)
	upstreamID, channelID, domain, share, date, valid := a.domainShareRuleInput(input)
	if id == 0 || !valid {
		writeError(w, 400, "invalid_domain_share_rule")
		return
	}
	before, found := a.one("SELECT * FROM channel_domain_share_rules WHERE id=?", id)
	if !found {
		writeError(w, 404, "domain_share_rule_not_found")
		return
	}
	_, err := a.db.Exec("UPDATE channel_domain_share_rules SET upstream_account_id=?,channel_id=?,domain=?,share_percent=?,effective_from=? WHERE id=?", upstreamID, channelID, domain, share, date, id)
	if err != nil {
		writeError(w, 409, "domain_share_rule_exists")
		return
	}
	a.audit(currentUser(r).Email, "domain_share_rule.update", "domain_share_rule", id, marshalText(map[string]any{"before": before, "after": input}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 200, map[string]any{"ok": true})
}
