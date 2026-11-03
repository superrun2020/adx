package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

type importField struct {
	name     string
	required bool
	aliases  []string
}

var importFields = []importField{
	{"date", true, []string{"date", "report_date", "day", "日期", "dimension_date"}},
	{"hour", false, []string{"hour", "小时", "dimension_hour"}},
	{"url", false, []string{"url", "link", "链接", "url_channel", "dimension_url", "dimension_url_channel"}},
	{"account", false, []string{"account", "账号", "child_network", "child_network_code", "dimension_child_network_code", "publisher"}},
	{"adUnit", false, []string{"ad_unit", "adunit", "unit", "广告单元", "ad_unit_name", "dimension_ad_unit_name"}},
	{"adUnitId", false, []string{"ad_unit_id", "dimension_ad_unit_id", "广告单元ID"}},
	{"country", false, []string{"country", "country_code", "国家", "dimension_country_name", "dimension_country_code"}},
	{"requests", false, []string{"requests", "ad_requests", "请求", "total_ad_requests", "metric_total_ad_requests", "ad_server_requests"}},
	{"matched", false, []string{"matched_requests", "matchedrequests", "matched", "匹配", "total_matched_requests", "metric_total_matched_requests", "ad_server_matched_requests"}},
	{"impressions", false, []string{"impressions", "展示", "total_impressions", "metric_total_impressions", "ad_server_impressions"}},
	{"clicks", false, []string{"clicks", "点击", "total_clicks", "metric_total_clicks", "ad_server_clicks"}},
	{"revenue", true, []string{"revenue", "earnings", "income", "收益", "收入", "total_revenue", "metric_total_revenue", "ad_server_cpm_and_cpc_revenue", "ad_exchange_revenue"}},
}
var canonicalNonWord = regexp.MustCompile("[^a-z0-9\\p{Han}]+")

