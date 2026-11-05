package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func validDate(value string) bool {
	if len(value) != 10 {
		return false
	}
	date, err := time.Parse("2006-01-02", value)
	return err == nil && date.Format("2006-01-02") == value
}
func reportRange(r *http.Request) (string, string) {
	end := r.URL.Query().Get("end")
	if !validDate(end) {
		end = time.Now().UTC().Format("2006-01-02")
	}
	start := r.URL.Query().Get("start")
	if !validDate(start) {
		start = end[:8] + "01"
	}
	return start, end
}
func mappedDomainSQL(alias string) string {
	return "COALESCE((SELECT m.domain FROM ad_unit_domains m WHERE m.ad_unit=" + alias + ".ad_unit COLLATE NOCASE LIMIT 1)," + alias + ".domain)"
}
func effectiveShareSQL(alias string) string {
	return "(SELECT v.share_percent FROM channel_share_versions v WHERE v.channel_id=" + alias + ".channel_id AND v.effective_from<=" + alias + ".report_date ORDER BY v.effective_from DESC,v.id DESC LIMIT 1)"
}
func upstreamShareSQL(alias string) string {
	return "COALESCE((SELECT v.share_percent FROM upstream_share_versions v JOIN upstream_accounts u ON u.id=v.upstream_account_id WHERE u.account_key=" + alias + ".account COLLATE NOCASE AND u.status='active' AND v.effective_from<=" + alias + ".report_date ORDER BY v.effective_from DESC,v.id DESC LIMIT 1)," +
		"(SELECT u.share_percent FROM upstream_accounts u WHERE u.account_key=" + alias + ".account COLLATE NOCASE AND u.status='active' LIMIT 1),100)"
}
func channelRuleShareSQL(alias string) string {
	domain := mappedDomainSQL(alias)
	return "COALESCE(" +
		"(SELECT r.share_percent FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id WHERE r.channel_id=" + alias + ".channel_id AND u.account_key=" + alias + ".account COLLATE NOCASE AND (r.domain='' OR r.domain=" + domain + " COLLATE NOCASE) AND r.effective_from<=" + alias + ".report_date ORDER BY CASE WHEN r.domain='' THEN 1 ELSE 0 END,r.effective_from DESC,r.id DESC LIMIT 1)," +
		"(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=" + alias + ".channel_id AND r.scope_type='ad_unit' AND r.scope_value=" + alias + ".ad_unit COLLATE NOCASE AND r.effective_from<=" + alias + ".report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1)," +
		"(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=" + alias + ".channel_id AND r.scope_type='account' AND r.scope_value=" + alias + ".account COLLATE NOCASE AND r.effective_from<=" + alias + ".report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1)," +
		effectiveShareSQL(alias) + ")"
}
func settledRevenueSQL(alias string) string {
	return "(" + alias + ".revenue*(" + upstreamShareSQL(alias) + "/100.0)*(" + channelRuleShareSQL(alias) + "/100.0))"
}
func numberValue(value any) float64 {
	switch x := value.(type) {
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case float64:
		return x
	case []byte:
		f, _ := strconv.ParseFloat(string(x), 64)
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	default:
		return 0
	}
}

