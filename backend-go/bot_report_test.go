package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestBotReportUsesRealRestRevenueAndSendsOnce(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,status,rest_sync_enabled,rest_network_timezone,rest_channel_id) VALUES(1,'Shanghai GAM','123','test','admin','active',1,'Asia/Shanghai',1)",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,status,rest_sync_enabled,rest_network_timezone,rest_channel_id) VALUES(2,'Kiritimati GAM','456','test','admin','active',1,'Pacific/Kiritimati',1)",
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Test','channel@example.test',50)",
		"INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(1,50,'1900-01-01','test')",
		"INSERT INTO upstream_accounts(id,account_key,name,share_percent,status) VALUES(1,'acct','Account',80,'active')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,revenue,source_file) VALUES(1,'2026-11-10','https://example.test','example.test','acct','unit','1',100,'gam-rest:123:2026-11-10')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,revenue,source_file) VALUES(1,'2026-11-11','https://example.test','example.test','acct','unit','3',50,'gam-rest:456:2026-11-11')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,revenue,source_file) VALUES(1,'2026-11-10','https://example.test','example.test','acct','legacy','2',50,'manual-import')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	cipher, err := a.encryptCredential(map[string]any{"url": "https://open.feishu.cn/open-apis/bot/v2/hook/test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("UPDATE bot_report_settings SET enabled=1,webhook_ciphertext=? WHERE id=1", cipher); err != nil {
		t.Fatal(err)
	}
	before := time.Date(2026, 11, 10, 15, 44, 0, 0, time.UTC)
	now := before.Add(time.Minute)
	totals, err := a.botReportTotalsAt(now)
	if err != nil {
		t.Fatal(err)
	}
	preview := botReportPreview("2026-11-10", totals)
	if preview["revenue"] != float64(150) || preview["upstreamSettlement"] != float64(120) ||
		preview["channelRevenue"] != float64(60) || preview["profit"] != float64(60) || preview["rows"] != float64(2) {
		t.Fatalf("preview=%+v", preview)
	}
	accounts := preview["accounts"].([]map[string]any)
	if accounts[0]["date"] != "2026-11-10" || accounts[1]["date"] != "2026-11-11" {
		t.Fatalf("account dates=%+v", accounts)
	}
	if accounts[0]["channelName"] != "Test" {
		t.Fatalf("channel=%+v", accounts[0])
	}
	if date, due := botReportDate(before); due || date != "" {
		t.Fatalf("before schedule: %s %v", date, due)
	}
	var sends int
	sender := func(_ context.Context, webhook, secret, text string) error {
		sends++
		if webhook != "https://open.feishu.cn/open-apis/bot/v2/hook/test" || secret != "" ||
			!strings.Contains(text, "流水（GAM REST 原始收入）：$150.00") ||
			!strings.Contains(text, "上游应结算：$120.00\n平台留存（上游应结算 − 渠道结算）：$60.00\n渠道结算：$60.00") ||
			!strings.Contains(text, "账号：Shanghai GAM（Network 123）\n渠道：Test\n数据日：2026-11-10（Asia/Shanghai）\n流水：$100.00\n上游应结算：$80.00\n平台留存：$40.00\n渠道结算：$40.00") ||
			!strings.Contains(text, "2026-11-11（Pacific/Kiritimati）") ||
			strings.Contains(text, "已同步明细：") || strings.Contains(text, "匹配率：") || strings.Contains(text, "点击率：") {
			t.Errorf("unexpected report content: %s", text)
		}
		return nil
	}
	for _, instant := range []time.Time{before, now, now.Add(time.Minute), now.Add(20 * time.Minute), now.Add(30 * time.Minute)} {
		if err := a.runBotReportAt(context.Background(), instant, sender); err != nil {
			t.Fatal(err)
		}
	}
	if sends != 1 {
		t.Fatalf("sent %d times, want once", sends)
	}
	var status string
	if err := a.db.QueryRow("SELECT status FROM bot_report_deliveries WHERE report_date='2026-11-10'").Scan(&status); err != nil || status != "sent" {
		t.Fatalf("delivery status=%s error=%v", status, err)
	}
}

func TestBotReportNamesEachActualDomainChannel(t *testing.T) {
	a := testApp(t)
	for _, statement := range []string{
		"INSERT INTO channels(id,name,email,share_percent) VALUES(1,'Zhao','zhao@example.test',70),(2,'Rinser','rinser@example.test',70)",
		"INSERT INTO soap_accounts(id,name,network_code,credential_ciphertext,created_by,status,rest_sync_enabled,rest_network_timezone,rest_channel_id) VALUES(1,'GAM','123','test','admin','active',1,'Asia/Shanghai',2)",
		"INSERT INTO upstream_accounts(id,account_key,name,share_percent,status) VALUES(1,'acct','Account',100,'active')",
		"INSERT INTO revenue_facts(channel_id,report_date,url,domain,account,ad_unit,ad_unit_id,revenue,source_file) VALUES(1,'2026-11-18','https://news.youxiglobal.xyz','news.youxiglobal.xyz','acct','unit','1',10,'gam-rest:123:today'),(2,'2026-11-18','https://other.test','other.test','acct','unit','2',20,'gam-rest:123:today')",
	} {
		if _, err := a.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 11, 18, 14, 0, 0, 0, time.UTC)
	totals, err := a.botReportTotalsAt(now)
	if err != nil {
		t.Fatal(err)
	}
	accounts := totals["accounts"].([]map[string]any)
	if len(accounts) != 2 || accounts[0]["channelName"] != "Zhao" || accounts[1]["channelName"] != "Rinser" {
		t.Fatalf("channel split=%+v", accounts)
	}
}
