package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"
)

func (a *app) gamNetwork(ctx context.Context, account map[string]any) (map[string]any, error) {
	network := importString(account["network_code"])
	token, err := a.tokenFor(ctx, account)
	if err != nil {
		return nil, err
	}
	result, err := a.gamRequest(ctx, network, token, "networks/"+network, http.MethodGet, nil, nil)
	if err != nil {
		return nil, err
	}
	if result["name"] != "networks/"+network || importString(result["timeZone"]) == "" {
		return nil, errors.New("gam_network_mismatch")
	}
	return result, nil
}
func (a *app) configureGam(ctx context.Context, account map[string]any, channelID, upstreamID, divisor int64, actor string) (map[string]any, error) {
	id := intMap(account, "id")
	if !a.lockGam(id) {
		return nil, errors.New("gam_account_busy")
	}
	defer a.unlockGam(id)
	if (divisor != 1 && divisor != 1000000) || !a.exists("SELECT id FROM channels WHERE id=? AND status='active'", channelID) || !a.exists("SELECT id FROM upstream_accounts WHERE id=? AND status='active' AND soap_account_id=?", upstreamID, id) {
		return nil, errors.New("invalid_rest_report_mapping")
	}
	network, err := a.gamNetwork(ctx, account)
	if err != nil {
		return nil, err
	}
	code := importString(account["network_code"])
	token, err := a.tokenFor(ctx, account)
	if err != nil {
		return nil, err
	}
	timezone := importString(network["timeZone"])
	today, err := localGamDate(timezone, 0)
	if err != nil {
		return nil, err
	}
	yesterday, err := localGamDate(timezone, -1)
	if err != nil {
		return nil, err
	}
	reportName := importString(account["rest_report_name"])
	if reportName != "" {
		report, err := a.gamRequest(ctx, code, token, reportName, http.MethodGet, nil, nil)
		if err != nil {
			return nil, err
		}
		if _, err = validateGamReport(report, code, true); err != nil {
			return nil, err
		}
	} else {
		report, err := a.createRestReport(ctx, code, token, yesterday, today)
		if err != nil {
			return nil, err
		}
		reportName = importString(report["name"])
	}
	_, err = a.db.ExecContext(ctx, "UPDATE soap_accounts SET rest_report_name=?,rest_channel_id=?,rest_upstream_account_id=?,rest_money_divisor=?,rest_sync_enabled=0,rest_last_preview_at=NULL,rest_last_preview_rows=0,rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", reportName, channelID, upstreamID, divisor, timezone, id)
	if err != nil {
		return nil, err
	}
	a.audit(actor, "gam.report_configure", "gam_account", id, marshalText(map[string]any{"reportName": reportName, "channelId": channelID, "upstreamAccountId": upstreamID, "moneyDivisor": divisor}), "")
	return map[string]any{"reportName": reportName, "channelId": channelID, "upstreamAccountId": upstreamID, "moneyDivisor": divisor, "timeZone": timezone}, nil
}
func (a *app) gamMapping(account map[string]any) (int64, string, error) {
	id, channelID, upstreamID, divisor := intMap(account, "id"), intMap(account, "rest_channel_id"), intMap(account, "rest_upstream_account_id"), intMap(account, "rest_money_divisor")
	if importString(account["rest_report_name"]) == "" || channelID == 0 || upstreamID == 0 || (divisor != 1 && divisor != 1000000) {
		return 0, "", errors.New("rest_report_not_configured")
	}
	if !a.exists("SELECT id FROM channels WHERE id=? AND status='active'", channelID) {
		return 0, "", errors.New("rest_report_mapping_inactive")
	}
	upstream, err := firstMap(a.db, "SELECT account_key accountKey FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'", upstreamID, id)
	if err != nil {
		return 0, "", errors.New("rest_report_mapping_inactive")
	}
	return channelID, importString(upstream["accountKey"]), nil
}
func (a *app) executeGam(ctx context.Context, account map[string]any, start, end string, write bool) (out map[string]any, failure error) {
	id := intMap(account, "id")
	if !a.lockGam(id) {
		return nil, errors.New("gam_account_busy")
	}
	defer a.unlockGam(id)
	begun := time.Now()
	timings := map[string]int64{}
	checkpoint := func(stage string) { timings[stage] = time.Since(begun).Milliseconds() }
	channelID, accountKey, err := a.gamMapping(account)
	if err != nil {
		return nil, err
	}
	timezone := importString(account["rest_network_timezone"])
	if timezone == "" {
		network, networkErr := a.gamNetwork(ctx, account)
		if networkErr != nil {
			return nil, networkErr
		}
		timezone = importString(network["timeZone"])
		if _, err = a.db.ExecContext(ctx, "UPDATE soap_accounts SET rest_network_timezone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", timezone, id); err != nil {
			return nil, err
		}
	}
	if start == "" {
		start, err = localGamDate(timezone, -1)
		if err != nil {
			return nil, err
		}
	}
	if end == "" {
		end, err = localGamDate(timezone, 0)
		if err != nil {
			return nil, err
		}
	}
	if !validDate(start) || !validDate(end) {
		return nil, errors.New("invalid_report_date")
	}
	first, _ := time.Parse("2006-01-02", start)
	last, _ := time.Parse("2006-01-02", end)
	if start > end || last.Sub(first) > 31*24*time.Hour {
		return nil, errors.New("invalid_report_range")
	}
	var runID int64
	if write {
		runID, err = execID(a.db, "INSERT INTO soap_sync_runs(soap_account_id,channel_id,window_start,window_end,status,stage) VALUES(?,?,?,?,'running','authorizing')", id, channelID, start, end)
		if err != nil {
			return nil, err
		}
		defer func() {
			if failure == nil {
				return
			}
			detail := failure.Error()
			if len(detail) > 1000 {
				detail = detail[:1000]
			}
			_, _ = a.db.Exec("UPDATE soap_sync_runs SET status='failed',stage='failed',error=?,timings_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", detail, marshalText(timings), runID)
		}()
	}
	stage := func(value string) {
		if write {
			_, _ = a.db.ExecContext(ctx, "UPDATE soap_sync_runs SET stage=? WHERE id=?", value, runID)
		}
	}
	result, err := a.fetchAndNormalizeGam(ctx, account, channelID, accountKey, start, end, write, runID, stage, checkpoint)
	if err != nil {
		return nil, err
	}
	code := importString(account["network_code"])
	facts := result.facts
	if write {
		stage("writing")
		tx, err := a.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		_, err = tx.ExecContext(ctx, "DELETE FROM revenue_facts WHERE channel_id=? AND account=? AND report_date BETWEEN ? AND ? AND source_file LIKE ?", channelID, accountKey, start, end, "gam-rest:"+code+":%")
		if err != nil {
			return nil, err
		}
		statement, err := tx.PrepareContext(ctx, "INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP")
		if err != nil {
			return nil, err
		}
		for _, f := range facts {
			_, err = statement.ExecContext(ctx, f["channelId"], f["reportDate"], f["hour"], f["url"], f["domain"], f["account"], f["adUnit"], f["adUnitId"], f["country"], f["requests"], f["matched"], f["impressions"], f["clicks"], f["revenue"], f["sourceFile"], f["rawJson"])
			if err != nil {
				break
			}
		}
		statement.Close()
		if err != nil {
			return nil, err
		}
		if result.reportName != importString(account["rest_report_name"]) {
			_, err = tx.ExecContext(ctx, "UPDATE soap_accounts SET rest_report_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", result.reportName, id)
			if err != nil {
				return nil, err
			}
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		a.refreshDailySafely(channelID, start, end)
		checkpoint("persist")
		_, err = a.db.ExecContext(ctx, "UPDATE soap_sync_runs SET status='success',stage='complete',rows_read=?,rows_written=?,timings_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?", result.rowsRead, len(facts), marshalText(timings), runID)
		if err != nil {
			return nil, err
		}
	} else {
		_, err = a.db.ExecContext(ctx, "UPDATE soap_accounts SET rest_last_preview_at=CURRENT_TIMESTAMP,rest_last_preview_rows=? WHERE id=?", len(facts), id)
		if err != nil {
			return nil, err
		}
		if result.reportName != importString(account["rest_report_name"]) {
			_, err = a.db.ExecContext(ctx, "UPDATE soap_accounts SET rest_report_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", result.reportName, id)
			if err != nil {
				return nil, err
			}
		}
	}
	total := 0.0
	for _, f := range facts {
		total += numberValue(f["revenue"])
	}
	output := map[string]any{"start": start, "end": end, "rows": len(facts), "revenue": total, "moneyDivisor": intMap(account, "rest_money_divisor"), "timingsMs": timings}
	if !write {
		sample := make([]map[string]any, 0)
		for index, f := range facts {
			if index >= 10 {
				break
			}
			copy := make(map[string]any, len(f))
			for k, v := range f {
				if k != "rawJson" {
					copy[k] = v
				}
			}
			sample = append(sample, copy)
		}
		output["sample"] = sample
	}
	return output, nil
}

type gamNormalized struct {
	facts      []map[string]any
	rowsRead   int
	reportName string
}

func (a *app) fetchAndNormalizeGam(ctx context.Context, account map[string]any, channelID int64, accountKey, start, end string, write bool, runID int64, stage func(string), checkpoint func(string)) (gamNormalized, error) {
	network := importString(account["network_code"])
	token, err := a.tokenFor(ctx, account)
	if err != nil {
		return gamNormalized{}, err
	}
	checkpoint("oauth")
	stage("preparing_report")
	active, err := a.setRestReportRange(ctx, network, token, importString(account["rest_report_name"]), start, end)
	if err != nil {
		return gamNormalized{}, err
	}
	if _, err = validateGamReport(active, network, false); err != nil {
		return gamNormalized{}, err
	}
	checkpoint("report_setup")
	stage("fetching_report")
	fetched, err := a.fetchRestReport(ctx, network, token, importString(active["name"]))
	if err != nil {
		return gamNormalized{}, err
	}
	checkpoint("remote_report")
	if write {
		_, _ = a.db.ExecContext(ctx, "UPDATE soap_sync_runs SET rows_read=? WHERE id=?", len(fetched.rows), runID)
	}
	if !dateRangeMatches(fetched.dateRanges[0], start, end) {
		return gamNormalized{}, errors.New("rest_report_range_mismatch")
	}
	source := "gam-rest:" + network + ":" + start + "_" + end
	facts, err := normalizeRestRows(fetched.rows, channelID, accountKey, source, intMap(account, "rest_money_divisor"))
	if err != nil {
		return gamNormalized{}, err
	}
	for _, fact := range facts {
		date := importString(fact["reportDate"])
		if date < start || date > end {
			return gamNormalized{}, errors.New("rest_report_row_outside_range")
		}
		raw := importString(fact["url"])
		if raw == "" {
			raw = domainFromAdUnit(importString(fact["adUnit"]))
		}
		fact["url"] = raw
		fact["domain"] = normalizedDomain(raw)
	}
	checkpoint("normalize")
	return gamNormalized{facts: facts, rowsRead: len(fetched.rows), reportName: importString(active["name"])}, nil
}
func (a *app) activateGam(account map[string]any, actor string) error {
	id := intMap(account, "id")
	if intMap(account, "enabled") != 1 {
		return errors.New("invalid_gam_account_status")
	}
	if importString(account["rest_report_name"]) == "" || account["rest_last_preview_at"] == nil || intMap(account, "rest_last_preview_rows") < 1 {
		return errors.New("rest_preview_required")
	}
	if _, _, err := a.gamMapping(account); err != nil {
		return err
	}
	_, err := a.db.Exec("UPDATE soap_accounts SET rest_sync_enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?", id)
	if err != nil {
		return err
	}
	a.audit(actor, "gam.sync_activate", "gam_account", id, marshalText(map[string]any{"reportName": account["rest_report_name"]}), "")
	return nil
}
func (a *app) pauseGam(account map[string]any, actor string) error {
	id := intMap(account, "id")
	_, err := a.db.Exec("UPDATE soap_accounts SET rest_sync_enabled=0,updated_at=CURRENT_TIMESTAMP WHERE id=?", id)
	if err == nil {
		a.audit(actor, "gam.sync_pause", "gam_account", id, "", "")
	}
	return err
}
func (a *app) runScheduledGamSync() {
	a.gamMu.Lock()
	if a.gamScheduled {
		a.gamMu.Unlock()
		return
	}
	a.gamScheduled = true
	a.gamMu.Unlock()
	defer func() { a.gamMu.Lock(); a.gamScheduled = false; a.gamMu.Unlock() }()
	accounts, err := queryMaps(a.db, "SELECT * FROM soap_accounts WHERE status='active' AND rest_sync_enabled=1 AND enabled=1")
	if err != nil {
		log.Printf("gam_rest_sync_accounts_failed: %v", err)
		return
	}
	for offset := 0; offset < len(accounts); offset += 2 {
		end := offset + 2
		if end > len(accounts) {
			end = len(accounts)
		}
		group := accounts[offset:end]
		done := make(chan struct{}, len(group))
		for _, account := range group {
			go func(account map[string]any) {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
				defer cancel()
				result, err := a.executeGam(ctx, account, "", "", true)
				if err != nil {
					log.Printf("gam_rest_sync_failed account=%d error=%v", intMap(account, "id"), err)
				} else {
					log.Printf("gam_rest_sync_complete account=%d timings=%s", intMap(account, "id"), marshalText(result["timingsMs"]))
				}
				done <- struct{}{}
			}(account)
		}
		for range group {
			<-done
		}
	}
	a.warmDefaultReports()
}
