package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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

func TestRegressionAlertMessageIdentifiesSourceAndTime(t *testing.T) {
	account := map[string]any{"name": "GAM Test", "network_code": "123456"}
	window := regressionWindow{Cadence: "day", Start: "2026-11-09", End: "2026-11-09"}
	alert := regressionAlert{Domain: "news.example.com", DropStartDate: "2026-11-09", Old: regressionMeasure{Revenue: 100}, New: regressionMeasure{Revenue: 90}}
	message := regressionAlertMessage(account, "赵飞", "Asia/Shanghai", "2026-11-09 16:30", window, "单日快照", []regressionAlert{alert})
	for _, expected := range []string{"GAM Test", "Network 123456", "渠道：赵飞", "2026-11-09 16:30（Asia/Shanghai）", "news.example.com", "倒扣起始数据日：2026-11-09", "回退 $10.00"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("missing %q in %q", expected, message)
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
