package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var reportDimensions = map[string]string{
	"date": "rf.report_date", "hour": "rf.hour", "url": mappedDomainSQL("rf"),
	"country": "rf.country", "adUnit": "rf.ad_unit", "adUnitId": "rf.ad_unit_id",
	"account": "rf.account", "channel": "rf.channel_id",
	"advertiser": "COALESCE(NULLIF(sa.advertiser,''),ua.advertiser,'')", "bd": "COALESCE(NULLIF(sa.bd,''),ua.bd,'')",
}

var reportMetrics = map[string]bool{
	"requests": true, "matchedRequests": true, "impressions": true, "clicks": true,
	"revenue": true, "matchRate": true, "impressionRate": true, "clickRate": true,
	"ecpm": true, "upstreamRevenue": true, "channelRevenue": true,
	"grossProfit": true, "upstreamSharePercent": true, "channelSharePercent": true,
}

func selectedKeys(raw string, defaults string, allowed map[string]bool) []string {
	if raw == "" {
		raw = defaults
	}
	seen := make(map[string]bool)
	keys := make([]string, 0)
	for _, key := range strings.Split(raw, ",") {
		if allowed[key] && !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	return keys
}

func dimensionKeys(raw string) []string {
	allowed := make(map[string]bool, len(reportDimensions))
	for key := range reportDimensions {
		allowed[key] = true
	}
	return selectedKeys(raw, "date,url", allowed)
}

func validPage(raw string, fallback, maximum int) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil && n >= 1 && n <= maximum
}

var labelledDomain = regexp.MustCompile("(?i)(?:^|[_-])lb-((?:[a-z0-9](?:[a-z0-9-]*\\.)+)[a-z]{2,})(?:$|[-_])")
var embeddedDomain = regexp.MustCompile("(?i)(?:^|[-_])((?:[a-z0-9](?:[a-z0-9-]*\\.)+)[a-z]{2,})(?:$|[-_])")

func normalizedDomain(raw string) string {
	raw = strings.TrimSpace(raw)
	if parsed, err := url.Parse(raw); err == nil && parsed.Hostname() != "" {
		return strings.ToLower(parsed.Hostname())
	}
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "https://"), "http://")
	return strings.ToLower(strings.Split(raw, "/")[0])
}

func domainFromAdUnit(value string) string {
	if match := labelledDomain.FindStringSubmatch(value); len(match) > 1 {
		return normalizedDomain(match[1])
	}
	if match := embeddedDomain.FindStringSubmatch(value); len(match) > 1 {
		return normalizedDomain(match[1])
	}
	return ""
}

func domainInfo(raw string) (string, string, string) {
	domain := normalizedDomain(raw)
	parts := strings.Split(domain, ".")
	suffix := 2
	if len(parts) > 2 {
		last := strings.Join(parts[len(parts)-2:], ".")
		if last == "co.uk" || last == "com.cn" || last == "com.au" || last == "co.jp" || last == "co.kr" {
			suffix = 3
		}
	}
	main := domain
	if len(parts) >= suffix {
		main = strings.Join(parts[len(parts)-suffix:], ".")
	}
	if domain != "" && domain == main {
		return domain, main, "主域名"
	}
	return domain, main, "子域名"
}

func (a *app) reports(w http.ResponseWriter, r *http.Request)       { a.serveReports(w, r, false) }
func (a *app) reportsExport(w http.ResponseWriter, r *http.Request) { a.serveReports(w, r, true) }

