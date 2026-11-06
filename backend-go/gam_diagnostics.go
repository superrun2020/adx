package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

var diagnosticDimensions = map[string]string{
	"device":  "DEVICE_CATEGORY_NAME",
	"browser": "BROWSER_NAME",
	"demand":  "DEMAND_CHANNEL_NAME",
}
var diagnosticMetrics = []string{
	"AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE",
	"AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS",
	"AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS",
}

func diagnosticDefinition(kind, start, end string) (map[string]any, error) {
	dimension := diagnosticDimensions[kind]
	if dimension == "" || !validDate(start) || !validDate(end) || start > end {
		return nil, errors.New("invalid_diagnostic_range")
	}
	from, _ := dateObject(start)
	through, _ := dateObject(end)
	first, _ := time.Parse("2006-01-02", start)
	last, _ := time.Parse("2006-01-02", end)
	if last.Sub(first) > 31*24*time.Hour {
		return nil, errors.New("invalid_diagnostic_range")
	}
	return map[string]any{
		"dimensions": []string{"DATE", dimension}, "metrics": diagnosticMetrics,
		"timeZoneSource": "PUBLISHER", "currencyCode": "USD", "reportType": "HISTORICAL",
		"dateRange": map[string]any{"fixed": map[string]any{"startDate": from, "endDate": through}},
	}, nil
}

func validateDiagnosticReport(report map[string]any, network, kind string) error {
	if err := resourceForNetwork(reportPattern, importString(report["name"]), network, "invalid_diagnostic_report_name"); err != nil {
		return err
	}
	definition := object(report["reportDefinition"])
	if !reflect.DeepEqual(stringSlice(definition["dimensions"]), []string{"DATE", diagnosticDimensions[kind]}) ||
		!reflect.DeepEqual(stringSlice(definition["metrics"]), diagnosticMetrics) ||
		definition["timeZoneSource"] != "PUBLISHER" || definition["currencyCode"] != "USD" || definition["reportType"] != "HISTORICAL" {
		return errors.New("diagnostic_report_definition_mismatch")
	}
	return nil
}

