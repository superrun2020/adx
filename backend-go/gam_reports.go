package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"
	_ "time/tzdata"
)

var gamReportDimensions = []string{"DATE", "HOUR", "SITE", "COUNTRY_CODE", "AD_UNIT_NAME", "AD_UNIT_ID"}
var gamLegacyDimensions = gamReportDimensions[:5]
var gamReportMetrics = []string{"AD_EXCHANGE_TOTAL_REQUESTS", "AD_EXCHANGE_RESPONSES_SERVED", "AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_CLICKS", "AD_EXCHANGE_REVENUE"}

func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func array(value any) []any           { result, _ := value.([]any); return result }
func dateObject(value string) (map[string]int, error) {
	if !validDate(value) {
		return nil, errors.New("invalid_report_date")
	}
	date, _ := time.Parse("2006-01-02", value)
	return map[string]int{"year": date.Year(), "month": int(date.Month()), "day": date.Day()}, nil
}
func reportDefinition(start, end string) (map[string]any, error) {
	from, err := dateObject(start)
	if err != nil {
		return nil, err
	}
	through, err := dateObject(end)
	if err != nil {
		return nil, err
	}
	first, _ := time.Parse("2006-01-02", start)
	last, _ := time.Parse("2006-01-02", end)
	if start > end || last.Sub(first) > 31*24*time.Hour {
		return nil, errors.New("invalid_report_range")
	}
	return map[string]any{"dimensions": gamReportDimensions, "metrics": gamReportMetrics, "timeZoneSource": "PUBLISHER", "currencyCode": "USD", "dateRange": map[string]any{"fixed": map[string]any{"startDate": from, "endDate": through}}, "reportType": "HISTORICAL"}, nil
}
func stringSlice(value any) []string {
	entries := array(value)
	result := make([]string, len(entries))
	for i, v := range entries {
		result[i] = importString(v)
	}
	return result
}
func validateGamReport(report map[string]any, network string, allowLegacy bool) (map[string]any, error) {
	name := importString(report["name"])
	if err := resourceForNetwork(reportPattern, name, network, "invalid_rest_report_name"); err != nil {
		return nil, err
	}
	definition := object(report["reportDefinition"])
	dimensions := stringSlice(definition["dimensions"])
	if !reflect.DeepEqual(dimensions, gamReportDimensions) && !(allowLegacy && reflect.DeepEqual(dimensions, gamLegacyDimensions)) || !reflect.DeepEqual(stringSlice(definition["metrics"]), gamReportMetrics) || definition["reportType"] != "HISTORICAL" || definition["currencyCode"] != "USD" || definition["timeZoneSource"] != "PUBLISHER" || definition["comparisonDateRange"] != nil || definition["timePeriodColumn"] != nil {
		return nil, errors.New("rest_report_definition_mismatch")
	}
	return definition, nil
}
func (a *app) createRestReport(ctx context.Context, network, token, start, end string) (map[string]any, error) {
	definition, err := reportDefinition(start, end)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"displayName": "AdX Control REST sync " + network, "visibility": "HIDDEN", "reportDefinition": definition}
	report, err := a.gamRequest(ctx, network, token, "networks/"+network+"/reports", http.MethodPost, nil, body)
	if err != nil {
		return nil, err
	}
	_, err = validateGamReport(report, network, false)
	return report, err
}
func (a *app) setRestReportRange(ctx context.Context, network, token, name, start, end string) (map[string]any, error) {
	if err := resourceForNetwork(reportPattern, name, network, "invalid_rest_report_name"); err != nil {
		return nil, err
	}
	desired, err := reportDefinition(start, end)
	if err != nil {
		return nil, err
	}
	current, err := a.gamRequest(ctx, network, token, name, http.MethodGet, nil, nil)
	if err != nil {
		return nil, err
	}
	definition, err := validateGamReport(current, network, true)
	if err != nil {
		return nil, err
	}
	mask := "reportDefinition.dateRange"
	patch := map[string]any{"name": name, "reportDefinition": map[string]any{"dateRange": desired["dateRange"]}}
	if !reflect.DeepEqual(stringSlice(definition["dimensions"]), gamReportDimensions) {
		mask += ",reportDefinition.dimensions"
		object(patch["reportDefinition"])["dimensions"] = gamReportDimensions
	}
	report, err := a.gamRequest(ctx, network, token, name, http.MethodPatch, url.Values{"updateMask": {mask}}, patch)
	if err == nil {
		_, err = validateGamReport(report, network, false)
	}
	if err == nil {
		return report, nil
	}
	if strings.Contains(mask, "dimensions") && (strings.HasPrefix(err.Error(), "gam_http_400:") || strings.HasPrefix(err.Error(), "gam_http_409:") || err.Error() == "rest_report_definition_mismatch") {
		return a.createRestReport(ctx, network, token, start, end)
	}
	return nil, err
}

