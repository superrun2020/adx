package main

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
)

func (a *app) accountReport(w http.ResponseWriter, r *http.Request) {
	start, end := reportRange(r)
	filters := []string{"rf.report_date BETWEEN ? AND ?"}
	args := []any{start, end}
	channelID, _ := strconv.ParseInt(r.URL.Query().Get("channelId"), 10, 64)
	if channelID != 0 {
		filters = append(filters, "rf.channel_id=?")
		args = append(args, channelID)
	}
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if account == "" {
		account = strings.TrimSpace(r.URL.Query().Get("upstreamAccount"))
	}
	if account != "" {
		filters = append(filters, "lower(rf.account)=lower(?)")
		args = append(args, account)
	}
	if unit := strings.TrimSpace(r.URL.Query().Get("adUnit")); unit != "" {
		filters = append(filters, "lower(rf.ad_unit)=lower(?)")
		args = append(args, unit)
	}
	if domain := strings.TrimSpace(r.URL.Query().Get("domain")); domain != "" {
		filters = append(filters, "lower("+mappedDomainSQL("rf")+")=lower(?)")
		args = append(args, normalizedDomain(domain))
	}
	if channel := strings.TrimSpace(r.URL.Query().Get("channel")); channel != "" {
		filters = append(filters, "lower(c.name)=lower(?)")
		args = append(args, channel)
	}
	upstream := upstreamShareSQL("rf")
	query := "SELECT rf.account account,COALESCE(NULLIF(MAX(ua.name),''),rf.account) accountName," +
		"COUNT(DISTINCT rf.channel_id) channelCount,COUNT(DISTINCT rf.ad_unit) adUnitCount,COUNT(DISTINCT " + mappedDomainSQL("rf") + ") domainCount," +
		"SUM(rf.requests) requests,SUM(rf.matched_requests) matchedRequests,SUM(rf.impressions) impressions,SUM(rf.clicks) clicks," +
		"ROUND(SUM(rf.revenue),6) revenue,ROUND(SUM(rf.revenue*(" + upstream + ")/100.0),6) upstreamRevenue," +
		"ROUND(SUM(" + settledRevenueSQL("rf") + "),6) channelRevenue,ROUND(AVG(" + upstream + "),2) upstreamSharePercent," +
		"ROUND(AVG(" + channelRuleShareSQL("rf") + "),2) channelSharePercent FROM revenue_facts rf " +
		"LEFT JOIN upstream_accounts ua ON lower(ua.account_key)=lower(rf.account) AND ua.status='active' " +
		"LEFT JOIN channels c ON c.id=rf.channel_id WHERE " + strings.Join(filters, " AND ") + " GROUP BY rf.account ORDER BY revenue DESC,rf.account LIMIT 5000"
	rows, err := queryMaps(a.db, query, args...)
	if err != nil {
		log.Printf("account_report_failed: %v", err)
		writeError(w, 500, "internal_error")
		return
	}
	for _, row := range rows {
		addAccountMetrics(row)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "range": map[string]string{"start": start, "end": end}, "items": rows})
}

func addAccountMetrics(row map[string]any) {
	requests, matched, impressions := numberValue(row["requests"]), numberValue(row["matchedRequests"]), numberValue(row["impressions"])
	revenue, upstream, channel := numberValue(row["revenue"]), numberValue(row["upstreamRevenue"]), numberValue(row["channelRevenue"])
	row["matchRate"] = ratio(matched*100, requests)
	row["ecpm"] = ratio(revenue*1000, impressions)
	row["upstreamEcpm"] = ratio(upstream*1000, impressions)
	row["channelEcpm"] = ratio(channel*1000, impressions)
	row["grossProfit"] = upstream*0.85 - channel
}

func (a *app) reportAPIKeys(w http.ResponseWriter, r *http.Request) {
	rows, err := queryMaps(a.db, "SELECT id,name,key_prefix keyPrefix,scope,status,created_by createdBy,created_at createdAt,revoked_at revokedAt FROM report_api_keys ORDER BY id DESC")
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows})
}

