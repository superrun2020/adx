package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type regressionMeasure struct {
	Revenue     float64
	Requests    int64
	Impressions int64
	Clicks      int64
}

type regressionDailyKey struct {
	Date, Domain string
}

type pausedRevenue struct {
	Before, After float64
}

type regressionWindow struct {
	Cadence, Start, End, BaselineStart, BaselineEnd string
	Interval                                        time.Duration
}

type regressionConfig struct {
	Enabled                    bool
	MinRevenue, MinDropPercent float64
	Ciphertext                 string
}

type regressionAlert struct {
	ID            int64
	Domain        string
	DropStartDate string
	DetectedAtUTC string
	PauseExcluded bool
	Old, New      regressionMeasure
}

var regressionCadences = []struct {
	Name     string
	Days     int
	Interval time.Duration
}{
	{"day", 1, 15 * time.Minute},
	{"three_days", 3, 24 * time.Hour},
	{"week", 7, 72 * time.Hour},
	{"month", 30, 168 * time.Hour},
}

// Windows are calculated in the individual GAM network's timezone. Longer
// windows exclude the incomplete current day and compare equal-length periods.
func regressionWindowAt(zone string, now time.Time, cadence string) (regressionWindow, error) {
	for _, item := range regressionCadences {
		if item.Name != cadence {
			continue
		}
		endOffset := -1
		if item.Days == 1 {
			endOffset = 0
		}
		start, err := localGamDateAt(zone, now, endOffset-item.Days+1)
		if err != nil {
			return regressionWindow{}, err
		}
		end, err := localGamDateAt(zone, now, endOffset)
		if err != nil {
			return regressionWindow{}, err
		}
		window := regressionWindow{Cadence: cadence, Start: start, End: end, Interval: item.Interval}
		if item.Days > 1 {
			window.BaselineStart, err = localGamDateAt(zone, now, endOffset-2*item.Days+1)
			if err != nil {
				return regressionWindow{}, err
			}
			window.BaselineEnd, err = localGamDateAt(zone, now, endOffset-item.Days)
			if err != nil {
				return regressionWindow{}, err
			}
		}
		return window, nil
	}
	return regressionWindow{}, errors.New("invalid_regression_cadence")
}

func (a *app) currentRegressionConfig() (regressionConfig, error) {
	var enabled int
	var c regressionConfig
	err := a.db.QueryRow("SELECT feishu_enabled,min_revenue,min_drop_percent,webhook_ciphertext FROM regression_settings WHERE id=1").Scan(&enabled, &c.MinRevenue, &c.MinDropPercent, &c.Ciphertext)
	c.Enabled = enabled == 1
	return c, err
}

func (a *app) regressionSettings(w http.ResponseWriter, _ *http.Request) {
	c, err := a.currentRegressionConfig()
	if err != nil {
		writeError(w, 500, "regression_settings_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "settings": map[string]any{
		"feishuEnabled": c.Enabled, "minRevenue": c.MinRevenue,
		"minDropPercent": c.MinDropPercent, "webhookConfigured": c.Ciphertext != "",
	}})
}

func validFeishuWebhook(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Hostname() != "open.feishu.cn" && u.Hostname() != "open.larksuite.com" {
		return false
	}
	return u.Port() == "" && strings.HasPrefix(u.Path, "/open-apis/bot/v2/hook/") && len(u.Path) > len("/open-apis/bot/v2/hook/")
}

func (a *app) updateRegressionSettings(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	enabled, ok := input["feishuEnabled"].(bool)
	if !ok {
		return errors.New("invalid_regression_enabled")
	}
	minRevenue, okRevenue := fieldFloat(input, "minRevenue")
	minPercent, okPercent := fieldFloat(input, "minDropPercent")
	if !okRevenue || !okPercent || minRevenue < 0 || minRevenue > 1000000000 || minPercent <= 0 || minPercent > 100 {
		return errors.New("invalid_regression_threshold")
	}
	c, err := a.currentRegressionConfig()
	if err != nil {
		return err
	}
	secret := map[string]any{"url": "", "secret": ""}
	if c.Ciphertext != "" {
		secret, err = a.decryptCredential(c.Ciphertext)
		if err != nil {
			return err
		}
	}
	if clear, _ := input["clearWebhook"].(bool); clear {
		secret = map[string]any{"url": "", "secret": ""}
	}
	if raw, exists := input["webhook"]; exists && strings.TrimSpace(fmt.Sprint(raw)) != "" {
		candidate, valid := raw.(string)
		if !valid || !validFeishuWebhook(strings.TrimSpace(candidate)) {
			return errors.New("invalid_feishu_webhook")
		}
		secret["url"] = strings.TrimSpace(candidate)
	}
	if clear, _ := input["clearSigningSecret"].(bool); clear {
		secret["secret"] = ""
	}
	if raw, exists := input["signingSecret"]; exists {
		value, valid := raw.(string)
		if !valid || len(value) > 500 {
			return errors.New("invalid_feishu_secret")
		}
		if strings.TrimSpace(value) != "" {
			secret["secret"] = strings.TrimSpace(value)
		}
	}
	webhook := importString(secret["url"])
	if webhook != "" && !validFeishuWebhook(webhook) {
		return errors.New("invalid_feishu_webhook")
	}
	if enabled && webhook == "" {
		return errors.New("invalid_feishu_webhook_required")
	}
	ciphertext := ""
	if webhook != "" {
		ciphertext, err = a.encryptCredential(secret)
		if err != nil {
			return err
		}
	}
	flag := 0
	if enabled {
		flag = 1
	}
	_, err = a.db.ExecContext(r.Context(), "UPDATE regression_settings SET feishu_enabled=?,min_revenue=?,min_drop_percent=?,webhook_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=1", flag, minRevenue, minPercent, ciphertext)
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "regression.settings_update", "regression_settings", 1, marshalText(map[string]any{"feishuEnabled": enabled, "minRevenue": minRevenue, "minDropPercent": minPercent, "webhookConfigured": webhook != ""}), clientIP(r))
	a.regressionSettings(w, r)
	return nil
}

