package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type coverageCount struct{ Requests, Matched int64 }
type coveragePair struct{ Before, After coverageCount }
type coverageNotice struct {
	ID     int64
	Domain string
	Before coverageCount
	After  coverageCount
}

func coveragePercent(count coverageCount) float64 {
	if count.Requests <= 0 {
		return 0
	}
	return float64(count.Matched) * 100 / float64(count.Requests)
}

func coverageQualified(pair coveragePair, config regressionConfig) bool {
	return pair.Before.Requests >= config.MinCoverageRequests &&
		pair.After.Requests >= config.MinCoverageRequests &&
		coveragePercent(pair.Before)-coveragePercent(pair.After) >= config.MinCoverageDropPoints-1e-9
}

// Archive actions made in this dashboard remove those units from both comparison hours.
func (a *app) coverageArchivedUnits(ctx context.Context, network string, now time.Time) (map[string]bool, error) {
	rows, err := a.db.QueryContext(ctx, "SELECT action,detail FROM audit_logs WHERE target_id=? AND created_at<=? AND action IN ('gam.ad_unit_archive','gam.ad_unit_activate') ORDER BY id", network, now.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := map[string]bool{}
	prefix := "networks/" + network + "/adUnits/"
	for rows.Next() {
		var action, detail string
		if err := rows.Scan(&action, &detail); err != nil {
			return nil, err
		}
		var record struct{ Names []string }
		if json.Unmarshal([]byte(detail), &record) != nil {
			continue
		}
		for _, name := range record.Names {
			if strings.HasPrefix(name, prefix) {
				states[strings.TrimPrefix(name, prefix)] = action == "gam.ad_unit_archive"
			}
		}
	}
	return states, rows.Err()
}

func (a *app) coverageHourlyPairs(ctx context.Context, account map[string]any, current, baseline string, hour int, now time.Time) (map[string]coveragePair, error) {
	_, key, err := a.gamMapping(account)
	if err != nil {
		return nil, err
	}
	network := importString(account["network_code"])
	archived, err := a.coverageArchivedUnits(ctx, network, now)
	if err != nil {
		return nil, err
	}
	rows, err := a.db.QueryContext(ctx, "SELECT report_date,domain,ad_unit_id,SUM(requests),SUM(matched_requests) FROM revenue_facts WHERE account=? AND report_date IN (?,?) AND hour=? AND domain<>'' AND source_file LIKE ? GROUP BY report_date,domain,ad_unit_id", key, current, baseline, hour, "gam-rest:"+network+":%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pairs := map[string]coveragePair{}
	for rows.Next() {
		var date, domain, unitID string
		var requests, matched int64
		if err := rows.Scan(&date, &domain, &unitID, &requests, &matched); err != nil {
			return nil, err
		}
		if archived[unitID] {
			continue
		}
		pair := pairs[domain]
		if date == current {
			pair.After.Requests += requests
			pair.After.Matched += matched
		} else {
			pair.Before.Requests += requests
			pair.Before.Matched += matched
		}
		pairs[domain] = pair
	}
	return pairs, rows.Err()
}

func coverageAlertMessage(account map[string]any, channel, date, baseline, zone string, hour int, now time.Time, notices []coverageNotice) string {
	lines := []string{"【AdX 覆盖率下降】",
		fmt.Sprintf("账号：%s（%s）", importString(account["name"]), importString(account["network_code"])),
		fmt.Sprintf("数据：%s %02d:00–%02d:59（%s；对比 %s 同小时）", date, hour, hour, zone, baseline)}
	for _, item := range notices {
		before, after := coveragePercent(item.Before), coveragePercent(item.After)
		lines = append(lines, fmt.Sprintf("%s（渠道：%s）：%.2f%% → %.2f%%（降 %.2f 个百分点；请求 %d → %d）",
			item.Domain, channel, before, after, before-after, item.Before.Requests, item.After.Requests))
	}
	lines = append(lines, "发现："+now.In(mustCoverageLocation(zone)).Format("2006-01-02 15:04"))
	return strings.Join(lines, "\n")
}

func mustCoverageLocation(zone string) *time.Location {
	location, err := time.LoadLocation(zone)
	if err != nil {
		return time.UTC
	}
	return location
}

func (a *app) coverageEvents(w http.ResponseWriter, r *http.Request) {
	a.listCoverageEvents(w, r, 0)
}

func (a *app) listCoverageEvents(w http.ResponseWriter, r *http.Request, channelID int64) {
	q := r.URL.Query()
	where := []string{"1=1"}
	args := []any{}
	if channelID > 0 {
		where = append(where, channelDomainOwnerAtSQL("e.domain", "e.report_date")+"=?")
		args = append(args, channelID)
	}
	if raw := q.Get("accountId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_gam_account")
			return
		}
		where = append(where, "e.soap_account_id=?")
		args = append(args, id)
	}
	if domain := strings.TrimSpace(q.Get("domain")); domain != "" {
		if len(domain) > 253 {
			writeError(w, 400, "invalid_domain")
			return
		}
		where = append(where, "e.domain LIKE ?")
		args = append(args, "%"+domain+"%")
	}
	if start, end := q.Get("start"), q.Get("end"); start != "" || end != "" {
		if (start != "" && !validDate(start)) || (end != "" && !validDate(end)) || (start != "" && end != "" && start > end) {
			writeError(w, 400, "invalid_report_date")
			return
		}
		if start != "" {
			where = append(where, "e.report_date>=?")
			args = append(args, start)
		}
		if end != "" {
			where = append(where, "e.report_date<=?")
			args = append(args, end)
		}
	}
	rows, err := queryMaps(a.db, "SELECT e.id,e.report_date reportDate,e.report_hour reportHour,e.domain,s.name accountName,s.network_code networkCode,s.rest_network_timezone timeZone,c.name channelName,e.baseline_requests baselineRequests,e.baseline_matched baselineMatched,e.current_requests currentRequests,e.current_matched currentMatched,e.status,e.attempts,e.sent_at sentAt,e.created_at createdAt FROM coverage_alerts e JOIN soap_accounts s ON s.id=e.soap_account_id LEFT JOIN channels c ON c.id=e.channel_id WHERE "+strings.Join(where, " AND ")+" ORDER BY e.id DESC LIMIT 100", args...)
	if err != nil {
		writeError(w, 500, "coverage_alerts_unavailable")
		return
	}
	for _, row := range rows {
		row["baselineCoverage"] = coveragePercent(coverageCount{Requests: int64(numberValue(row["baselineRequests"])), Matched: int64(numberValue(row["baselineMatched"]))})
		row["currentCoverage"] = coveragePercent(coverageCount{Requests: int64(numberValue(row["currentRequests"])), Matched: int64(numberValue(row["currentMatched"]))})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows})
}

