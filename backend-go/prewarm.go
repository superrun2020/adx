package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"net/http/httptest"
	"time"
)

// Keep the default signed-in views hot using the same user-scoped handlers as HTTP.
// This reads already-imported SQLite data; it never waits for Google on login.
func (a *app) warmDefaultReports() {
	if a.reportCache == nil {
		return
	}
	started := time.Now()
	today := started.Format("2006-01-02")
	monthStart := started.Format("2006-01") + "-01"
	users, err := queryMaps(a.db, "SELECT id,role,channel_id FROM users WHERE status='active' AND role IN ('admin','channel') ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,id LIMIT 64")
	if err != nil {
		log.Printf("report_cache_users_failed: %v", err)
		return
	}
	views := []struct {
		path    string
		handler http.HandlerFunc
	}{
		{"/api/dashboard?start=" + monthStart + "&end=" + today, a.cachedReport(a.dashboard)},
		{"/api/reports?start=" + monthStart + "&end=" + today + "&dimensions=url%2CadUnit%2CadUnitId&page=1&pageSize=50&source=rest", a.cachedReport(a.reports)},
	}
	warmed := 0
	for _, row := range users {
		u := user{ID: intMap(row, "id"), Role: importString(row["role"])}
		if channelID := intMap(row, "channel_id"); channelID > 0 {
			u.ChannelID = sql.NullInt64{Int64: channelID, Valid: true}
		}
		for _, view := range views {
			request := httptest.NewRequest(http.MethodGet, view.path, nil)
			request = request.WithContext(context.WithValue(request.Context(), userKey{}, u))
			response := httptest.NewRecorder()
			view.handler(response, request)
			if response.Code == http.StatusOK {
				warmed++
			} else {
				log.Printf("report_cache_warm_failed user=%d status=%d path=%s", u.ID, response.Code, request.URL.Path)
			}
		}
	}
	log.Printf("report_cache_warmed views=%d users=%d duration_ms=%d", warmed, len(users), time.Since(started).Milliseconds())
}