func (a *app) createReportAPIKey(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	name := fieldString(input, "name")
	if len(name) > 120 {
		name = name[:120]
	}
	if name == "" {
		writeError(w, 400, "key_name_required")
		return
	}
	secret, err := newSecret("adx_account_", 32)
	if err != nil {
		serverError(w, err)
		return
	}
	prefix := secret[:24]
	id, err := execID(a.db, "INSERT INTO report_api_keys(name,key_prefix,key_hash,created_by) VALUES(?,?,?,?)", name, prefix, sha256Hex(secret), currentUser(r).Email)
	if err != nil {
		serverError(w, err)
		return
	}
	a.audit(currentUser(r).Email, "report_api_key.create", "report_api_key", id, marshalText(map[string]any{"name": name, "scope": "account_reports_read"}), clientIP(r))
	writeJSON(w, 201, map[string]any{"ok": true, "item": map[string]any{"id": id, "name": name, "keyPrefix": prefix, "scope": "account_reports_read", "status": "active"}, "key": secret})
}

func (a *app) revokeReportAPIKey(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if id == 0 {
		writeError(w, 400, "invalid_key_id")
		return
	}
	changed, err := updated(a.db, "UPDATE report_api_keys SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'", id)
	if err != nil {
		serverError(w, err)
		return
	}
	if !changed {
		writeError(w, 404, "active_key_not_found")
		return
	}
	a.audit(currentUser(r).Email, "report_api_key.revoke", "report_api_key", id, "", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "revoked": true})
}

func (a *app) publicAccountReport(w http.ResponseWriter, r *http.Request) {
	secret := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if secret == "" {
		writeError(w, 401, "report_api_key_required")
		return
	}
	row, err := firstMap(a.db, "SELECT id,scope,status FROM report_api_keys WHERE key_hash=?", sha256Hex(secret))
	if err != nil || row["scope"] != "account_reports_read" || row["status"] != "active" {
		writeError(w, 401, "invalid_report_api_key")
		return
	}
	start, end := reportRange(r)
	filters := []string{"rf.report_date BETWEEN ? AND ?"}
	args := []any{start, end}
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if account == "" {
		account = strings.TrimSpace(r.URL.Query().Get("upstreamAccount"))
	}
	if account != "" {
		filters = append(filters, "lower(rf.account)=lower(?)")
		args = append(args, account)
	}
	channelID, _ := strconv.ParseInt(r.URL.Query().Get("channelId"), 10, 64)
	if channelID != 0 {
		filters = append(filters, "rf.channel_id=?")
		args = append(args, channelID)
	}
	upstream := upstreamShareSQL("rf")
	query := "SELECT rf.report_date date,rf.account account,COALESCE(NULLIF(MAX(ua.name),''),rf.account) accountName," +
		"SUM(rf.requests) requests,SUM(rf.matched_requests) matchedRequests,SUM(rf.impressions) impressions,SUM(rf.clicks) clicks," +
		"ROUND(SUM(rf.revenue),6) revenue,ROUND(SUM(rf.revenue*(" + upstream + ")/100.0),6) upstreamRevenue," +
		"ROUND(SUM(" + settledRevenueSQL("rf") + "),6) channelRevenue FROM revenue_facts rf " +
		"LEFT JOIN upstream_accounts ua ON lower(ua.account_key)=lower(rf.account) AND ua.status='active' WHERE " + strings.Join(filters, " AND ") +
		" GROUP BY rf.report_date,rf.account ORDER BY rf.report_date DESC,revenue DESC LIMIT 10000"
	rows, err := queryMaps(a.db, query, args...)
	if err != nil {
		serverError(w, err)
		return
	}
	for _, item := range rows {
		addAccountMetrics(item)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "range": map[string]string{"start": start, "end": end}, "items": rows})
}

func reportKeyLabel(id int64) string { return fmt.Sprint(id) }