func (a *app) prepareDiagnosticReport(ctx context.Context, account map[string]any, token, kind, start, end string) (string, error) {
	network := importString(account["network_code"])
	definition, err := diagnosticDefinition(kind, start, end)
	if err != nil {
		return "", err
	}
	var existingNetwork, name string
	err = a.db.QueryRowContext(ctx, "SELECT network_code,report_name FROM gam_diagnostic_reports WHERE account_id=? AND kind=?", intMap(account, "id"), kind).Scan(&existingNetwork, &name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if existingNetwork == network && name != "" {
		current, getErr := a.gamRequest(ctx, network, token, name, http.MethodGet, nil, nil)
		if getErr == nil {
			if err = validateDiagnosticReport(current, network, kind); err != nil {
				return "", err
			}
			patch := map[string]any{"name": name, "reportDefinition": map[string]any{"dateRange": definition["dateRange"]}}
			updated, patchErr := a.gamRequest(ctx, network, token, name, http.MethodPatch, url.Values{"updateMask": {"reportDefinition.dateRange"}}, patch)
			if patchErr != nil {
				return "", patchErr
			}
			if err = validateDiagnosticReport(updated, network, kind); err != nil {
				return "", err
			}
			return name, nil
		}
		if !strings.HasPrefix(getErr.Error(), "gam_http_404:") {
			return "", getErr
		}
	}
	body := map[string]any{"displayName": "AdX Control diagnostics " + kind + " " + network,
		"visibility": "HIDDEN", "reportDefinition": definition}
	report, err := a.gamRequest(ctx, network, token, "networks/"+network+"/reports", http.MethodPost, nil, body)
	if err != nil {
		return "", err
	}
	if err = validateDiagnosticReport(report, network, kind); err != nil {
		return "", err
	}
	name = importString(report["name"])
	_, err = a.db.ExecContext(ctx, "INSERT INTO gam_diagnostic_reports(account_id,kind,network_code,report_name) VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET network_code=excluded.network_code,report_name=excluded.report_name,last_synced_at=NULL,last_error=''", intMap(account, "id"), kind, network, name)
	return name, err
}

type diagnosticFact struct {
	date, category                    string
	impressions, measurable, viewable int64
	revenue                           float64
}

func normalizeDiagnosticRows(rows []any, start, end string, divisor int64) ([]diagnosticFact, error) {
	if divisor != 1 && divisor != 1000000 {
		return nil, errors.New("invalid_diagnostic_divisor")
	}
	facts := make([]diagnosticFact, 0, len(rows))
	seen := make(map[[2]string]bool, len(rows))
	for _, value := range rows {
		row := object(value)
		dimensions, groups := array(row["dimensionValues"]), array(row["metricValueGroups"])
		if len(dimensions) != 2 || len(groups) != 1 {
			return nil, errors.New("diagnostic_columns_mismatch")
		}
		metrics := array(object(groups[0])["primaryValues"])
		if len(metrics) != 4 {
			return nil, errors.New("diagnostic_columns_mismatch")
		}
		date, err := restDate(dimensions[0])
		if err != nil {
			return nil, err
		}
		category, err := restString(dimensions[1])
		if err != nil {
			return nil, err
		}
		category = strings.TrimSpace(category)
		if date < start || date > end || category == "" {
			return nil, errors.New("invalid_diagnostic_row")
		}
		key := [2]string{date, category}
		if seen[key] {
			return nil, errors.New("duplicate_diagnostic_row")
		}
		seen[key] = true
		impressions, err := restInteger(metrics[0])
		if err != nil {
			return nil, err
		}
		revenueValue, err := restScalar(metrics[1])
		if err != nil {
			return nil, err
		}
		revenue := importNumber(revenueValue) / float64(divisor)
		if math.IsNaN(revenue) || math.IsInf(revenue, 0) {
			return nil, errors.New("invalid_diagnostic_revenue")
		}
		measurable, err := restInteger(metrics[2])
		if err != nil {
			return nil, err
		}
		viewable, err := restInteger(metrics[3])
		if err != nil {
			return nil, err
		}
		if viewable > measurable {
			return nil, errors.New("invalid_diagnostic_viewability")
		}
		facts = append(facts, diagnosticFact{date, category, impressions, measurable, viewable, revenue})
	}
	return facts, nil
}

func (a *app) syncDiagnosticKind(ctx context.Context, account map[string]any, kind, start, end string) error {
	token, err := a.tokenFor(ctx, account)
	if err != nil {
		return err
	}
	name, err := a.prepareDiagnosticReport(ctx, account, token, kind, start, end)
	if err != nil {
		return err
	}
	result, err := a.fetchRestReport(ctx, importString(account["network_code"]), token, name)
	if err != nil {
		return err
	}
	if !dateRangeMatches(result.dateRanges[0], start, end) {
		return errors.New("diagnostic_range_mismatch")
	}
	facts, err := normalizeDiagnosticRows(result.rows, start, end, intMap(account, "rest_money_divisor"))
	if err != nil {
		return err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	id, network := intMap(account, "id"), importString(account["network_code"])
	if _, err = tx.ExecContext(ctx, "DELETE FROM gam_diagnostic_facts WHERE account_id=? AND network_code<>?", id, network); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM gam_diagnostic_facts WHERE account_id=? AND network_code=? AND kind=? AND report_date BETWEEN ? AND ?", id, network, kind, start, end); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO gam_diagnostic_facts(account_id,network_code,report_date,kind,category,impressions,revenue,measurable_impressions,viewable_impressions) VALUES(?,?,?,?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	for _, fact := range facts {
		_, err = stmt.ExecContext(ctx, id, network, fact.date, kind, fact.category, fact.impressions, fact.revenue, fact.measurable, fact.viewable)
		if err != nil {
			break
		}
	}
	stmt.Close()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE gam_diagnostic_reports SET last_synced_at=CURRENT_TIMESTAMP,last_error='',last_attempt_at=CURRENT_TIMESTAMP WHERE account_id=? AND kind=?", id, kind)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (a *app) runScheduledDiagnostics() {
	a.diagnosticMu.Lock()
	if a.diagnosticBusy {
		a.diagnosticMu.Unlock()
		return
	}
	a.diagnosticBusy = true
	a.diagnosticMu.Unlock()
	defer func() { a.diagnosticMu.Lock(); a.diagnosticBusy = false; a.diagnosticMu.Unlock() }()
	accounts, err := queryMaps(a.db, "SELECT * FROM soap_accounts WHERE status='active' AND rest_sync_enabled=1 AND enabled=1")
	if err != nil {
		log.Printf("gam_diagnostics_accounts_failed: %v", err)
		return
	}
	for _, account := range accounts {
		timezone := importString(account["rest_network_timezone"])
		end, err := localGamDate(timezone, 0)
		if err != nil {
			log.Printf("gam_diagnostics_timezone_failed account=%d: %v", intMap(account, "id"), err)
			continue
		}
		for _, kind := range []string{"device", "browser", "demand"} {
			var lastAttempt string
			_ = a.db.QueryRow("SELECT COALESCE(last_attempt_at,'') FROM gam_diagnostic_reports WHERE account_id=? AND kind=?", intMap(account, "id"), kind).Scan(&lastAttempt)
			if attempted, parseErr := time.Parse("2006-01-02 15:04:05", lastAttempt); parseErr == nil && time.Since(attempted) < time.Hour {
				continue
			}
			var count int
			_ = a.db.QueryRow("SELECT COUNT(*) FROM gam_diagnostic_facts WHERE account_id=? AND network_code=? AND kind=?", intMap(account, "id"), importString(account["network_code"]), kind).Scan(&count)
			start, err := localGamDate(timezone, -1)
			if count == 0 {
				start, err = localGamDate(timezone, -29)
			}
			if err != nil {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
			if err = a.syncDiagnosticKind(ctx, account, kind, start, end); err != nil {
				log.Printf("gam_diagnostics_failed account=%d kind=%s: %v", intMap(account, "id"), kind, err)
				_, _ = a.db.Exec("INSERT INTO gam_diagnostic_reports(account_id,kind,network_code,last_error,last_attempt_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(account_id,kind) DO UPDATE SET last_error=excluded.last_error,last_attempt_at=CURRENT_TIMESTAMP", intMap(account, "id"), kind, importString(account["network_code"]), err.Error())
			}
			cancel()
		}
	}
}

func (a *app) diagnosticReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start, end, kind := q.Get("start"), q.Get("end"), q.Get("kind")
	if !validDate(start) || !validDate(end) || start > end || diagnosticDimensions[kind] == "" {
		writeError(w, 400, "invalid_diagnostic_query")
		return
	}
	accountID := q.Get("accountId")
	where, args := "f.report_date BETWEEN ? AND ? AND f.kind=? AND f.network_code=s.network_code", []any{start, end, kind}
	if accountID != "" {
		id, err := strconv.ParseInt(accountID, 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_diagnostic_account")
			return
		}
		where += " AND f.account_id=?"
		args = append(args, id)
	}
	query := "SELECT f.category,SUM(f.impressions) impressions,ROUND(SUM(f.revenue),6) revenue,SUM(f.measurable_impressions) measurableImpressions,SUM(f.viewable_impressions) viewableImpressions,CASE WHEN SUM(f.measurable_impressions)>0 THEN ROUND(100.0*SUM(f.viewable_impressions)/SUM(f.measurable_impressions),2) ELSE 0 END viewability FROM gam_diagnostic_facts f JOIN soap_accounts s ON s.id=f.account_id WHERE " + where + " GROUP BY f.category ORDER BY revenue DESC LIMIT 200"
	items, err := queryMaps(a.db, query, args...)
	if err != nil {
		writeError(w, 500, "diagnostic_query_failed")
		return
	}
	status, err := queryMaps(a.db, "SELECT s.id accountId,s.name accountName,? kind,d.last_synced_at lastSyncedAt,COALESCE(d.last_error,'') lastError FROM soap_accounts s LEFT JOIN gam_diagnostic_reports d ON d.account_id=s.id AND d.network_code=s.network_code AND d.kind=? WHERE s.status='active' AND s.enabled=1 AND s.rest_sync_enabled=1 AND (?='' OR s.id=?) ORDER BY s.id", kind, kind, accountID, accountID)
	if err != nil {
		writeError(w, 500, "diagnostic_status_failed")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": items, "status": status})
}
