package main

import (
	"context"
	"path/filepath"
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
	_, err = a.db.Exec("UPDATE regression_events SET alert_status='sent' WHERE id=?", alerts[0].ID)
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
