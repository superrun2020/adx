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
	ID       int64
	Domain   string
	Old, New regressionMeasure
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
	if raw, exists := input["signingSecret"]; exists {
		value, valid := raw.(string)
		if !valid || len(value) > 500 {
			return errors.New("invalid_feishu_secret")
		}
		secret["secret"] = strings.TrimSpace(value)
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
	where, args := []string{"1=1"}, []any{}
	if start != "" {
		where = append(where, "e.period_end>=?")
		args = append(args, start)
	}
	if end != "" {
		where = append(where, "e.period_end<=?")
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
	rows, err := queryMaps(a.db, "SELECT e.id,e.cadence,e.period_start periodStart,e.period_end periodEnd,e.domain,s.name accountName,s.network_code networkCode,s.rest_network_timezone timeZone,e.old_revenue oldRevenue,e.new_revenue newRevenue,(e.new_revenue-e.old_revenue) revenueDelta,CASE WHEN e.old_revenue>0 THEN ROUND((e.new_revenue-e.old_revenue)*100.0/e.old_revenue,4) ELSE 0 END differencePercent,(e.new_requests-e.old_requests) requestsDelta,(e.new_impressions-e.old_impressions) impressionsDelta,(e.new_clicks-e.old_clicks) clicksDelta,e.alert_status alertStatus,e.alert_error alertError,e.notified_at notifiedAt,e.created_at createdAt FROM regression_events e JOIN soap_accounts s ON s.id=e.soap_account_id WHERE "+condition+" ORDER BY e.id DESC LIMIT 100 OFFSET ?", append(args, (page-1)*100)...)
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

func (a *app) saveRegressionRun(ctx context.Context, account map[string]any, window regressionWindow, status, detail string, old, newer map[string]regressionMeasure) ([]regressionAlert, error) {
	config, err := a.currentRegressionConfig()
	if err != nil {
		return nil, err
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
		if alertQualified(before, after, config) {
			if !config.Enabled || config.Ciphertext == "" {
				alertStatus = "disabled"
			} else {
				var sent int
				err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM regression_events WHERE soap_account_id=? AND cadence=? AND period_start=? AND period_end=? AND domain=? AND alert_status='sent'", intMap(account, "id"), window.Cadence, window.Start, window.End, domain).Scan(&sent)
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
		inserted, insertErr := tx.ExecContext(ctx, "INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks,alert_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", runID, intMap(account, "id"), window.Cadence, window.Start, window.End, domain, before.Revenue, after.Revenue, before.Requests, after.Requests, before.Impressions, after.Impressions, before.Clicks, after.Clicks, alertStatus)
		if insertErr != nil {
			return nil, insertErr
		}
		if alertStatus == "pending" {
			id, idErr := inserted.LastInsertId()
			if idErr != nil {
				return nil, idErr
			}
			alerts = append(alerts, regressionAlert{ID: id, Domain: domain, Old: before, New: after})
		}
	}
	return alerts, tx.Commit()
}

func (a *app) runRegressionForAccount(ctx context.Context, account map[string]any) {
	if _, err := a.db.ExecContext(ctx, "DELETE FROM regression_runs WHERE (cadence='day' AND finished_at<datetime('now','-90 days')) OR (cadence<>'day' AND finished_at<datetime('now','-365 days'))"); err != nil {
		log.Printf("regression_retention_failed: %v", err)
	}
	zone := importString(account["rest_network_timezone"])
	for _, item := range regressionCadences {
		window, err := regressionWindowAt(zone, time.Now(), item.Name)
		if err != nil {
			log.Printf("regression_timezone_invalid account=%d error=%v", intMap(account, "id"), err)
			return
		}
		if item.Days == 1 {
			today, readErr := a.regressionFacts(ctx, account, window.Start, window.End)
			if readErr != nil {
				a.recordRegressionFailure(account, window, readErr)
				continue
			}
			if len(today) == 0 {
				date, _ := time.Parse("2006-01-02", window.Start)
				window.Start = date.AddDate(0, 0, -1).Format("2006-01-02")
				window.End = window.Start
			}
		}
		if !a.regressionDue(intMap(account, "id"), window) {
			continue
		}
		var old map[string]regressionMeasure
		if item.Days == 1 {
			old, err = a.previousDailySnapshot(intMap(account, "id"), window)
		} else {
			var result map[string]any
			result, err = a.executeGam(ctx, account, window.BaselineStart, window.BaselineEnd, true)
			var covered int
			if err == nil && result["rows"].(int) > 0 {
				covered, err = a.regressionCoveredDays(ctx, account, window.BaselineStart, window.BaselineEnd)
			}
			if err == nil && covered == item.Days {
				old, err = a.regressionFacts(ctx, account, window.BaselineStart, window.BaselineEnd)
			}
			if err == nil && len(old) == 0 {
				_, err = a.saveRegressionRun(ctx, account, window, "skipped", "基准时间段没有完整的逐日域名数据", nil, nil)
			}
			if err == nil && len(old) == 0 {
				continue
			}
		}
		if err != nil {
			a.recordRegressionFailure(account, window, err)
			continue
		}
		if item.Days > 1 {
			result, fetchErr := a.executeGam(ctx, account, window.Start, window.End, true)
			if fetchErr != nil {
				a.recordRegressionFailure(account, window, fetchErr)
				continue
			}
			covered, coverageErr := a.regressionCoveredDays(ctx, account, window.Start, window.End)
			if coverageErr != nil {
				a.recordRegressionFailure(account, window, coverageErr)
				continue
			}
			if result["rows"].(int) == 0 || covered != item.Days {
				_, _ = a.saveRegressionRun(ctx, account, window, "skipped", "当前时间段没有完整的逐日域名数据", nil, nil)
				continue
			}
		}
		newer, err := a.regressionFacts(ctx, account, window.Start, window.End)
		if err != nil {
			a.recordRegressionFailure(account, window, err)
			continue
		}
		if len(newer) == 0 {
			_, _ = a.saveRegressionRun(ctx, account, window, "skipped", "当前时间段没有可比较的域名数据", nil, nil)
			continue
		}
		alerts, err := a.saveRegressionRun(ctx, account, window, "success", "", old, newer)
		if err != nil {
			log.Printf("regression_save_failed account=%d cadence=%s error=%v", intMap(account, "id"), item.Name, err)
			continue
		}
		if len(alerts) > 0 {
			a.deliverRegressionAlerts(ctx, account, window, alerts)
		}
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
	for begin := 0; begin < len(alerts); begin += 20 {
		end := begin + 20
		if end > len(alerts) {
			end = len(alerts)
		}
		batch := alerts[begin:end]
		lines := []string{fmt.Sprintf("AdX 数据回退监测：%s (%s)，%s 至 %s", importString(account["name"]), window.Cadence, window.Start, window.End)}
		for _, alert := range batch {
			lines = append(lines, fmt.Sprintf("%s：$%.2f → $%.2f，下降 %.2f%%；请求 %+d，展示 %+d，点击 %+d", alert.Domain, alert.Old.Revenue, alert.New.Revenue, (alert.Old.Revenue-alert.New.Revenue)*100/alert.Old.Revenue, alert.New.Requests-alert.Old.Requests, alert.New.Impressions-alert.Old.Impressions, alert.New.Clicks-alert.Old.Clicks))
		}
		err = postFeishu(ctx, webhook, signingSecret, strings.Join(lines, "\n"))
		status, detail := "sent", ""
		if err != nil {
			status, detail = "failed", err.Error()
			if len(detail) > 500 {
				detail = detail[:500]
			}
		}
		for _, alert := range batch {
			_, updateErr := a.db.Exec("UPDATE regression_events SET alert_status=?,alert_error=?,notified_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?", status, detail, status, alert.ID)
			if updateErr != nil {
				log.Printf("regression_alert_status_failed id=%d error=%v", alert.ID, updateErr)
			}
		}
		if err != nil {
			log.Printf("regression_feishu_failed account=%d cadence=%s error=%v", intMap(account, "id"), window.Cadence, err)
		}
	}
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
		return err
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