func (a *app) dashboard(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	u := currentUser(r)
	start, end := reportRange(r)
	if start > end {
		writeError(w, 400, "invalid_report_range")
		return
	}
	var scope int64
	if u.Role == "channel" {
		scope = u.ChannelID.Int64
	}
	if u.Role == "admin" {
		scope, _ = strconv.ParseInt(r.URL.Query().Get("channelId"), 10, 64)
	}
	where := "report_date BETWEEN ? AND ?"
	args := []any{start, end}
	if scope > 0 {
		where += " AND channel_id=?"
		args = append(args, scope)
	}
	ready := a.dailyReady.Load()
	source := "revenue_facts"
	if ready {
		source = "dashboard_daily"
	}
	summary, err := firstMap(a.db, "SELECT COALESCE(SUM(requests),0) requests,COALESCE(SUM(matched_requests),0) matched,COALESCE(SUM(impressions),0) impressions,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(revenue),0) revenue FROM "+source+" WHERE "+where, args...)
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	sumMS := time.Since(started)
	factor := "revenue"
	if u.Role == "channel" {
		if ready {
			factor = "settled_revenue"
		} else {
			factor = settledRevenueSQL("revenue_facts")
		}
	}
	trend, err := queryMaps(a.db, "SELECT report_date date,ROUND(SUM("+factor+"),6) revenue FROM "+source+" WHERE "+where+" GROUP BY report_date ORDER BY report_date", args...)
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	trendMS := time.Since(started) - sumMS
	domain := mappedDomainSQL("revenue_facts")
	if ready {
		domain = "domain"
	}
	top, err := queryMaps(a.db, "SELECT "+domain+" url,SUM(impressions) impressions,ROUND(SUM("+factor+"),6) revenue FROM "+source+" WHERE "+where+" GROUP BY "+domain+" ORDER BY revenue DESC LIMIT 10", args...)
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	topMS := time.Since(started) - sumMS - trendMS
	settledWhere := strings.ReplaceAll(strings.ReplaceAll(where, "report_date", "rf.report_date"), "channel_id", "rf.channel_id")
	settledSQL := "SELECT COALESCE(SUM(" + settledRevenueSQL("rf") + "),0) value FROM revenue_facts rf WHERE " + settledWhere
	if ready {
		settledSQL = "SELECT COALESCE(SUM(settled_revenue),0) value FROM dashboard_daily WHERE " + where
	}
	settled, err := firstMap(a.db, settledSQL, args...)
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	settlementMS := time.Since(started) - sumMS - trendMS - topMS
	var lastSync sql.NullString
	_ = a.db.QueryRowContext(r.Context(), "SELECT MAX(value) FROM (SELECT MAX(created_at) value FROM import_runs UNION ALL SELECT MAX(finished_at) value FROM soap_sync_runs WHERE status='success')").Scan(&lastSync)
	var last any
	if lastSync.Valid {
		last = lastSync.String
	}
	if u.Role == "channel" {
		summary["revenue"] = settled["value"]
	}
	summary["channelRevenue"] = settled["value"]
	if numberValue(summary["requests"]) > 0 {
		summary["matchRate"] = numberValue(summary["matched"]) * 100 / numberValue(summary["requests"])
	} else {
		summary["matchRate"] = float64(0)
	}
	w.Header().Set("Server-Timing", fmt.Sprintf("summary;dur=%.1f,trend;dur=%.1f,top;dur=%.1f,settlement;dur=%.1f",
		float64(sumMS.Microseconds())/1000, float64(trendMS.Microseconds())/1000, float64(topMS.Microseconds())/1000, float64(settlementMS.Microseconds())/1000))
	writeJSON(w, 200, map[string]any{"ok": true, "summary": summary, "trend": trend, "topUrls": top, "lastSync": last})
}

func (a *app) dashboardFailure(w http.ResponseWriter, err error) {
	log.Printf("dashboard_query_failed: %v", err)
	writeError(w, 500, "internal_error")
}

func (a *app) initializeDashboardDaily() error {
	_, err := a.db.Exec("CREATE TABLE IF NOT EXISTS dashboard_daily (report_date TEXT NOT NULL,channel_id INTEGER NOT NULL,domain TEXT NOT NULL,requests INTEGER NOT NULL,matched_requests INTEGER NOT NULL,impressions INTEGER NOT NULL,clicks INTEGER NOT NULL,revenue REAL NOT NULL,settled_revenue REAL NOT NULL,PRIMARY KEY(report_date,channel_id,domain)) WITHOUT ROWID")
	if err != nil {
		return err
	}
	var daily, facts int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM dashboard_daily").Scan(&daily); err != nil {
		return err
	}
	if err := a.db.QueryRow("SELECT COUNT(*) FROM revenue_facts").Scan(&facts); err != nil {
		return err
	}
	if daily == 0 && facts > 0 {
		return a.refreshDashboardDaily(0, "", "")
	}
	a.dailyReady.Store(true)
	return nil
}

func (a *app) refreshDashboardDaily(channelID int64, start, end string) error {
	scoped := channelID > 0 && validDate(start) && validDate(end)
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	where := ""
	var args []any
	if scoped {
		if _, err = tx.Exec("DELETE FROM dashboard_daily WHERE channel_id=? AND report_date BETWEEN ? AND ?", channelID, start, end); err != nil {
			return err
		}
		where = " WHERE rf.channel_id=? AND rf.report_date BETWEEN ? AND ?"
		args = []any{channelID, start, end}
	} else if _, err = tx.Exec("DELETE FROM dashboard_daily"); err != nil {
		return err
	}
	domain := mappedDomainSQL("rf")
	query := "INSERT INTO dashboard_daily(report_date,channel_id,domain,requests,matched_requests,impressions,clicks,revenue,settled_revenue) " +
		"SELECT rf.report_date,rf.channel_id," + domain + ",SUM(rf.requests),SUM(rf.matched_requests),SUM(rf.impressions),SUM(rf.clicks),SUM(rf.revenue),SUM(" + settledRevenueSQL("rf") + ") FROM revenue_facts rf" + where +
		" GROUP BY rf.report_date,rf.channel_id," + domain
	if _, err = tx.Exec(query, args...); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.dailyReady.Store(true)
	return nil
}

func (a *app) refreshDailySafely(channelID int64, start, end string) {
	a.invalidateReportCache()
	if err := a.refreshDashboardDaily(channelID, start, end); err != nil {
		a.dailyReady.Store(false)
		log.Printf("dashboard_daily_refresh_failed: %v", err)
	}
}
