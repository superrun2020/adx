package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type botReportSender func(context.Context, string, string, string) error

func botReportDate(now time.Time) (string, bool) {
	zone, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return "", false
	}
	local := now.In(zone)
	minutes := local.Hour()*60 + local.Minute()
	if minutes >= 23*60+45 {
		return local.Format("2006-01-02"), true
	}
	// A short catch-up window covers a restart shortly after midnight.
	if minutes < 6*60 {
		return local.AddDate(0, 0, -1).Format("2006-01-02"), true
	}
	return "", false
}

func botReportScheduledInstant(date string) time.Time {
	zone, _ := time.LoadLocation("Asia/Shanghai")
	instant, _ := time.ParseInLocation("2006-01-02 15:04", date+" 23:45", zone)
	return instant
}

func (a *app) botReportConfig() (bool, string, error) {
	var enabled int
	var ciphertext string
	err := a.db.QueryRow("SELECT enabled,webhook_ciphertext FROM bot_report_settings WHERE id=1").Scan(&enabled, &ciphertext)
	return enabled == 1, ciphertext, err
}

func (a *app) botReportLast() any {
	rows, err := queryMaps(a.db, "SELECT report_date reportDate,status,attempts,last_attempt_at lastAttemptAt,sent_at sentAt,error FROM bot_report_deliveries ORDER BY report_date DESC LIMIT 1")
	if err != nil || len(rows) == 0 {
		return nil
	}
	return rows[0]
}

func (a *app) botReportAccountTotals(date, source string) (map[string]any, error) {
	return firstMap(a.db, "SELECT COUNT(*) rows,COALESCE(SUM(rf.revenue),0) grossRevenue,"+
		"COALESCE(SUM(rf.revenue*("+upstreamShareSQL("rf")+")/100.0),0) upstreamRevenue,"+
		"COALESCE(SUM("+settledRevenueSQL("rf")+"),0) channelRevenue,"+
		"MAX(rf.imported_at) lastImport FROM revenue_facts rf "+
		"WHERE rf.report_date=? AND rf.source_file LIKE ?", date, source)
}

func (a *app) botReportTotalsAt(now time.Time) (map[string]any, error) {
	accounts, err := queryMaps(a.db, "SELECT name,network_code,rest_network_timezone FROM soap_accounts WHERE status='active' AND rest_sync_enabled=1 AND enabled=1 ORDER BY id")
	if err != nil {
		return nil, err
	}
	result := map[string]any{"rows": float64(0), "grossRevenue": float64(0), "upstreamRevenue": float64(0),
		"channelRevenue": float64(0), "lastImport": nil}
	items := make([]map[string]any, 0, len(accounts))
	for _, account := range accounts {
		zone := importString(account["rest_network_timezone"])
		if _, zoneErr := time.LoadLocation(zone); zone == "" || zoneErr != nil {
			zone = "UTC"
		}
		date, dateErr := localGamDateAt(zone, now, 0)
		if dateErr != nil {
			return nil, dateErr
		}
		code := importString(account["network_code"])
		row, queryErr := a.botReportAccountTotals(date, "gam-rest:"+code+":%")
		if queryErr != nil {
			return nil, queryErr
		}
		for _, key := range []string{"rows", "grossRevenue", "upstreamRevenue", "channelRevenue"} {
			result[key] = numberValue(result[key]) + numberValue(row[key])
		}
		if last := importString(row["lastImport"]); last > importString(result["lastImport"]) {
			result["lastImport"] = last
		}
		items = append(items, map[string]any{"name": account["name"], "networkCode": code,
			"timeZone": zone, "date": date, "rows": numberValue(row["rows"]),
			"revenue": numberValue(row["grossRevenue"]),
			"profit":  numberValue(row["upstreamRevenue"])*0.85 - numberValue(row["channelRevenue"])})
	}
	result["accounts"] = items
	return result, nil
}

func botReportMessage(date string, now time.Time, totals map[string]any) string {
	zone, _ := time.LoadLocation("Asia/Shanghai")
	stamp := now.In(zone).Format("2006-01-02 15:04")
	lines := []string{"【AdX 每日经营汇报】", "汇报批次：" + date + "（北京时间）",
		"统计时间：" + stamp + "（Asia/Shanghai）"}
	if numberValue(totals["rows"]) == 0 {
		lines = append(lines, "暂无已同步的 GAM REST 明细，流水和利润暂不可确认。")
	} else {
		gross := numberValue(totals["grossRevenue"])
		profit := numberValue(totals["upstreamRevenue"])*0.85 - numberValue(totals["channelRevenue"])
		lines = append(lines, fmt.Sprintf("流水（GAM REST 原始收入）：$%.2f", gross),
			fmt.Sprintf("利润（上游分成后收入 × 85%% − 渠道结算）：$%.2f", profit),
			fmt.Sprintf("已同步明细：%.0f 条", numberValue(totals["rows"])))
		if last := importString(totals["lastImport"]); last != "" {
			lines = append(lines, "最近入库（UTC）："+last)
		}
	}
	for _, account := range totals["accounts"].([]map[string]any) {
		lines = append(lines, fmt.Sprintf("账号：%s（Network %s） · %s（%s） · 流水 $%.2f · 利润 $%.2f",
			importString(account["name"]), importString(account["networkCode"]), importString(account["date"]),
			importString(account["timeZone"]), numberValue(account["revenue"]), numberValue(account["profit"])))
	}
	lines = append(lines, "当天数值为截至统计时间的快照；GAM 后续修订以数据报告为准。")
	return strings.Join(lines, "\n")
}

