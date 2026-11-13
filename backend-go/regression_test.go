package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRegressionEventsDateFilterIncludesOverlappingWindow(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	for _, statement := range []string{
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by) VALUES(1,'GAM','123456','test','admin')",
		"INSERT INTO regression_runs(id,soap_account_id,cadence,period_start,period_end,baseline_start,baseline_end,status) VALUES(1,1,'week','2026-11-01','2026-11-07','2026-10-25','2026-10-31','success')",
		"INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks) VALUES(1,1,'week','2026-11-01','2026-11-07','example.com',100,80,1000,800,700,600,10,8)",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	check := func(date string, expected int) {
		w := httptest.NewRecorder()
		a.regressionEvents(w, httptest.NewRequest("GET", "/api/admin/regression/events?start="+date+"&end="+date, nil))
		var body struct {
			Total int `json:"total"`
			Items []struct {
				BaselineStart string `json:"baselineStart"`
			} `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || body.Total != expected || len(body.Items) != expected {
			t.Fatalf("date=%s status=%d body=%s", date, w.Code, w.Body.String())
		}
		if expected > 0 && body.Items[0].BaselineStart != "2026-10-25" {
			t.Fatalf("missing comparison window: %s", w.Body.String())
		}
	}
	check("2026-11-02", 1)
	check("2026-11-08", 0)
}

func TestRegressionWindowsAndThresholds(t *testing.T) {
	instant := time.Date(2026, 11, 4, 1, 30, 0, 0, time.UTC)
	day, err := regressionWindowAt("America/Los_Angeles", instant, "day")
	if err != nil || day.Start != "2026-11-03" || day.End != "2026-11-03" || day.BaselineStart != "" {
		t.Fatalf("day=%+v error=%v", day, err)
	}
	three, err := regressionWindowAt("Asia/Tokyo", instant, "three_days")
	if err != nil || three.Start != "2026-11-01" || three.End != "2026-11-03" || three.BaselineStart != "2026-10-29" || three.BaselineEnd != "2026-10-31" {
		t.Fatalf("three=%+v error=%v", three, err)
	}
	month, err := regressionWindowAt("Asia/Tokyo", instant, "month")
	if err != nil || month.Start != "2026-10-05" || month.End != "2026-11-03" || month.BaselineStart != "2026-09-05" || month.BaselineEnd != "2026-10-04" {
		t.Fatalf("month=%+v error=%v", month, err)
	}
	c := regressionConfig{MinRevenue: 50, MinDropPercent: 2}
	if !alertQualified(regressionMeasure{Revenue: 100}, regressionMeasure{Revenue: 98}, c) ||
		alertQualified(regressionMeasure{Revenue: 50}, regressionMeasure{Revenue: 30}, c) ||
		alertQualified(regressionMeasure{Revenue: 100}, regressionMeasure{Revenue: 98.01}, c) {
		t.Fatal("threshold must require both conditions")
	}
}

func TestRegressionCycleWaitsForFullLocalPeriods(t *testing.T) {
	instant := time.Date(2026, 11, 13, 1, 30, 0, 0, time.UTC)
	three, ready, err := regressionCycleWindowAt("Asia/Shanghai", instant, "three_days", "2026-11-11")
	if err != nil || ready || three.Start != "2026-11-12" || three.End != "2026-11-14" || three.BaselineStart != "2026-11-09" || three.BaselineEnd != "2026-11-11" {
		t.Fatalf("incomplete three-day period: window=%+v ready=%v error=%v", three, ready, err)
	}
	three, ready, err = regressionCycleWindowAt("Asia/Shanghai", time.Date(2026, 11, 15, 0, 30, 0, 0, time.UTC), "three_days", "2026-11-11")
	if err != nil || !ready {
		t.Fatalf("completed three-day period: window=%+v ready=%v error=%v", three, ready, err)
	}
	next, ready, err := regressionCycleWindowAt("Asia/Shanghai", time.Date(2026, 11, 16, 0, 30, 0, 0, time.UTC), "three_days", three.End)
	if err != nil || ready || next.Start != "2026-11-15" || next.End != "2026-11-17" {
		t.Fatalf("next three-day period: window=%+v ready=%v error=%v", next, ready, err)
	}
	la, ready, err := regressionCycleWindowAt("America/Los_Angeles", time.Date(2026, 11, 16, 1, 0, 0, 0, time.UTC), "week", "2026-11-08")
	if err != nil || ready || la.Start != "2026-11-09" || la.End != "2026-11-15" || la.BaselineStart != "2026-11-02" || la.BaselineEnd != "2026-11-08" {
		t.Fatalf("incomplete Los Angeles week: window=%+v ready=%v error=%v", la, ready, err)
	}
	_, ready, err = regressionCycleWindowAt("America/Los_Angeles", time.Date(2026, 11, 16, 8, 0, 0, 0, time.UTC), "week", "2026-11-08")
	if err != nil || !ready {
		t.Fatalf("completed Los Angeles week: ready=%v error=%v", ready, err)
	}
}

func TestCompletedRegressionCycleDoesNotRunAgain(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	if _, err := a.db.Exec("INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by) VALUES(1,'GAM','123456','test','admin')"); err != nil {
		t.Fatal(err)
	}
	window := regressionWindow{Cadence: "three_days", Start: "2026-11-09", End: "2026-11-11"}
	if !a.regressionDue(1, window) {
		t.Fatal("new completed period should run")
	}
	if _, err := a.db.Exec("INSERT INTO regression_runs(soap_account_id,cadence,period_start,period_end,status,finished_at) VALUES(1,'three_days','2026-11-09','2026-11-11','success','2026-11-11 12:00:00')"); err != nil {
		t.Fatal(err)
	}
	if a.regressionDue(1, window) {
		t.Fatal("successful period must not run again even after its interval")
	}
	window.Start, window.End = "2026-11-12", "2026-11-14"
	if !a.regressionDue(1, window) {
		t.Fatal("next complete period should run")
	}
}

func TestRegressionPauseExclusionKeepsOtherRevenueDrops(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email) VALUES(1,'channel','channel@example.test')",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,rest_report_name,rest_money_divisor,rest_network_timezone,rest_channel_id,rest_upstream_account_id) VALUES(1,'GAM A','123456','test','admin','networks/123456/reports/1',1,'Asia/Shanghai',1,1)",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,rest_report_name,rest_money_divisor,rest_network_timezone,rest_channel_id,rest_upstream_account_id) VALUES(2,'GAM B','654321','test','admin','networks/654321/reports/1',1,'America/Los_Angeles',1,2)",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id) VALUES(1,'upstream-a','A',1)",
		"INSERT INTO upstream_accounts(id,account_key,name,soap_account_id) VALUES(2,'upstream-b','B',2)",
		"INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,created_at) VALUES('admin','gam.ad_unit_archive','gam_ad_unit','123456','{\"names\":[\"networks/123456/adUnits/11\"]}','2026-11-05 02:00:00')",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,ad_unit_id,source_file,revenue) VALUES(1,'2026-11-01','pause.example','upstream-a','11','gam-rest:123456:test',60),(1,'2026-11-01','pause.example','upstream-a','12','gam-rest:123456:test',100),(1,'2026-11-04','pause.example','upstream-a','12','gam-rest:123456:test',100)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,ad_unit_id,source_file,revenue) VALUES(1,'2026-11-01','mixed.example','upstream-a','11','gam-rest:123456:test',50),(1,'2026-11-01','mixed.example','upstream-a','12','gam-rest:123456:test',100),(1,'2026-11-04','mixed.example','upstream-a','12','gam-rest:123456:test',70)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,ad_unit_id,source_file,revenue) VALUES(1,'2026-11-01','other.example','upstream-b','11','gam-rest:654321:test',80)",
		"UPDATE regression_settings SET feishu_enabled=1,webhook_ciphertext='configured' WHERE id=1",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	window := regressionWindow{Cadence: "three_days", Start: "2026-11-04", End: "2026-11-06", BaselineStart: "2026-11-01", BaselineEnd: "2026-11-03"}
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	paused, err := a.pausedAdUnitRevenue(context.Background(), account, window)
	if err != nil || paused["pause.example"].Before != 60 || paused["mixed.example"].Before != 50 || paused["other.example"].Before != 0 {
		t.Fatalf("paused=%+v error=%v", paused, err)
	}
	old := map[string]regressionMeasure{"pause.example": {Revenue: 160}, "mixed.example": {Revenue: 150}}
	newer := map[string]regressionMeasure{"pause.example": {Revenue: 100}, "mixed.example": {Revenue: 70}}
	alerts, err := a.saveRegressionRun(context.Background(), account, window, "success", "", old, newer)
	if err != nil || len(alerts) != 1 || alerts[0].Domain != "mixed.example" || !alerts[0].PauseExcluded || alerts[0].Old.Revenue != 100 || alerts[0].New.Revenue != 70 {
		t.Fatalf("alerts=%+v error=%v", alerts, err)
	}
	if !a.exists("SELECT id FROM regression_events WHERE domain='pause.example' AND alert_status='paused_suppressed'") {
		t.Fatal("pure ad-unit pause should not alert")
	}
	if _, err := a.db.Exec("UPDATE regression_events SET alert_status='sent' WHERE domain='mixed.example' AND alert_status='pending'"); err != nil {
		t.Fatal(err)
	}
	var runID int64
	if err := a.db.QueryRow("SELECT MAX(id) FROM regression_runs").Scan(&runID); err != nil {
		t.Fatal(err)
	}
	_, err = a.db.Exec("INSERT INTO regression_events(run_id,soap_account_id,cadence,period_start,period_end,domain,old_revenue,new_revenue,old_requests,new_requests,old_impressions,new_impressions,old_clicks,new_clicks,alert_status) VALUES(?,?,?,?,?,?,160,100,0,0,0,0,0,0,'failed')", runID, 1, window.Cadence, window.Start, window.End, "pause.example")
	if err != nil {
		t.Fatal(err)
	}
	a.retryRegressionAlerts(context.Background(), account)
	if !a.exists("SELECT id FROM regression_events WHERE domain='pause.example' AND alert_old_revenue IS NULL AND alert_status='paused_suppressed'") {
		t.Fatal("old failed alert must be rechecked before sending")
	}
	other, err := a.gamAccount(2)
	if err != nil {
		t.Fatal(err)
	}
	otherPaused, err := a.pausedAdUnitRevenue(context.Background(), other, window)
	if err != nil || len(otherPaused) != 0 {
		t.Fatalf("another account must not inherit pause: %+v error=%v", otherPaused, err)
	}
	_, err = a.db.Exec("INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,created_at) VALUES('admin','gam.ad_unit_activate','gam_ad_unit','123456','{\"names\":[\"networks/123456/adUnits/11\"]}','2026-11-06 02:00:00')")
	if err != nil {
		t.Fatal(err)
	}
	paused, err = a.pausedAdUnitRevenue(context.Background(), account, window)
	if err != nil || len(paused) != 0 {
		t.Fatalf("reactivated unit must not stay excluded: %+v error=%v", paused, err)
	}
}

func TestRegressionAlertMessageIdentifiesSourceAndTime(t *testing.T) {
	account := map[string]any{"name": "GAM Test", "network_code": "123456"}
	window := regressionWindow{Cadence: "day", Start: "2026-11-09", End: "2026-11-09"}
	alert := regressionAlert{Domain: "news.example.com", DropStartDate: "2026-11-09", DetectedAtUTC: "2026-11-09 08:29:00", Old: regressionMeasure{Revenue: 100, Requests: 100, Impressions: 80, Clicks: 10}, New: regressionMeasure{Revenue: 90, Requests: 95, Impressions: 85, Clicks: 10}}
	message := regressionAlertMessage(account, "赵飞", "Asia/Shanghai", "2026-11-09 16:30", window, "单日快照", []regressionAlert{alert})
	expected := strings.Join([]string{
		"【AdX 收入下降】", "账号：GAM Test（123456）", "渠道：赵飞", "域名：news.example.com",
		"数据日：2026-11-09", "收入：$100.00 → $90.00，少 $10.00（10.00%）", "发现：2026-11-09 16:29（Asia/Shanghai）",
	}, "\n")
	if message != expected {
		t.Fatalf("unexpected alert message:\n%s", message)
	}
	alert.DropStartDate = ""
	unknown := regressionAlertMessage(account, "赵飞", "Asia/Shanghai", "2026-11-09 16:30", window, "单日快照", []regressionAlert{alert})
	if !strings.Contains(unknown, "数据日：2026-11-09") || strings.Contains(unknown, "已确认下修日") {
		t.Fatalf("day alert should show only the data date: %s", unknown)
	}
	multi := regressionWindow{Cadence: "three_days", Start: "2026-11-07", End: "2026-11-09", BaselineStart: "2026-11-04", BaselineEnd: "2026-11-06"}
	alert.PauseExcluded = true
	multiText := regressionAlertMessage(account, "赵飞", "Asia/Singapore", "2026-11-10 00:43", multi, "近 3 天", []regressionAlert{alert})
	for _, part := range []string{"区间：2026-11-07 至 2026-11-09（对比 2026-11-04 至 2026-11-06）", "收入：$100.00 → $90.00，少 $10.00（10.00%），已排除停投广告", "发现：2026-11-09 16:29（Asia/Singapore）"} {
		if !strings.Contains(multiText, part) {
			t.Fatalf("multi-day alert missing %q: %s", part, multiText)
		}
	}
}

func TestRegressionSnapshotAndNotificationDedup(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	_, err = a.db.Exec("INSERT INTO soap_accounts(name,network_code,credential_ciphertext,created_by) VALUES('GAM','123456','test','admin')")
	if err != nil {
		t.Fatal(err)
	}
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	w := regressionWindow{Cadence: "day", Start: "2026-11-04", End: "2026-11-04"}
	baseline := map[string]regressionMeasure{"example.com": {Revenue: 100, Requests: 1000, Impressions: 800, Clicks: 10}}
	alerts, err := a.saveRegressionRun(context.Background(), account, w, "success", "", nil, baseline)
	if err != nil || len(alerts) != 0 {
		t.Fatalf("baseline alerts=%v error=%v", alerts, err)
	}
	previous, err := a.previousDailySnapshot(1, w)
	if err != nil || previous["example.com"].Revenue != 100 {
		t.Fatalf("snapshot=%v error=%v", previous, err)
	}
	decreased := map[string]regressionMeasure{"example.com": {Revenue: 97, Requests: 950, Impressions: 750, Clicks: 9}}
	alerts, err = a.saveRegressionRun(context.Background(), account, w, "success", "", previous, decreased)
	if err != nil || len(alerts) != 0 {
		t.Fatalf("disabled alerts=%v error=%v", alerts, err)
	}
	if !a.exists("SELECT id FROM regression_events WHERE alert_status='disabled' AND old_revenue=100 AND new_revenue=97") {
		t.Fatal("missing comparison")
	}
	cipher, err := a.encryptCredential(map[string]any{"url": "https://open.feishu.cn/open-apis/bot/v2/hook/test", "secret": ""})
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.db.Exec("UPDATE regression_settings SET feishu_enabled=1,webhook_ciphertext=? WHERE id=1", cipher)
	if err != nil {
		t.Fatal(err)
	}
	alerts, err = a.saveRegressionRun(context.Background(), account, w, "success", "", previous, decreased)
	if err != nil || len(alerts) != 1 {
		t.Fatalf("qualified alerts=%v error=%v", alerts, err)
	}
	pendingID := alerts[0].ID
	alerts, err = a.saveRegressionRun(context.Background(), account, w, "success", "", previous, decreased)
	if err != nil || len(alerts) != 0 {
		t.Fatalf("pending dedup alerts=%v error=%v", alerts, err)
	}
	_, err = a.db.Exec("UPDATE regression_events SET alert_status='sent' WHERE id=?", pendingID)
	if err != nil {
		t.Fatal(err)
	}
	alerts, err = a.saveRegressionRun(context.Background(), account, w, "success", "", previous, decreased)
	if err != nil || len(alerts) != 0 || !a.exists("SELECT id FROM regression_events WHERE alert_status='duplicate'") {
		t.Fatalf("duplicate alerts=%v error=%v", alerts, err)
	}
	otherDay := regressionWindow{Cadence: "day", Start: "2026-11-05", End: "2026-11-05", Interval: 15 * time.Minute}
	if !a.regressionDue(1, otherDay) {
		t.Fatal("a new date must get its own first snapshot")
	}
}

func TestRegressionCoverageRequiresEveryDateFromGAM(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	for _, statement := range []string{
		"INSERT INTO channels(name,email) VALUES('channel','channel@example.test')",
		"INSERT INTO soap_accounts(name,network_code,credential_ciphertext,created_by,rest_report_name,rest_channel_id,rest_upstream_account_id,rest_money_divisor) VALUES('GAM','123456','test','admin','networks/123456/reports/1',1,1,1)",
		"INSERT INTO upstream_accounts(account_key,name,soap_account_id) VALUES('upstream','upstream',1)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file) VALUES(1,'2026-11-02','example.com','upstream','gam-rest:123456:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file) VALUES(1,'2026-11-03','example.com','upstream','gam-rest:123456:test')",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file) VALUES(1,'2026-11-04','example.com','upstream','manual-import')",
	} {
		if _, err = a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	days, err := a.regressionCoveredDays(context.Background(), account, "2026-11-02", "2026-11-04")
	if err != nil || days != 2 {
		t.Fatalf("incomplete coverage days=%d error=%v", days, err)
	}
	_, err = a.db.Exec("UPDATE revenue_facts SET source_file='gam-rest:123456:test' WHERE report_date='2026-11-04'")
	if err != nil {
		t.Fatal(err)
	}
	days, err = a.regressionCoveredDays(context.Background(), account, "2026-11-02", "2026-11-04")
	if err != nil || days != 3 {
		t.Fatalf("complete coverage days=%d error=%v", days, err)
	}
}

func TestRegressionStartDateNeedsPreviousSameDaySnapshot(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	for _, statement := range []string{
		"INSERT INTO channels(name,email) VALUES('channel','channel@example.test')",
		"INSERT INTO soap_accounts(name,network_code,credential_ciphertext,created_by,rest_report_name,rest_channel_id,rest_upstream_account_id,rest_money_divisor) VALUES('GAM','123456','test','admin','networks/123456/reports/1',1,1,1)",
		"INSERT INTO upstream_accounts(account_key,name,soap_account_id) VALUES('upstream','upstream',1)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file,revenue) VALUES(1,'2026-11-02','example.com','upstream','gam-rest:123456:test',30)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file,revenue) VALUES(1,'2026-11-03','example.com','upstream','gam-rest:123456:test',30)",
		"INSERT INTO revenue_facts(channel_id,report_date,domain,account,source_file,revenue) VALUES(1,'2026-11-04','example.com','upstream','gam-rest:123456:test',30)",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	account, err := a.gamAccount(1)
	if err != nil {
		t.Fatal(err)
	}
	window := regressionWindow{Cadence: "three_days", Start: "2026-11-02", End: "2026-11-04"}
	old := map[string]regressionMeasure{"example.com": {Revenue: 100}}
	first := map[string]regressionMeasure{"example.com": {Revenue: 90}}
	if _, err := a.saveRegressionRun(context.Background(), account, window, "success", "", old, first); err != nil {
		t.Fatal(err)
	}
	var firstDate sql.NullString
	if err := a.db.QueryRow("SELECT drop_start_date FROM regression_events ORDER BY id DESC LIMIT 1").Scan(&firstDate); err != nil || firstDate.Valid {
		t.Fatalf("first date=%v error=%v", firstDate, err)
	}
	var priorRunCutoff int64
	if err := a.db.QueryRow("SELECT MAX(id) FROM regression_runs").Scan(&priorRunCutoff); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec("UPDATE revenue_facts SET revenue=25 WHERE report_date='2026-11-03'"); err != nil {
		t.Fatal(err)
	}
	dayWindow := regressionWindow{Cadence: "day", Start: "2026-11-03", End: "2026-11-03"}
	if _, err := a.saveRegressionRun(context.Background(), account, dayWindow, "success", "", map[string]regressionMeasure{"example.com": {Revenue: 30}}, map[string]regressionMeasure{"example.com": {Revenue: 25}}, priorRunCutoff); err != nil {
		t.Fatal(err)
	}
	second := map[string]regressionMeasure{"example.com": {Revenue: 85}}
	if _, err := a.saveRegressionRun(context.Background(), account, window, "success", "", old, second, priorRunCutoff); err != nil {
		t.Fatal(err)
	}
	var secondDate sql.NullString
	if err := a.db.QueryRow("SELECT drop_start_date FROM regression_events ORDER BY id DESC LIMIT 1").Scan(&secondDate); err != nil || !secondDate.Valid || secondDate.String != "2026-11-03" {
		t.Fatalf("second date=%v error=%v", secondDate, err)
	}
}