func (a *app) regressionEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, end, cadence := q.Get("start"), q.Get("end"), q.Get("cadence")
	if (start != "" && !validDate(start)) || (end != "" && !validDate(end)) || (start != "" && end != "" && start > end) {
		writeError(w, 400, "invalid_report_date")
		return
	}
	if cadence != "" && cadence != "day" && cadence != "three_days" && cadence != "week" && cadence != "month" {
		writeError(w, 400, "invalid_regression_cadence")
		return
	}
	sortFields := map[string]string{
		"oldRevenue": "e.old_revenue", "newRevenue": "e.new_revenue",
		"revenueDelta":      "e.new_revenue-e.old_revenue",
		"differencePercent": "CASE WHEN e.old_revenue>0 THEN (e.new_revenue-e.old_revenue)*100.0/e.old_revenue ELSE 0 END",
		"requestsDelta":     "e.new_requests-e.old_requests",
		"impressionsDelta":  "e.new_impressions-e.old_impressions",
		"clicksDelta":       "e.new_clicks-e.old_clicks",
	}
	sortBy, sortDir := q.Get("sortBy"), q.Get("sortDir")
	if sortBy != "" || sortDir != "" {
		if sortFields[sortBy] == "" || (sortDir != "asc" && sortDir != "desc") {
			writeError(w, 400, "invalid_regression_sort")
			return
		}
	}
	where, args := []string{"1=1"}, []any{}
	if start != "" {
		where = append(where, "e.period_end>=?")
		args = append(args, start)
	}
	if end != "" {
		where = append(where, "e.period_start<=?")
		args = append(args, end)
	}
	if cadence != "" {
		where = append(where, "e.cadence=?")
		args = append(args, cadence)
	}
	if account := q.Get("accountId"); account != "" {
		id, err := strconv.ParseInt(account, 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_account_id")
			return
		}
		where = append(where, "e.soap_account_id=?")
		args = append(args, id)
	}
	if domain := strings.TrimSpace(q.Get("domain")); domain != "" {
		if len(domain) > 200 {
			writeError(w, 400, "invalid_domain_filter")
			return
		}
		where = append(where, "e.domain LIKE ?")
		args = append(args, "%"+domain+"%")
	}
	if q.Get("alertsOnly") == "1" {
		where = append(where, "e.alert_status IN ('sent','failed','duplicate','disabled','pending')")
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	if page > 10000 {
		page = 10000
	}
	condition := strings.Join(where, " AND ")
	var total int64
	if err := a.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM regression_events e WHERE "+condition, args...).Scan(&total); err != nil {
		writeError(w, 500, "regression_events_unavailable")
		return
	}
	order := "e.id DESC"
	if sortBy != "" {
		order = "(" + sortFields[sortBy] + ") " + strings.ToUpper(sortDir) + "," + order
	}
	rows, err := queryMaps(a.db, "SELECT e.id,e.cadence,e.period_start periodStart,e.period_end periodEnd,r.baseline_start baselineStart,r.baseline_end baselineEnd,e.domain,s.name accountName,s.network_code networkCode,s.rest_network_timezone timeZone,CASE WHEN e.cadence='day' AND e.alert_status<>'not_triggered' THEN e.period_start ELSE e.drop_start_date END dropStartDate,e.old_revenue oldRevenue,e.new_revenue newRevenue,(e.new_revenue-e.old_revenue) revenueDelta,CASE WHEN e.old_revenue>0 THEN ROUND((e.new_revenue-e.old_revenue)*100.0/e.old_revenue,4) ELSE 0 END differencePercent,(e.new_requests-e.old_requests) requestsDelta,(e.new_impressions-e.old_impressions) impressionsDelta,(e.new_clicks-e.old_clicks) clicksDelta,e.alert_status alertStatus,e.alert_error alertError,e.notified_at notifiedAt,e.created_at createdAt FROM regression_events e JOIN regression_runs r ON r.id=e.run_id JOIN soap_accounts s ON s.id=e.soap_account_id WHERE "+condition+" ORDER BY "+order+" LIMIT 100 OFFSET ?", append(args, (page-1)*100)...)
	if err != nil {
		writeError(w, 500, "regression_events_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows, "total": total, "page": page, "pageSize": 100})
}

func (a *app) regressionRuns(w http.ResponseWriter, r *http.Request) {
	rows, err := queryMaps(a.db, "SELECT r.id,r.cadence,r.period_start periodStart,r.period_end periodEnd,r.baseline_start baselineStart,r.baseline_end baselineEnd,r.status,r.detail,r.started_at startedAt,r.finished_at finishedAt,s.name accountName,s.rest_network_timezone timeZone FROM regression_runs r JOIN soap_accounts s ON s.id=r.soap_account_id ORDER BY r.id DESC LIMIT 60")
	if err != nil {
		writeError(w, 500, "regression_runs_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows})
}

func (a *app) regressionDue(accountID int64, window regressionWindow) bool {
	var latest sql.NullString
	query := "SELECT MAX(finished_at) FROM regression_runs WHERE soap_account_id=? AND cadence=? AND status IN ('success','skipped')"
	args := []any{accountID, window.Cadence}
	if window.Cadence == "day" {
		query += " AND period_start=?"
		args = append(args, window.Start)
	}
	err := a.db.QueryRow(query, args...).Scan(&latest)
	if err != nil || !latest.Valid {
		return true
	}
	last, err := time.ParseInLocation("2006-01-02 15:04:05", latest.String, time.UTC)
	return err != nil || !last.After(time.Now().Add(-window.Interval+time.Minute))
}

func (a *app) regressionFacts(ctx context.Context, account map[string]any, start, end string) (map[string]regressionMeasure, error) {
	channelID, key, err := a.gamMapping(account)
	if err != nil {
		return nil, err
	}
	rows, err := a.db.QueryContext(ctx, "SELECT domain,SUM(revenue),SUM(requests),SUM(impressions),SUM(clicks) FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ? GROUP BY domain", channelID, key, start, end, "gam-rest:"+importString(account["network_code"])+":%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]regressionMeasure{}
	for rows.Next() {
		var domain string
		var m regressionMeasure
		if err := rows.Scan(&domain, &m.Revenue, &m.Requests, &m.Impressions, &m.Clicks); err != nil {
			return nil, err
		}
		result[domain] = m
	}
	return result, rows.Err()
}

// Only ad units archived through this site can be attributed to a deliberate pause.
// The GAM report's AD_UNIT_ID is the numeric tail of the audited resource name.
func (a *app) pausedAdUnitRevenue(ctx context.Context, account map[string]any, window regressionWindow) (map[string]pausedRevenue, error) {
	result := map[string]pausedRevenue{}
	if window.Cadence == "day" || window.BaselineStart == "" {
		return result, nil
	}
	network, zone := importString(account["network_code"]), importString(account["rest_network_timezone"])
	location, err := time.LoadLocation(zone)
	if err != nil {
		return nil, err
	}
	logs, err := a.db.QueryContext(ctx, "SELECT action,detail,created_at FROM audit_logs WHERE target_id=? AND action IN ('gam.ad_unit_archive','gam.ad_unit_activate') ORDER BY id", network)
	if err != nil {
		return nil, err
	}
	states := map[string]bool{}
	for logs.Next() {
		var action, detail, createdAt string
		if err = logs.Scan(&action, &detail, &createdAt); err != nil {
			break
		}
		instant, parseErr := time.Parse("2006-01-02 15:04:05", createdAt)
		if parseErr != nil {
			continue
		}
		localDay := instant.In(location).Format("2006-01-02")
		if localDay < window.BaselineStart || localDay > window.End {
			continue
		}
		var entry struct{ Names []string }
		if json.Unmarshal([]byte(detail), &entry) != nil {
			continue
		}
		prefix := "networks/" + network + "/adUnits/"
		for _, name := range entry.Names {
			if !strings.HasPrefix(name, prefix) {
				continue
			}
			id := strings.TrimPrefix(name, prefix)
			if _, parseErr = strconv.ParseUint(id, 10, 64); parseErr == nil {
				states[id] = action == "gam.ad_unit_archive"
			}
		}
	}
	if rowsErr := logs.Err(); err == nil {
		err = rowsErr
	}
	logs.Close()
	if err != nil {
		return nil, err
	}
	paused := map[string]bool{}
	for id, archived := range states {
		if archived {
			paused[id] = true
		}
	}
	if len(paused) == 0 {
		return result, nil
	}
	channelID, key, err := a.gamMapping(account)
	if err != nil {
		return nil, err
	}
	rows, err := a.db.QueryContext(ctx, "SELECT domain,ad_unit_id,SUM(CASE WHEN report_date BETWEEN ? AND ? THEN revenue ELSE 0 END),SUM(CASE WHEN report_date BETWEEN ? AND ? THEN revenue ELSE 0 END) FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND ad_unit_id<>'' AND source_file LIKE ? GROUP BY domain,ad_unit_id", window.BaselineStart, window.BaselineEnd, window.Start, window.End, channelID, key, window.BaselineStart, window.End, "gam-rest:"+network+":%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var domain, unitID string
		var before, after float64
		if err = rows.Scan(&domain, &unitID, &before, &after); err != nil {
			return nil, err
		}
		if paused[unitID] {
			item := result[domain]
			item.Before += before
			item.After += after
			result[domain] = item
		}
	}
	return result, rows.Err()
}

func excludePausedRevenue(before, after regressionMeasure, paused pausedRevenue) (regressionMeasure, regressionMeasure, bool) {
	if paused.Before <= paused.After || paused.Before < 0 || paused.After < 0 ||
		paused.Before > before.Revenue+0.000001 || paused.After > after.Revenue+0.000001 {
		return before, after, false
	}
	before.Revenue -= paused.Before
	after.Revenue -= paused.After
	return before, after, true
}

func (a *app) regressionDailyFacts(ctx context.Context, account map[string]any, start, end string) (map[regressionDailyKey]regressionMeasure, error) {
	channelID, key, err := a.gamMapping(account)
	if err != nil {
		return nil, err
	}
	rows, err := a.db.QueryContext(ctx, "SELECT report_date,domain,SUM(revenue),SUM(requests),SUM(impressions),SUM(clicks) FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ? GROUP BY report_date,domain", channelID, key, start, end, "gam-rest:"+importString(account["network_code"])+":%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[regressionDailyKey]regressionMeasure{}
	for rows.Next() {
		var date, domain string
		var m regressionMeasure
		if err := rows.Scan(&date, &domain, &m.Revenue, &m.Requests, &m.Impressions, &m.Clicks); err != nil {
			return nil, err
		}
		result[regressionDailyKey{date, domain}] = m
	}
	return result, rows.Err()
}

func (a *app) priorRegressionDailyFacts(ctx context.Context, accountID int64, start, end string, maxRunID int64) (map[regressionDailyKey]regressionMeasure, error) {
	rows, err := a.db.QueryContext(ctx, "SELECT report_date,domain,revenue,requests,impressions,clicks FROM regression_daily_snapshots WHERE soap_account_id=? AND report_date BETWEEN ? AND ? AND run_id<=? ORDER BY run_id DESC", accountID, start, end, maxRunID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[regressionDailyKey]regressionMeasure{}
	for rows.Next() {
		var date, domain string
		var m regressionMeasure
		if err := rows.Scan(&date, &domain, &m.Revenue, &m.Requests, &m.Impressions, &m.Clicks); err != nil {
			return nil, err
		}
		key := regressionDailyKey{date, domain}
		if _, exists := result[key]; !exists {
			result[key] = m
		}
	}
	return result, rows.Err()
}

func firstRegressionDropDate(domain string, window regressionWindow, newer, previous map[regressionDailyKey]regressionMeasure) string {
	first := ""
	coveredDates := map[string]bool{}
	for key := range newer {
		coveredDates[key.Date] = true
	}
	for key, before := range previous {
		if key.Domain != domain || key.Date < window.Start || key.Date > window.End || !coveredDates[key.Date] {
			continue
		}
		if after := newer[key]; before.Revenue-after.Revenue > 0.000001 && (first == "" || key.Date < first) {
			first = key.Date
		}
	}
	return first
}

func (a *app) regressionCoveredDays(ctx context.Context, account map[string]any, start, end string) (int, error) {
	channelID, key, err := a.gamMapping(account)
	if err != nil {
		return 0, err
	}
	var days int
	err = a.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT report_date) FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND domain<>'' AND source_file LIKE ?", channelID, key, start, end, "gam-rest:"+importString(account["network_code"])+":%").Scan(&days)
	return days, err
}

func (a *app) previousDailySnapshot(accountID int64, window regressionWindow) (map[string]regressionMeasure, error) {
	var runID int64
	err := a.db.QueryRow("SELECT id FROM regression_runs WHERE soap_account_id=? AND cadence='day' AND period_start=? AND status='success' ORDER BY id DESC LIMIT 1", accountID, window.Start).Scan(&runID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := a.db.Query("SELECT domain,revenue,requests,impressions,clicks FROM regression_snapshots WHERE run_id=?", runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]regressionMeasure{}
	for rows.Next() {
		var domain string
		var m regressionMeasure
		if err := rows.Scan(&domain, &m.Revenue, &m.Requests, &m.Impressions, &m.Clicks); err != nil {
			return nil, err
		}
		result[domain] = m
	}
	return result, rows.Err()
}

func alertQualified(old, newer regressionMeasure, config regressionConfig) bool {
	return old.Revenue > config.MinRevenue && old.Revenue > 0 &&
		(old.Revenue-newer.Revenue)*100/old.Revenue >= config.MinDropPercent-1e-9
}

func measureChanged(old, newer regressionMeasure) bool {
	return math.Abs(old.Revenue-newer.Revenue) > 0.000001 || old.Requests != newer.Requests || old.Impressions != newer.Impressions || old.Clicks != newer.Clicks
}

func (a *app) saveRegressionRun(ctx context.Context, account map[string]any, window regressionWindow, status, detail string, old, newer map[string]regressionMeasure, priorRunCutoff ...int64) ([]regressionAlert, error) {
	config, err := a.currentRegressionConfig()
	if err != nil {
		return nil, err
	}
	pausedByDomain := map[string]pausedRevenue{}
	if status == "success" && old != nil && window.Cadence != "day" {
		pausedByDomain, err = a.pausedAdUnitRevenue(ctx, account, window)
		if err != nil {
			return nil, err
		}
	}
	daily := map[regressionDailyKey]regressionMeasure{}
	previousDaily := map[regressionDailyKey]regressionMeasure{}
	if status == "success" && intMap(account, "rest_channel_id") > 0 && intMap(account, "rest_upstream_account_id") > 0 {
		cutoff := int64(1<<63 - 1)
		if len(priorRunCutoff) > 0 {
			cutoff = priorRunCutoff[0]
		}
		daily, err = a.regressionDailyFacts(ctx, account, window.Start, window.End)
		if err != nil {
			return nil, err
		}
		previousDaily, err = a.priorRegressionDailyFacts(ctx, intMap(account, "id"), window.Start, window.End, cutoff)
		if err != nil {
			return nil, err
		}
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "INSERT INTO regression_runs(soap_account_id,cadence,period_start,period_end,baseline_start,baseline_end,status,detail) VALUES(?,?,?,?,?,?,?,?)", intMap(account, "id"), window.Cadence, window.Start, window.End, window.BaselineStart, window.BaselineEnd, status, detail)
	if err != nil {
		return nil, err
	}
	runID, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	if status != "success" {
		return nil, tx.Commit()
	}
	for domain, m := range newer {
		_, err = tx.ExecContext(ctx, "INSERT INTO regression_snapshots(run_id,domain,revenue,requests,impressions,clicks) VALUES(?,?,?,?,?,?)", runID, domain, m.Revenue, m.Requests, m.Impressions, m.Clicks)
		if err != nil {
			return nil, err
		}
	}
	for key, m := range daily {
		_, err = tx.ExecContext(ctx, "INSERT INTO regression_daily_snapshots(run_id,soap_account_id,report_date,domain,revenue,requests,impressions,clicks) VALUES(?,?,?,?,?,?,?,?)", runID, intMap(account, "id"), key.Date, key.Domain, m.Revenue, m.Requests, m.Impressions, m.Clicks)
		if err != nil {
			return nil, err
		}
	}
	if old == nil {
		return nil, tx.Commit()
	}
	keys := make(map[string]bool, len(old)+len(newer))
	for domain := range old {
		keys[domain] = true
	}
	for domain := range newer {
		keys[domain] = true
	}
	domains := make([]string, 0, len(keys))
	for domain := range keys {
		domains = append(domains, domain)
	}
	sort.Strings(domains)
	alerts := []regressionAlert{}
	for _, domain := range domains {
		before, after := old[domain], newer[domain]
		if !measureChanged(before, after) {
			continue
		}
		alertStatus := "not_triggered"
		alertBefore, alertAfter, pauseExcluded := excludePausedRevenue(before, after, pausedByDomain[domain])
		if alertQualified(before, after, config) {
			if pauseExcluded && !alertQualified(alertBefore, alertAfter, config) {
				alertStatus = "paused_suppressed"
			} else if !config.Enabled || config.Ciphertext == "" {
				alertStatus = "disabled"
			} else {
				var sent int
				err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM regression_events WHERE soap_account_id=? AND cadence=? AND period_start=? AND period_end=? AND domain=? AND (alert_status='sent' OR (alert_status IN ('pending','failed') AND send_attempts<5))", intMap(account, "id"), window.Cadence, window.Start, window.End, domain).Scan(&sent)
				if err != nil {
					return nil, err
				}
				if sent > 0 {
					alertStatus = "duplicate"
				} else {
					alertStatus = "pending"
				}
			}
		}
		dropStartDate := ""
		if alertStatus != "not_triggered" {
			if window.Cadence == "day" {
				dropStartDate = window.Start
			} else {
				dropStartDate = firstRegressionDropDate(domain, window, daily, previousDaily)
			}
		}
		inserted, insertErr := tx.ExecContext(ctx, "INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks,alert_status,drop_start_date,alert_old_revenue,alert_new_revenue) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULLIF(?,''),?,?)", runID, intMap(account, "id"), window.Cadence, window.Start, window.End, domain, before.Revenue, after.Revenue, before.Requests, after.Requests, before.Impressions, after.Impressions, before.Clicks, after.Clicks, alertStatus, dropStartDate, alertBefore.Revenue, alertAfter.Revenue)
		if insertErr != nil {
			return nil, insertErr
		}
		if alertStatus == "pending" {
			id, idErr := inserted.LastInsertId()
			if idErr != nil {
				return nil, idErr
			}
			var detectedAt string
			if err = tx.QueryRowContext(ctx, "SELECT created_at FROM regression_events WHERE id=?", id).Scan(&detectedAt); err != nil {
				return nil, err
			}
			alerts = append(alerts, regressionAlert{ID: id, Domain: domain, DropStartDate: dropStartDate, DetectedAtUTC: detectedAt, PauseExcluded: pauseExcluded, Old: alertBefore, New: alertAfter})
		}
	}
	return alerts, tx.Commit()
}

func (a *app) runRegressionForAccount(ctx context.Context, account map[string]any) {
	if _, err := a.db.ExecContext(ctx, "DELETE FROM regression_runs WHERE (cadence='day' AND finished_at<datetime('now','-90 days')) OR (cadence<>'day' AND finished_at<datetime('now','-365 days'))"); err != nil {
		log.Printf("regression_retention_failed: %v", err)
	}
	a.retryRegressionAlerts(ctx, account)
	var priorRunCutoff int64
	if err := a.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id),0) FROM regression_runs").Scan(&priorRunCutoff); err != nil {
		log.Printf("regression_baseline_cutoff_failed account=%d error=%v", intMap(account, "id"), err)
		return
	}
	zone := importString(account["rest_network_timezone"])
	for _, item := range regressionCadences {
		window, err := regressionWindowAt(zone, time.Now(), item.Name)
		if err != nil {
			log.Printf("regression_timezone_invalid account=%d error=%v", intMap(account, "id"), err)
			return
		}
		if item.Days == 1 {
			yesterday := window
			date, _ := time.Parse("2006-01-02", window.Start)
			yesterday.Start = date.AddDate(0, 0, -1).Format("2006-01-02")
			yesterday.End = yesterday.Start
			a.runRegressionWindow(ctx, account, item.Days, window, priorRunCutoff)
			a.runRegressionWindow(ctx, account, item.Days, yesterday, priorRunCutoff)
		} else {
			a.runRegressionWindow(ctx, account, item.Days, window, priorRunCutoff)
		}
	}
}

func (a *app) runRegressionWindow(ctx context.Context, account map[string]any, days int, window regressionWindow, priorRunCutoff int64) {
	if !a.regressionDue(intMap(account, "id"), window) {
		return
	}
	if days == 1 {
		available, err := a.regressionFacts(ctx, account, window.Start, window.End)
		if err != nil {
			a.recordRegressionFailure(account, window, err)
			return
		}
		if len(available) == 0 {
			return
		}
	}
	var old map[string]regressionMeasure
	var err error
	if days == 1 {
		old, err = a.previousDailySnapshot(intMap(account, "id"), window)
	} else {
		var result map[string]any
		result, err = a.executeGam(ctx, account, window.BaselineStart, window.BaselineEnd, true)
		var covered int
		if err == nil && result["rows"].(int) > 0 {
			covered, err = a.regressionCoveredDays(ctx, account, window.BaselineStart, window.BaselineEnd)
		}
		if err == nil && covered == days {
			old, err = a.regressionFacts(ctx, account, window.BaselineStart, window.BaselineEnd)
		}
		if err == nil && len(old) == 0 {
			_, err = a.saveRegressionRun(ctx, account, window, "skipped", "基准时间段没有完整的逐日域名数据", nil, nil)
		}
		if err == nil && len(old) == 0 {
			return
		}
	}
	if err != nil {
		a.recordRegressionFailure(account, window, err)
		return
	}
	if days > 1 {
		result, fetchErr := a.executeGam(ctx, account, window.Start, window.End, true)
		if fetchErr != nil {
			a.recordRegressionFailure(account, window, fetchErr)
			return
		}
		covered, coverageErr := a.regressionCoveredDays(ctx, account, window.Start, window.End)
		if coverageErr != nil {
			a.recordRegressionFailure(account, window, coverageErr)
			return
		}
		if result["rows"].(int) == 0 || covered != days {
			_, _ = a.saveRegressionRun(ctx, account, window, "skipped", "当前时间段没有完整的逐日域名数据", nil, nil)
			return
		}
	}
	newer, err := a.regressionFacts(ctx, account, window.Start, window.End)
	if err != nil {
		a.recordRegressionFailure(account, window, err)
		return
	}
	if len(newer) == 0 {
		_, _ = a.saveRegressionRun(ctx, account, window, "skipped", "当前时间段没有可比较的域名数据", nil, nil)
		return
	}
	alerts, err := a.saveRegressionRun(ctx, account, window, "success", "", old, newer, priorRunCutoff)
	if err != nil {
		log.Printf("regression_save_failed account=%d cadence=%s error=%v", intMap(account, "id"), window.Cadence, err)
		return
	}
	if len(alerts) > 0 {
		a.deliverRegressionAlerts(ctx, account, window, alerts)
	}
}

// A persisted pending/failed alert must survive a restart or a temporary webhook outage.
// Sent alerts and old disabled alerts are never replayed.
func (a *app) retryRegressionAlerts(ctx context.Context, account map[string]any) {
	config, err := a.currentRegressionConfig()
	if err != nil || !config.Enabled || config.Ciphertext == "" {
		return
	}
	rows, err := a.db.QueryContext(ctx, "SELECT e.id,e.cadence,e.period_start,e.period_end,r.baseline_start,r.baseline_end,e.domain,e.old_revenue,e.new_revenue,e.old_requests,e.new_requests,e.old_impressions,e.new_impressions,e.old_clicks,e.new_clicks,COALESCE(e.drop_start_date,''),e.created_at,e.alert_old_revenue,e.alert_new_revenue FROM regression_events e JOIN regression_runs r ON r.id=e.run_id WHERE e.soap_account_id=? AND e.alert_status IN ('pending','failed') AND e.send_attempts<5 AND (e.last_attempt_at IS NULL OR e.last_attempt_at<=datetime('now','-15 minutes')) AND NOT EXISTS (SELECT 1 FROM regression_events sent WHERE sent.soap_account_id=e.soap_account_id AND sent.cadence=e.cadence AND sent.period_start=e.period_start AND sent.period_end=e.period_end AND sent.domain=e.domain AND sent.alert_status='sent') ORDER BY e.cadence,e.period_start,e.period_end,e.id DESC LIMIT 100", intMap(account, "id"))
	if err != nil {
		log.Printf("regression_retry_query_failed account=%d error=%v", intMap(account, "id"), err)
		return
	}
	type group struct {
		window regressionWindow
		alerts []regressionAlert
	}
	groups := []group{}
	seen := map[string]bool{}
	duplicates := []int64{}
	suppressed := []int64{}
	type pendingAlert struct {
		window             regressionWindow
		alert              regressionAlert
		alertOld, alertNew sql.NullFloat64
	}
	pending := []pendingAlert{}
	for rows.Next() {
		var item pendingAlert
		alert, window := &item.alert, &item.window
		if err = rows.Scan(&alert.ID, &window.Cadence, &window.Start, &window.End, &window.BaselineStart, &window.BaselineEnd, &alert.Domain, &alert.Old.Revenue, &alert.New.Revenue, &alert.Old.Requests, &alert.New.Requests, &alert.Old.Impressions, &alert.New.Impressions, &alert.Old.Clicks, &alert.New.Clicks, &alert.DropStartDate, &alert.DetectedAtUTC, &item.alertOld, &item.alertNew); err != nil {
			break
		}
		pending = append(pending, item)
	}
	if rowsErr := rows.Err(); err == nil {
		err = rowsErr
	}
	rows.Close()
	if err != nil {
		log.Printf("regression_retry_scan_failed account=%d error=%v", intMap(account, "id"), err)
		return
	}
	pausedCache := map[string]map[string]pausedRevenue{}
	for _, item := range pending {
		alert, window := item.alert, item.window
		if item.alertOld.Valid && item.alertNew.Valid {
			alert.PauseExcluded = item.alertOld.Float64 < alert.Old.Revenue-0.000001
			alert.Old.Revenue, alert.New.Revenue = item.alertOld.Float64, item.alertNew.Float64
		} else if window.Cadence != "day" {
			cacheKey := window.Cadence + "\x00" + window.Start + "\x00" + window.End
			paused, ok := pausedCache[cacheKey]
			if !ok {
				paused, err = a.pausedAdUnitRevenue(ctx, account, window)
				if err != nil {
					log.Printf("regression_retry_pause_check_failed account=%d error=%v", intMap(account, "id"), err)
					return
				}
				pausedCache[cacheKey] = paused
			}
			alert.Old, alert.New, alert.PauseExcluded = excludePausedRevenue(alert.Old, alert.New, paused[alert.Domain])
		}
		if alert.PauseExcluded && !alertQualified(alert.Old, alert.New, config) {
			suppressed = append(suppressed, alert.ID)
			continue
		}
		key := window.Cadence + "\x00" + window.Start + "\x00" + window.End + "\x00" + alert.Domain
		if seen[key] {
			duplicates = append(duplicates, alert.ID)
			continue
		}
		seen[key] = true
		if len(groups) == 0 || groups[len(groups)-1].window.Cadence != window.Cadence || groups[len(groups)-1].window.Start != window.Start || groups[len(groups)-1].window.End != window.End {
			groups = append(groups, group{window: window})
		}
		groups[len(groups)-1].alerts = append(groups[len(groups)-1].alerts, alert)
	}
	for _, id := range duplicates {
		if _, err := a.db.ExecContext(ctx, "UPDATE regression_events SET alert_status='duplicate' WHERE id=? AND alert_status IN ('pending','failed')", id); err != nil {
			log.Printf("regression_retry_dedup_failed id=%d error=%v", id, err)
		}
	}
	for _, id := range suppressed {
		if _, err := a.db.ExecContext(ctx, "UPDATE regression_events SET alert_status='paused_suppressed',alert_error='' WHERE id=? AND alert_status IN ('pending','failed')", id); err != nil {
			log.Printf("regression_retry_pause_failed id=%d error=%v", id, err)
		}
	}
	for _, item := range groups {
		a.deliverRegressionAlerts(ctx, account, item.window, item.alerts)
	}
}

func (a *app) recordRegressionFailure(account map[string]any, window regressionWindow, err error) {
	log.Printf("regression_failed account=%d cadence=%s error=%v", intMap(account, "id"), window.Cadence, err)
	detail := err.Error()
	if len(detail) > 500 {
		detail = detail[:500]
	}
	_, _ = a.saveRegressionRun(context.Background(), account, window, "failed", detail, nil, nil)
}

func (a *app) deliverRegressionAlerts(ctx context.Context, account map[string]any, window regressionWindow, alerts []regressionAlert) {
	config, err := a.currentRegressionConfig()
	if err != nil || !config.Enabled || config.Ciphertext == "" {
		return
	}
	credential, err := a.decryptCredential(config.Ciphertext)
	if err != nil {
		log.Printf("regression_webhook_decrypt_failed: %v", err)
		return
	}
	webhook, signingSecret := importString(credential["url"]), importString(credential["secret"])
	channelName := "未关联渠道"
	if err := a.db.QueryRowContext(ctx, "SELECT name FROM channels WHERE id=?", intMap(account, "rest_channel_id")).Scan(&channelName); err != nil && err != sql.ErrNoRows {
		log.Printf("regression_channel_lookup_failed account=%d error=%v", intMap(account, "id"), err)
	}
	zone := importString(account["rest_network_timezone"])
	location, zoneErr := time.LoadLocation(zone)
	if zoneErr != nil {
		location = time.UTC
		zone = "UTC"
	}
	sentAt := time.Now().In(location).Format("2006-01-02 15:04")
	cadenceName := map[string]string{"day": "单日快照", "three_days": "近 3 天", "week": "近 7 天", "month": "近 30 天"}[window.Cadence]
	for begin := 0; begin < len(alerts); begin += 20 {
		end := begin + 20
		if end > len(alerts) {
			end = len(alerts)
		}
		batch := alerts[begin:end]
		err = postFeishu(ctx, webhook, signingSecret, regressionAlertMessage(account, channelName, zone, sentAt, window, cadenceName, batch))
		status, detail := "sent", ""
		if err != nil {
			status, detail = "failed", err.Error()
			if len(detail) > 500 {
				detail = detail[:500]
			}
		}
		for _, alert := range batch {
			_, updateErr := a.db.Exec("UPDATE regression_events SET alert_status=?,alert_error=?,notified_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE NULL END,send_attempts=send_attempts+1,last_attempt_at=CURRENT_TIMESTAMP WHERE id=?", status, detail, status, alert.ID)
			if updateErr != nil {
				log.Printf("regression_alert_status_failed id=%d error=%v", alert.ID, updateErr)
			}
		}
		if err != nil {
			log.Printf("regression_feishu_failed account=%d cadence=%s error=%v", intMap(account, "id"), window.Cadence, err)
		}
	}
}

func regressionDetectionTime(value, zone string) string {
	instant, err := time.Parse("2006-01-02 15:04:05", value)
	if err != nil {
		return "未记录"
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		location = time.UTC
	}
	return instant.In(location).Format("2006-01-02 15:04")
}

func regressionAlertMessage(account map[string]any, channelName, zone, sentAt string, window regressionWindow, cadenceName string, alerts []regressionAlert) string {
	lines := []string{"【AdX 收入下降】", fmt.Sprintf("账号：%s（%s）", importString(account["name"]), importString(account["network_code"])), "渠道：" + channelName}
	for _, alert := range alerts {
		if len(lines) > 3 {
			lines = append(lines, "")
		}
		lines = append(lines, "域名："+alert.Domain)
		if window.Cadence == "day" {
			lines = append(lines, "数据日："+window.Start)
		} else {
			lines = append(lines, fmt.Sprintf("区间：%s 至 %s（对比 %s 至 %s）", window.Start, window.End, window.BaselineStart, window.BaselineEnd))
		}
		income := fmt.Sprintf("收入：$%.2f → $%.2f，少 $%.2f（%.2f%%）", alert.Old.Revenue, alert.New.Revenue, alert.Old.Revenue-alert.New.Revenue, (alert.Old.Revenue-alert.New.Revenue)*100/alert.Old.Revenue)
		if alert.PauseExcluded {
			income += "，已排除停投广告"
		}
		lines = append(lines, income)
		if window.Cadence != "day" && alert.DropStartDate != "" {
			lines = append(lines, "已确认下修日："+alert.DropStartDate)
		}
		lines = append(lines, fmt.Sprintf("发现：%s（%s）", regressionDetectionTime(alert.DetectedAtUTC, zone), zone))
	}
	return strings.Join(lines, "\n")
}

func postFeishu(ctx context.Context, webhook, secret, content string) error {
	if !validFeishuWebhook(webhook) {
		return errors.New("invalid_feishu_webhook")
	}
	payload := map[string]any{"msg_type": "text", "content": map[string]any{"text": content}}
	if secret != "" {
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
		payload["timestamp"] = timestamp
		payload["sign"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	}
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhook, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		// url.Error includes the webhook URL; never persist or log that secret.
		return errors.New("feishu_transport_failed")
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8192))
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("feishu_http_%d", res.StatusCode)
	}
	var response map[string]any
	if json.Unmarshal(body, &response) != nil || numberValue(response["code"]) != 0 || response["code"] == nil {
		return errors.New("feishu_rejected_message")
	}
	return nil
}