func (a *app) botReportSettings(w http.ResponseWriter, _ *http.Request) {
	enabled, ciphertext, err := a.botReportConfig()
	if err != nil {
		writeError(w, 500, "bot_report_settings_unavailable")
		return
	}
	zone, _ := time.LoadLocation("Asia/Shanghai")
	date := time.Now().In(zone).Format("2006-01-02")
	totals, err := a.botReportTotalsAt(time.Now())
	if err != nil {
		writeError(w, 500, "bot_report_preview_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "settings": map[string]any{
		"enabled": enabled, "webhookConfigured": ciphertext != "", "schedule": "23:45 Asia/Shanghai",
		"lastDelivery": a.botReportLast(),
	}, "preview": botReportPreview(date, totals)})
}

func botReportPreview(date string, totals map[string]any) map[string]any {
	rows := numberValue(totals["rows"])
	result := map[string]any{"date": date, "rows": rows, "lastImport": totals["lastImport"], "accounts": totals["accounts"]}
	if rows > 0 {
		result["revenue"] = numberValue(totals["grossRevenue"])
		result["profit"] = numberValue(totals["upstreamRevenue"])*0.85 - numberValue(totals["channelRevenue"])
	}
	return result
}

func (a *app) updateBotReportSettings(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	enabled, ok := input["enabled"].(bool)
	if !ok {
		return errors.New("invalid_bot_report_enabled")
	}
	_, ciphertext, err := a.botReportConfig()
	if err != nil {
		return err
	}
	credential := map[string]any{"url": "", "secret": ""}
	if ciphertext != "" {
		credential, err = a.decryptCredential(ciphertext)
		if err != nil {
			return err
		}
	}
	if clear, _ := input["clearWebhook"].(bool); clear {
		credential["url"] = ""
	}
	if raw, exists := input["webhook"]; exists && raw != "" {
		url, valid := raw.(string)
		if !valid || !validFeishuWebhook(strings.TrimSpace(url)) {
			return errors.New("invalid_feishu_webhook")
		}
		credential["url"] = strings.TrimSpace(url)
	}
	url := importString(credential["url"])
	if enabled && url == "" {
		return errors.New("invalid_feishu_webhook_required")
	}
	ciphertext = ""
	if url != "" {
		ciphertext, err = a.encryptCredential(credential)
		if err != nil {
			return err
		}
	}
	flag := 0
	if enabled {
		flag = 1
	}
	_, err = a.db.ExecContext(r.Context(), "UPDATE bot_report_settings SET enabled=?,webhook_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=1", flag, ciphertext)
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "bot_report.settings_update", "bot_report_settings", 1, marshalText(map[string]any{"enabled": enabled, "webhookConfigured": url != ""}), clientIP(r))
	a.botReportSettings(w, r)
	return nil
}

func (a *app) testBotReport(w http.ResponseWriter, r *http.Request) {
	_, ciphertext, err := a.botReportConfig()
	if err != nil || ciphertext == "" {
		writeError(w, 400, "bot_report_webhook_required")
		return
	}
	credential, err := a.decryptCredential(ciphertext)
	if err != nil {
		writeError(w, 500, "bot_report_credential_unavailable")
		return
	}
	zone, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now()
	date := now.In(zone).Format("2006-01-02")
	totals, err := a.botReportTotalsAt(now)
	if err != nil {
		writeError(w, 500, "bot_report_preview_unavailable")
		return
	}
	if err = postFeishu(r.Context(), importString(credential["url"]), importString(credential["secret"]), "【手动测试】\n"+botReportMessage(date, now, totals)); err != nil {
		log.Printf("bot_report_test_failed: %v", err)
		writeError(w, 502, "bot_report_send_failed")
		return
	}
	a.audit(currentUser(r).Email, "bot_report.test", "bot_report_settings", 1, "", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *app) runBotReportAt(ctx context.Context, now time.Time, send botReportSender) error {
	date, due := botReportDate(now)
	if !due {
		return nil
	}
	enabled, ciphertext, err := a.botReportConfig()
	if err != nil {
		return err
	}
	if !enabled || ciphertext == "" {
		return nil
	}
	clock := now.UTC().Format("2006-01-02 15:04:05")
	cutoff := now.Add(-15 * time.Minute).UTC().Format("2006-01-02 15:04:05")
	if _, err = a.db.ExecContext(ctx, "INSERT OR IGNORE INTO bot_report_deliveries(report_date) VALUES(?)", date); err != nil {
		return err
	}
	claim, err := a.db.ExecContext(ctx, "UPDATE bot_report_deliveries SET status='sending',attempts=attempts+1,last_attempt_at=?,error='' WHERE report_date=? AND status<>'sent' AND (last_attempt_at IS NULL OR last_attempt_at<=?)", clock, date, cutoff)
	if err != nil {
		return err
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed == 0 {
		return err
	}
	status, detail, sentAt := "failed", "", any(nil)
	defer func() {
		_, _ = a.db.Exec("UPDATE bot_report_deliveries SET status=?,error=?,sent_at=? WHERE report_date=?", status, detail, sentAt, date)
	}()
	totals, err := a.botReportTotalsAt(botReportScheduledInstant(date))
	if err == nil {
		var credential map[string]any
		credential, err = a.decryptCredential(ciphertext)
		if err == nil {
			err = send(ctx, importString(credential["url"]), importString(credential["secret"]), botReportMessage(date, now, totals))
		}
	}
	if err != nil {
		detail = err.Error()
		if len(detail) > 500 {
			detail = detail[:500]
		}
		return err
	}
	status, sentAt = "sent", clock
	return nil
}