func (a *app) serveReports(w http.ResponseWriter, r *http.Request, export bool) {
	started := time.Now()
	q := r.URL.Query()
	dimensions := dimensionKeys(q.Get("dimensions"))
	if len(dimensions) == 0 || len(dimensions) > 10 {
		writeError(w, 400, "invalid_report_dimensions")
		return
	}
	u := currentUser(r)
	isAdmin := u.Role == "admin"
	for _, key := range dimensions {
		if !isAdmin && (key == "channel" || key == "advertiser" || key == "bd") {
			writeError(w, 403, "report_dimension_forbidden")
			return
		}
	}
	if !isAdmin && (q.Get("advertiser") != "" || q.Get("bd") != "") {
		writeError(w, 403, "report_filter_forbidden")
		return
	}
	start, end := reportRange(r)
	if start > end {
		writeError(w, 400, "invalid_report_range")
		return
	}
	page, ok := validPage(q.Get("page"), 1, 100000)
	if !ok {
		writeError(w, 400, "invalid_report_page")
		return
	}
	requested, ok := validPage(q.Get("pageSize"), 50, 50000)
	if !ok {
		writeError(w, 400, "invalid_report_page")
		return
	}
	pageSize := requested
	if export {
		pageSize = 50001
	} else if pageSize > 200 {
		pageSize = 200
	}
	where := []string{"rf.report_date BETWEEN ? AND ?"}
	args := []any{start, end}
	addExact := func(expression, value string) {
		if strings.TrimSpace(value) != "" {
			where = append(where, expression+"=? COLLATE NOCASE")
			args = append(args, strings.TrimSpace(value))
		}
	}
	if !isAdmin {
		where = append(where, "rf.channel_id=?")
		args = append(args, u.ChannelID.Int64)
	} else if raw := q.Get("channelId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_channel_id")
			return
		}
		where = append(where, "rf.channel_id=?")
		args = append(args, id)
	}
	switch q.Get("source") {
	case "", "all":
	case "rest":
		where = append(where, "rf.source_file LIKE 'gam-rest:%'")
	default:
		writeError(w, 400, "invalid_report_source")
		return
	}
	account := q.Get("account")
	if account == "" {
		account = q.Get("upstreamAccount")
	}
	addExact("rf.account", account)
	addExact("rf.ad_unit", q.Get("adUnit"))
	addExact("rf.ad_unit_id", q.Get("adUnitId"))
	addExact("rf.country", q.Get("country"))
	addExact(reportDimensions["advertiser"], q.Get("advertiser"))
	addExact(reportDimensions["bd"], q.Get("bd"))
	if q.Get("domain") != "" {
		addExact(mappedDomainSQL("rf"), normalizedDomain(q.Get("domain")))
	}
	if raw := q.Get("hour"); raw != "" {
		hour, err := strconv.Atoi(raw)
		if err != nil || hour < 0 || hour > 23 {
			writeError(w, 400, "invalid_report_hour")
			return
		}
		where = append(where, "rf.hour=?")
		args = append(args, hour)
	}
	if raw, present := q["drill"]; present {
		var drill map[string]any
		if len(raw) == 0 || json.Unmarshal([]byte(raw[0]), &drill) != nil || drill == nil || len(drill) > 10 {
			writeError(w, 400, "invalid_report_drill")
			return
		}
		for key, value := range drill {
			expression, allowed := reportDimensions[key]
			if !allowed || (!isAdmin && (key == "channel" || key == "advertiser" || key == "bd")) {
				writeError(w, 400, "invalid_report_drill")
				return
			}
			if value == nil {
				where = append(where, expression+" IS NULL")
				continue
			}
			switch value.(type) {
			case string, float64:
			default:
				writeError(w, 400, "invalid_report_drill")
				return
			}
			if len(fmt.Sprint(value)) > 500 {
				writeError(w, 400, "invalid_report_drill")
				return
			}
			where = append(where, expression+"=?")
			args = append(args, value)
		}
	}
	selects, groups := make([]string, 0, len(dimensions)), make([]string, 0, len(dimensions))
	for _, key := range dimensions {
		expression := reportDimensions[key]
		if key == "channel" {
			selects = append(selects, "rf.channel_id AS channelId,c.name AS channel")
		} else {
			selects = append(selects, expression+" AS "+key)
		}
		groups = append(groups, expression)
	}
	visible := "grossRevenue"
	if !isAdmin {
		visible = "channelRevenue"
	}
	rateSQL := map[string]string{
		"requests": "requests", "matchedRequests": "matchedRequests", "impressions": "impressions", "clicks": "clicks",
		"revenue": visible, "upstreamRevenue": "upstreamRevenue", "channelRevenue": "channelRevenue",
		"grossProfit": "upstreamRevenue*0.85-channelRevenue", "upstreamSharePercent": "upstreamSharePercent", "channelSharePercent": "channelSharePercent",
		"matchRate":      "CASE WHEN requests=0 THEN 0 ELSE matchedRequests*100.0/requests END",
		"impressionRate": "CASE WHEN matchedRequests=0 THEN 0 ELSE impressions*100.0/matchedRequests END",
		"clickRate":      "CASE WHEN impressions=0 THEN 0 ELSE clicks*100.0/impressions END",
		"ecpm":           "CASE WHEN impressions=0 THEN 0 ELSE " + visible + "*1000.0/impressions END",
	}
	metricWhere := make([]string, 0)
	metricArgs := make([]any, 0)
	for key, expression := range rateSQL {
		capitalized := strings.ToUpper(key[:1]) + key[1:]
		for _, bound := range []struct{ name, op string }{{"min", ">="}, {"max", "<="}} {
			if raw := q.Get(bound.name + capitalized); raw != "" {
				if !isAdmin && (key == "upstreamRevenue" || key == "grossProfit" || key == "upstreamSharePercent" || key == "channelSharePercent") {
					writeError(w, 403, "report_filter_forbidden")
					return
				}
				threshold, err := strconv.ParseFloat(raw, 64)
				if err != nil || math.IsNaN(threshold) || math.IsInf(threshold, 0) {
					writeError(w, 400, "invalid_report_metric_filter")
					return
				}
				metricWhere = append(metricWhere, expression+" "+bound.op+" ?")
				metricArgs = append(metricArgs, threshold)
			}
		}
	}
	upstream := upstreamShareSQL("rf")
	grouped := "WITH grouped AS (SELECT " + strings.Join(selects, ",") + ",MAX(rf.report_date) sortDate," +
		"SUM(rf.requests) requests,SUM(rf.matched_requests) matchedRequests,SUM(rf.impressions) impressions,SUM(rf.clicks) clicks," +
		"ROUND(SUM(rf.revenue),6) grossRevenue,ROUND(SUM(rf.revenue*(" + upstream + ")/100.0),6) upstreamRevenue," +
		"ROUND(SUM(" + settledRevenueSQL("rf") + "),6) channelRevenue," +
		"ROUND(AVG(" + upstream + "),2) upstreamSharePercent,ROUND(AVG(" + channelRuleShareSQL("rf") + "),2) channelSharePercent " +
		"FROM revenue_facts rf JOIN channels c ON c.id=rf.channel_id LEFT JOIN upstream_accounts ua ON ua.account_key=rf.account LEFT JOIN soap_accounts sa ON sa.id=ua.soap_account_id " +
		"WHERE " + strings.Join(where, " AND ") + " GROUP BY " + strings.Join(groups, ",") + ") "
	if len(metricWhere) > 0 {
		grouped += "SELECT grouped.*,COUNT(*) OVER() totalRows FROM grouped WHERE " + strings.Join(metricWhere, " AND ")
	} else {
		grouped += "SELECT grouped.*,COUNT(*) OVER() totalRows FROM grouped"
	}
	grouped += " ORDER BY sortDate DESC," + visible + " DESC LIMIT ? OFFSET ?"
	args = append(args, metricArgs...)
	offset := (page - 1) * pageSize
	if export {
		offset = 0
	}
	args = append(args, pageSize, offset)
	rows, err := queryMaps(a.db, grouped, args...)
	if err != nil {
		log.Printf("reports_query_failed: %v", err)
		writeError(w, 500, "internal_error")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	var total int64
	for _, row := range rows {
		if total == 0 {
			total = int64(numberValue(row["totalRows"]))
		}
		gross := numberValue(row["grossRevenue"])
		rawURL, hasURL := row["url"]
		delete(row, "grossRevenue")
		delete(row, "sortDate")
		delete(row, "totalRows")
		revenue := gross
		if !isAdmin {
			revenue = numberValue(row["channelRevenue"])
		}
		lookup := fmt.Sprint(rawURL)
		if rawURL == nil || lookup == "" {
			lookup = domainFromAdUnit(fmt.Sprint(row["adUnit"]))
		}
		domain, main, kind := domainInfo(lookup)
		if rawURL == nil || rawURL == "" {
			row["url"] = domain
		}
		if hasURL {
			row["rawUrl"] = rawURL
		}
		row["mainDomain"] = main
		row["domainType"] = kind
		row["revenue"] = revenue
		impressions, matched, requests, clicks := numberValue(row["impressions"]), numberValue(row["matchedRequests"]), numberValue(row["requests"]), numberValue(row["clicks"])
		row["ecpm"] = ratio(revenue*1000, impressions)
		row["matchRate"] = ratio(matched*100, requests)
		row["impressionRate"] = ratio(impressions*100, matched)
		row["clickRate"] = ratio(clicks*100, impressions)
		if isAdmin {
			row["grossProfit"] = numberValue(row["upstreamRevenue"])*0.85 - numberValue(row["channelRevenue"])
		} else {
			delete(row, "upstreamRevenue")
			delete(row, "upstreamSharePercent")
			delete(row, "channelSharePercent")
		}
		items = append(items, row)
	}
	if export {
		if len(rows) > 50000 {
			writeError(w, 413, "report_export_too_large")
			return
		}
		metrics := selectedKeys(q.Get("metrics"), "requests,matchedRequests,impressions,clicks,revenue,matchRate,impressionRate,clickRate,ecpm", reportMetrics)
		columns := append(append([]string{}, dimensions...), metrics...)
		if !isAdmin {
			columns = append([]string{}, dimensions...)
			for _, key := range metrics {
				if key != "upstreamRevenue" && key != "grossProfit" && key != "upstreamSharePercent" && key != "channelSharePercent" {
					columns = append(columns, key)
				}
			}
		}
		var output bytes.Buffer
		output.Write([]byte{0xef, 0xbb, 0xbf})
		output.WriteString(strings.Join(columns, ","))
		for _, item := range items {
			output.WriteString("\r\n")
			for i, key := range columns {
				if i > 0 {
					output.WriteByte(',')
				}
				value := ""
				if item[key] != nil {
					value = fmt.Sprint(item[key])
				}
				if reportDimensions[key] != "" {
					trimmed := strings.TrimLeft(value, " \t")
					if len(trimmed) > 0 && strings.Contains("=+@-", trimmed[:1]) {
						value = "'" + value
					}
				}
				output.WriteString("\"" + strings.ReplaceAll(value, "\"", "\"\"") + "\"")
			}
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=adx-report.csv")
		w.WriteHeader(200)
		_, _ = w.Write(output.Bytes())
		return
	}
	w.Header().Set("Server-Timing", fmt.Sprintf("reports;dur=%.1f", float64(time.Since(started).Microseconds())/1000))
	writeJSON(w, 200, map[string]any{"ok": true, "items": items, "total": total, "page": page, "pageSize": pageSize, "dimensions": dimensions})
}

func ratio(numerator, denominator float64) float64 {
	if denominator == 0 {
		return 0
	}
	return numerator / denominator
}