func canonicalName(value string) string {
	return strings.Trim(canonicalNonWord.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "_"), "_")
}
func sourceKeys(row map[string]any, field importField) []string {
	result := make([]string, 0)
	for key := range row {
		for _, alias := range field.aliases {
			if canonicalName(key) == canonicalName(alias) {
				result = append(result, key)
				break
			}
		}
	}
	return result
}
func picked(row map[string]any, field string) (any, bool) {
	for _, definition := range importFields {
		if definition.name == field {
			keys := sourceKeys(row, definition)
			if len(keys) > 0 {
				return row[keys[0]], true
			}
			break
		}
	}
	return nil, false
}
func importString(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}
func importNumber(value any) float64 {
	if value == nil || importString(value) == "" {
		return 0
	}
	switch v := value.(type) {
	case float64:
		return v
	case json.Number:
		n, _ := v.Float64()
		return n
	case bool:
		if v {
			return 1
		}
		return 0
	}
	n, err := strconv.ParseFloat(importString(value), 64)
	if err != nil {
		return math.NaN()
	}
	return n
}
func jsonNumber(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return value
}
func importRowsFrom(input map[string]any) []any {
	if rows, ok := input["payload"].([]any); ok {
		return rows
	}
	if payload, ok := input["payload"].(map[string]any); ok {
		for _, key := range []string{"data", "rows"} {
			if rows, ok := payload[key].([]any); ok {
				return rows
			}
		}
	}
	return nil
}
func (a *app) validateImport(w http.ResponseWriter, r *http.Request) (map[string]any, int64, []any, bool) {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil, 0, nil, false
	}
	channel := fieldID(input, "channelId")
	rows := importRowsFrom(input)
	if channel == 0 || !a.exists("SELECT id FROM channels WHERE id=?", channel) || len(rows) == 0 || len(rows) > 200000 {
		writeError(w, 400, "invalid_import")
		return nil, 0, nil, false
	}
	return input, channel, rows, true
}
func (a *app) normalizeImport(row map[string]any, channel int64, file string) (map[string]any, bool, string, []string) {
	conflicts := make([]string, 0)
	for _, field := range importFields {
		if len(sourceKeys(row, field)) > 1 {
			conflicts = append(conflicts, field.name)
		}
	}
	dateValue, dateExists := picked(row, "date")
	revenueValue, revenueExists := picked(row, "revenue")
	date := importString(dateValue)
	if len(date) > 10 {
		date = date[:10]
	}
	hour := -1.0
	if v, ok := picked(row, "hour"); ok {
		hour = importNumber(v)
	}
	stringField := func(name string) string { v, _ := picked(row, name); return importString(v) }
	url := stringField("url")
	numberField := func(name string) float64 { v, _ := picked(row, name); return importNumber(v) }
	requests, matched, impressions, clicks, revenue := numberField("requests"), numberField("matched"), numberField("impressions"), numberField("clicks"), importNumber(revenueValue)
	raw, _ := json.Marshal(row)
	fact := map[string]any{"channelId": channel, "reportDate": date, "hour": jsonNumber(hour), "url": url, "domain": normalizedDomain(url), "account": stringField("account"), "adUnit": stringField("adUnit"), "adUnitId": stringField("adUnitId"), "country": stringField("country"), "requests": jsonNumber(requests), "matched": jsonNumber(matched), "impressions": jsonNumber(impressions), "clicks": jsonNumber(clicks), "revenue": jsonNumber(revenue), "sourceFile": file, "rawJson": string(raw)}
	nums := []float64{requests, matched, impressions, clicks, revenue}
	validNumbers := true
	for _, n := range nums {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
			validNumbers = false
		}
	}
	validHour := hour == -1 || (hour >= 0 && hour <= 23 && hour == math.Trunc(hour))
	valid := dateExists && importString(dateValue) != "" && revenueExists && importString(revenueValue) != "" && validDate(date) && validHour && len(conflicts) == 0 && validNumbers
	if valid {
		return fact, true, "", conflicts
	}
	if len(conflicts) > 0 {
		return fact, false, "ambiguous_fields", conflicts
	}
	return fact, false, "invalid_required_fields", conflicts
}
func (a *app) previewImport(w http.ResponseWriter, r *http.Request) {
	input, channel, rows, ok := a.validateImport(w, r)
	if !ok {
		return
	}
	file := fieldString(input, "fileName")
	if file == "" {
		file = "upload.json"
	}
	mappings := make([]map[string]string, 0)
	missing := make([]string, 0)
	preserved := make([]string, 0)
	detected := make([]string, 0)
	first, _ := rows[0].(map[string]any)
	if first == nil {
		first = map[string]any{}
	}
	recognized := make(map[string]bool)
	for key := range first {
		detected = append(detected, key)
	}
	for _, field := range importFields {
		keys := sourceKeys(first, field)
		if len(keys) > 0 {
			mappings = append(mappings, map[string]string{"field": field.name, "source": keys[0]})
			recognized[keys[0]] = true
		} else if field.required {
			missing = append(missing, field.name)
		}
	}
	for _, key := range detected {
		if !recognized[key] {
			preserved = append(preserved, key)
		}
	}
	preview := make([]any, 0, 20)
	conflictSet := make(map[string]bool)
	accepted := 0
	for _, value := range rows {
		row, _ := value.(map[string]any)
		fact, valid, code, conflicts := a.normalizeImport(row, channel, file)
		if valid {
			accepted++
		}
		for _, c := range conflicts {
			conflictSet[c] = true
		}
		if len(preview) < 20 {
			if valid {
				preview = append(preview, fact)
			} else {
				preview = append(preview, map[string]any{"error": code, "conflictingFields": conflicts, "source": fact})
			}
		}
	}
	conflicting := make([]string, 0)
	for _, field := range importFields {
		if conflictSet[field.name] {
			conflicting = append(conflicting, field.name)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "totalRows": len(rows), "accepted": accepted, "rejected": len(rows) - accepted, "detectedFields": detected, "fieldMappings": mappings, "missingRequiredFields": missing, "conflictingFields": conflicting, "preservedFields": preserved, "preview": preview})
}
func (a *app) importRows(w http.ResponseWriter, r *http.Request) {
	input, channel, rows, ok := a.validateImport(w, r)
	if !ok {
		return
	}
	file := fieldString(input, "fileName")
	if file == "" {
		file = "upload.json"
	}
	if len(file) > 190 {
		file = file[:190]
	}
	if strings.HasPrefix(strings.ToLower(file), "gam-rest:") {
		writeError(w, 400, "reserved_import_source")
		return
	}
	facts := make([]map[string]any, 0, len(rows))
	firstDate, lastDate := "", ""
	for _, value := range rows {
		row, _ := value.(map[string]any)
		fact, valid, _, _ := a.normalizeImport(row, channel, file)
		if valid {
			facts = append(facts, fact)
			date := fact["reportDate"].(string)
			if firstDate == "" || date < firstDate {
				firstDate = date
			}
			if date > lastDate {
				lastDate = date
			}
		}
	}
	if len(facts) == 0 {
		writeError(w, 422, "no_valid_rows")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	statement, err := tx.PrepareContext(r.Context(), "INSERT INTO revenue_facts(channel_id,report_date,hour,url,domain,account,ad_unit,ad_unit_id,country,requests,matched_requests,impressions,clicks,revenue,source_file,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,report_date,hour,url,account,ad_unit,ad_unit_id,country) DO UPDATE SET requests=excluded.requests,matched_requests=excluded.matched_requests,impressions=excluded.impressions,clicks=excluded.clicks,revenue=excluded.revenue,domain=excluded.domain,source_file=excluded.source_file,raw_json=excluded.raw_json,imported_at=CURRENT_TIMESTAMP")
	if err != nil {
		serverError(w, err)
		return
	}
	defer statement.Close()
	for _, f := range facts {
		_, err = statement.ExecContext(r.Context(), f["channelId"], f["reportDate"], f["hour"], f["url"], f["domain"], f["account"], f["adUnit"], f["adUnitId"], f["country"], f["requests"], f["matched"], f["impressions"], f["clicks"], f["revenue"], f["sourceFile"], f["rawJson"])
		if err != nil {
			serverError(w, err)
			return
		}
	}
	rejected := len(rows) - len(facts)
	status, summary := "success", ""
	if rejected > 0 {
		status = "partial"
		summary = fmt.Sprintf("%d rows rejected", rejected)
	}
	result, err := tx.ExecContext(r.Context(), "INSERT INTO import_runs(actor_email,channel_id,source_file,total_rows,accepted_rows,rejected_rows,status,error_summary) VALUES(?,?,?,?,?,?,?,?)", currentUser(r).Email, channel, file, len(rows), len(facts), rejected, status, summary)
	if err != nil {
		serverError(w, err)
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.refreshDailySafely(channel, firstDate, lastDate)
	a.audit(currentUser(r).Email, "data.import", "import", id, marshalText(map[string]any{"channelId": channel, "fileName": file, "total": len(rows), "accepted": len(facts), "rejected": rejected}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "runId": id, "total": len(rows), "accepted": len(facts), "rejected": rejected})
}
func (a *app) importRuns(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT r.id,r.source_file sourceFile,r.total_rows totalRows,r.accepted_rows acceptedRows,r.rejected_rows rejectedRows,r.status,r.created_at createdAt,c.name channelName FROM import_runs r JOIN channels c ON c.id=r.channel_id ORDER BY r.id DESC LIMIT 100")
}