// Run only after a successful REST sync. Compare the last complete account-local
// hour with the same hour yesterday and send at most once per domain and day.
func (a *app) runCoverageAlertsAt(ctx context.Context, account map[string]any, now time.Time,
	send func(context.Context, string, string, string) error) error {
	config, err := a.currentRegressionConfig()
	if err != nil || !config.CoverageEnabled || config.Ciphertext == "" {
		return err
	}
	zone := importString(account["rest_network_timezone"])
	location, err := time.LoadLocation(zone)
	if err != nil {
		return err
	}
	local := now.In(location)
	hour := local.Hour() - 1
	if hour < 0 {
		return nil
	}
	date, baseline := local.Format("2006-01-02"), local.AddDate(0, 0, -1).Format("2006-01-02")
	pairs, err := a.coverageHourlyPairs(ctx, account, date, baseline, hour, now)
	if err != nil || len(pairs) == 0 {
		return err
	}
	hasCurrentHour := false
	for _, pair := range pairs {
		if pair.After.Requests > 0 {
			hasCurrentHour = true
			break
		}
	}
	if !hasCurrentHour {
		return nil
	}
	accountID := intMap(account, "id")
	baseChannel, err := a.gamChannelForDate(accountID, intMap(account, "rest_channel_id"), date)
	if err != nil {
		return err
	}
	assignments, err := a.gamDomainChannelAssignments(date)
	if err != nil {
		return err
	}
	stamp := now.UTC().Format("2006-01-02 15:04:05")
	qualified := map[string]bool{}
	byChannel := map[int64][]coverageNotice{}
	for domain, pair := range pairs {
		if !coverageQualified(pair, config) {
			continue
		}
		qualified[domain] = true
		owner := channelForGamDomainDate(assignments, date, domain, baseChannel)
		if owner <= 0 {
			continue
		}
		_, err = a.db.ExecContext(ctx, "INSERT OR IGNORE INTO coverage_alerts(soap_account_id,report_date,report_hour,domain,channel_id,baseline_requests,baseline_matched,current_requests,current_matched) VALUES(?,?,?,?,?,?,?,?,?)", accountID, date, hour, domain, owner, pair.Before.Requests, pair.Before.Matched, pair.After.Requests, pair.After.Matched)
		if err != nil {
			return err
		}
		var id, attempts int64
		var status string
		var last sql.NullString
		if err = a.db.QueryRowContext(ctx, "SELECT id,status,attempts,last_attempt_at FROM coverage_alerts WHERE soap_account_id=? AND report_date=? AND domain=?", accountID, date, domain).Scan(&id, &status, &attempts, &last); err != nil {
			return err
		}
		if status == "sent" || attempts >= 5 {
			continue
		}
		if last.Valid {
			previous, parseErr := time.Parse("2006-01-02 15:04:05", last.String)
			if parseErr == nil && now.Sub(previous) < 15*time.Minute {
				continue
			}
		}
		if _, err = a.db.ExecContext(ctx, "UPDATE coverage_alerts SET report_hour=?,channel_id=?,baseline_requests=?,baseline_matched=?,current_requests=?,current_matched=?,status='pending' WHERE id=?", hour, owner, pair.Before.Requests, pair.Before.Matched, pair.After.Requests, pair.After.Matched, id); err != nil {
			return err
		}
		byChannel[owner] = append(byChannel[owner], coverageNotice{ID: id, Domain: domain, Before: pair.Before, After: pair.After})
	}
	rows, err := a.db.QueryContext(ctx, "SELECT id,domain FROM coverage_alerts WHERE soap_account_id=? AND report_date=? AND status IN ('pending','failed')", accountID, date)
	if err != nil {
		return err
	}
	type pending struct {
		id     int64
		domain string
	}
	pendingRows := []pending{}
	for rows.Next() {
		var item pending
		if err = rows.Scan(&item.id, &item.domain); err != nil {
			break
		}
		pendingRows = append(pendingRows, item)
	}
	if rowErr := rows.Err(); err == nil {
		err = rowErr
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range pendingRows {
		if pair, present := pairs[item.domain]; present && pair.After.Requests > 0 && !qualified[item.domain] {
			if _, err := a.db.ExecContext(ctx, "UPDATE coverage_alerts SET status='recovered',error='' WHERE id=?", item.id); err != nil {
				return err
			}
		}
	}
	credential, err := a.decryptCredential(config.Ciphertext)
	if err != nil {
		return err
	}
	webhook, secret := importString(credential["url"]), importString(credential["secret"])
	channels := make([]int64, 0, len(byChannel))
	for channelID := range byChannel {
		channels = append(channels, channelID)
	}
	sort.Slice(channels, func(i, j int) bool { return channels[i] < channels[j] })
	for _, channelID := range channels {
		channelName := "未关联渠道"
		if err = a.db.QueryRowContext(ctx, "SELECT name FROM channels WHERE id=?", channelID).Scan(&channelName); err != nil && err != sql.ErrNoRows {
			return err
		}
		notices := byChannel[channelID]
		sort.Slice(notices, func(i, j int) bool { return notices[i].Domain < notices[j].Domain })
		for start := 0; start < len(notices); start += 20 {
			end := start + 20
			if end > len(notices) {
				end = len(notices)
			}
			batch := notices[start:end]
			sendErr := send(ctx, webhook, secret, coverageAlertMessage(account, channelName, date, baseline, zone, hour, now, batch))
			status, detail := "sent", ""
			if sendErr != nil {
				status, detail = "failed", sendErr.Error()
				if len(detail) > 500 {
					detail = detail[:500]
				}
				log.Printf("coverage_feishu_failed account=%d error=%v", accountID, sendErr)
			}
			for _, item := range batch {
				if _, err = a.db.ExecContext(ctx, "UPDATE coverage_alerts SET status=?,error=?,attempts=attempts+1,last_attempt_at=?,sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END WHERE id=?", status, detail, stamp, status, stamp, item.ID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
