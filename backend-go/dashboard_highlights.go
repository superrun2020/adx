package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type dashboardAccountPeriod struct {
	code, today, monthStart string
}

func dashboardPeriods(accounts []map[string]any, now time.Time) ([]dashboardAccountPeriod, []string) {
	periods := make([]dashboardAccountPeriod, 0, len(accounts))
	warnings := []string{}
	for _, account := range accounts {
		code := importString(account["network_code"])
		zone := importString(account["rest_network_timezone"])
		location, err := time.LoadLocation(zone)
		if zone == "" || err != nil {
			location = time.UTC
			warnings = append(warnings, importString(account["name"]))
		}
		local := now.In(location)
		periods = append(periods, dashboardAccountPeriod{
			code: code, today: local.Format("2006-01-02"), monthStart: local.Format("2006-01") + "-01",
		})
	}
	return periods, warnings
}

func (a *app) queryDashboardHighlights(periods []dashboardAccountPeriod, month bool, scope int64, channel bool) ([]map[string]any, error) {
	if len(periods) == 0 {
		return []map[string]any{}, nil
	}
	conditions := make([]string, 0, len(periods))
	args := make([]any, 0, len(periods)*4+1)
	ready := a.restDailyReady.Load()
	for _, period := range periods {
		start := period.today
		if month {
			start = period.monthStart
		}
		if ready {
			conditions = append(conditions, "(rd.network_code=? AND rd.report_date BETWEEN ? AND ?)")
			args = append(args, period.code, start, period.today)
		} else {
			prefix := "gam-rest:" + period.code
			conditions = append(conditions, "(rf.source_file>=? AND rf.source_file<? AND rf.report_date BETWEEN ? AND ?)")
			args = append(args, prefix+":", prefix+";", start, period.today)
		}
	}
	where := "(" + strings.Join(conditions, " OR ") + ")"
	alias, source := "rf", "revenue_facts rf"
	if ready {
		alias, source = "rd", "dashboard_rest_daily rd"
	}
	if scope > 0 {
		where += " AND " + alias + ".channel_id=?"
		args = append(args, scope)
	}
	factor := alias + ".revenue"
	if channel {
		if ready {
			factor = "rd.settled_revenue"
		} else {
			factor = settledRevenueSQL("rf")
		}
	}
	domain := mappedDomainSQL("rf")
	if ready {
		domain = "rd.domain"
	}
	query := fmt.Sprintf("SELECT %s url,SUM(%s.impressions) impressions,ROUND(SUM(%s),6) revenue FROM %s WHERE %s GROUP BY %s ORDER BY revenue DESC LIMIT 10", domain, alias, factor, source, where, domain)
	return queryMaps(a.db, query, args...)
}

func (a *app) dashboardHighlights(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	var scope int64
	if u.Role == "channel" {
		scope = u.ChannelID.Int64
	} else if raw := r.URL.Query().Get("channelId"); raw != "" {
		var err error
		scope, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || scope < 1 {
			writeError(w, 400, "invalid_channel_id")
			return
		}
	}
	accounts, err := queryMaps(a.db, "SELECT name,network_code,rest_network_timezone FROM soap_accounts WHERE rest_report_name<>'' ORDER BY id")
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	periods, warnings := dashboardPeriods(accounts, time.Now())
	daily, err := a.queryDashboardHighlights(periods, false, scope, u.Role == "channel")
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	monthly, err := a.queryDashboardHighlights(periods, true, scope, u.Role == "channel")
	if err != nil {
		a.dashboardFailure(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "daily": daily, "monthly": monthly, "timeZoneWarnings": warnings})
}