type restResult struct {
	rows       []any
	dateRanges []any
	name       string
}

func (a *app) fetchRestReport(ctx context.Context, network, token, name string) (restResult, error) {
	if err := resourceForNetwork(reportPattern, name, network, "invalid_rest_report_name"); err != nil {
		return restResult{}, err
	}
	operation, err := a.gamRequest(ctx, network, token, name+":run", http.MethodPost, nil, nil)
	if err != nil {
		return restResult{}, err
	}
	operationName := importString(operation["name"])
	if err := resourceForNetwork(operationPattern, operationName, network, "invalid_rest_report_operation"); err != nil {
		return restResult{}, err
	}
	for attempt := 0; operation["done"] != true && attempt < 60; attempt++ {
		delay := time.Duration(float64(5*time.Second) * math.Pow(1.4, float64(attempt)))
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		if err := sleepContext(ctx, delay); err != nil {
			return restResult{}, err
		}
		operation, err = a.gamRequest(ctx, network, token, operationName, http.MethodGet, nil, nil)
		if err != nil {
			return restResult{}, err
		}
	}
	if operation["done"] != true {
		return restResult{}, errors.New("rest_report_timeout")
	}
	if failure := object(operation["error"]); failure != nil {
		return restResult{}, fmt.Errorf("rest_report_failed: %s", importString(failure["message"]))
	}
	resultName := importString(object(operation["response"])["reportResult"])
	if err := resourceForNetwork(resultPattern, resultName, network, "invalid_rest_report_result"); err != nil {
		return restResult{}, err
	}
	result := restResult{name: resultName, rows: make([]any, 0)}
	seen := make(map[string]bool)
	pageToken := ""
	for {
		query := url.Values{"pageSize": {"10000"}}
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		page, err := a.gamRequest(ctx, network, token, resultName+":fetchRows", http.MethodGet, query, nil)
		if err != nil {
			return restResult{}, err
		}
		if result.dateRanges == nil {
			result.dateRanges = array(page["dateRanges"])
		}
		result.rows = append(result.rows, array(page["rows"])...)
		if len(result.rows) > 200000 {
			return restResult{}, errors.New("rest_report_too_large")
		}
		pageToken = importString(page["nextPageToken"])
		if pageToken == "" {
			break
		}
		if seen[pageToken] {
			return restResult{}, errors.New("rest_report_repeated_page")
		}
		seen[pageToken] = true
	}
	if len(result.dateRanges) != 1 {
		return restResult{}, errors.New("rest_report_date_ranges_mismatch")
	}
	return result, nil
}
func restScalar(value any) (any, error) {
	entry := object(value)
	for _, key := range []string{"intValue", "doubleValue", "stringValue"} {
		if v, ok := entry[key]; ok {
			return v, nil
		}
	}
	return nil, errors.New("missing_rest_report_value")
}
func restInteger(value any) (int64, error) {
	scalar, err := restScalar(value)
	if err != nil {
		return 0, err
	}
	number := importNumber(scalar)
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 9007199254740991 || number != math.Trunc(number) {
		return 0, errors.New("invalid_rest_report_integer")
	}
	return int64(number), nil
}
func restDate(value any) (string, error) {
	scalar, err := restScalar(value)
	if err != nil {
		return "", err
	}
	raw := importString(scalar)
	if len(raw) == 8 && strings.IndexFunc(raw, func(r rune) bool { return r < '0' || r > '9' }) == -1 {
		raw = raw[:4] + "-" + raw[4:6] + "-" + raw[6:]
	}
	if !validDate(raw) {
		return "", errors.New("invalid_report_date")
	}
	return raw, nil
}
func restString(value any) (string, error) {
	scalar, err := restScalar(value)
	if err != nil {
		return "", err
	}
	return importString(scalar), nil
}
func normalizeRestRows(rows []any, channelID int64, accountKey, sourceFile string, divisor int64) ([]map[string]any, error) {
	if channelID < 1 || accountKey == "" || (divisor != 1 && divisor != 1000000) {
		return nil, errors.New("invalid_rest_report_mapping")
	}
	facts := make([]map[string]any, 0, len(rows))
	for _, value := range rows {
		row := object(value)
		dimensions := array(row["dimensionValues"])
		groups := array(row["metricValueGroups"])
		if (len(dimensions) != 5 && len(dimensions) != 6) || len(groups) != 1 {
			return nil, errors.New("rest_report_columns_mismatch")
		}
		metrics := array(object(groups[0])["primaryValues"])
		if len(metrics) != 5 {
			return nil, errors.New("rest_report_columns_mismatch")
		}
		date, err := restDate(dimensions[0])
		if err != nil {
			return nil, err
		}
		hour, err := restInteger(dimensions[1])
		if err != nil {
			return nil, err
		}
		if hour > 23 {
			return nil, errors.New("invalid_rest_report_hour")
		}
		urlValue, err := restString(dimensions[2])
		if err != nil {
			return nil, err
		}
		country, err := restString(dimensions[3])
		if err != nil {
			return nil, err
		}
		unit, err := restString(dimensions[4])
		if err != nil {
			return nil, err
		}
		unitID := ""
		if len(dimensions) == 6 {
			unitID, err = restString(dimensions[5])
			if err != nil {
				return nil, err
			}
		}
		nums := make([]int64, 4)
		for index := 0; index < 4; index++ {
			nums[index], err = restInteger(metrics[index])
			if err != nil {
				return nil, err
			}
		}
		scalar, err := restScalar(metrics[4])
		if err != nil {
			return nil, err
		}
		revenue := importNumber(scalar)
		if math.IsNaN(revenue) || math.IsInf(revenue, 0) {
			return nil, errors.New("invalid_rest_report_revenue")
		}
		raw, _ := json.Marshal(row)
		facts = append(facts, map[string]any{"channelId": channelID, "reportDate": date, "hour": hour, "url": urlValue, "account": accountKey, "adUnit": unit, "adUnitId": unitID, "country": country, "requests": nums[0], "matched": nums[1], "impressions": nums[2], "clicks": nums[3], "revenue": revenue / float64(divisor), "sourceFile": sourceFile, "rawJson": string(raw)})
	}
	return facts, nil
}
func dateRangeMatches(value any, from, end string) bool {
	rangeValue := object(value)
	dateText := func(value any) string {
		parts := object(value)
		return fmt.Sprintf("%04d-%02d-%02d", int(numberValue(parts["year"])), int(numberValue(parts["month"])), int(numberValue(parts["day"])))
	}
	return dateText(rangeValue["startDate"]) == from && dateText(rangeValue["endDate"]) == end
}
func localGamDate(timezone string, offset int) (string, error) {
	return localGamDateAt(timezone, time.Now(), offset)
}
func localGamDateAt(timezone string, instant time.Time, offset int) (string, error) {
	if timezone == "" {
		return "", errors.New("invalid_network_timezone")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return "", errors.New("invalid_network_timezone")
	}
	now := instant.In(location)
	return time.Date(now.Year(), now.Month(), now.Day()+offset, 0, 0, 0, 0, location).Format("2006-01-02"), nil
}
func intMap(value map[string]any, key string) int64 { return int64(numberValue(value[key])) }
