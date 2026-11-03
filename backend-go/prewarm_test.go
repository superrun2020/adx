package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDefaultViewsArePrewarmedPerUser(t *testing.T) {
	a := testApp(t)
	a.warmDefaultReports()
	now := time.Now()
	start, end := now.Format("2006-01")+"-01", now.Format("2006-01-02")
	paths := []struct {
		path    string
		handler http.HandlerFunc
	}{
		{"/api/dashboard?end=" + end + "&start=" + start, a.cachedReport(a.dashboard)},
		{"/api/reports?source=rest&pageSize=50&page=1&dimensions=url%2CadUnit%2CadUnitId&end=" + end + "&start=" + start, a.cachedReport(a.reports)},
	}
	for _, view := range paths {
		request := httptest.NewRequest(http.MethodGet, view.path, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 1, Role: "admin"}))
		response := httptest.NewRecorder()
		view.handler(response, request)
		if response.Code != 200 || !strings.Contains(response.Header().Get("Server-Timing"), "app-cache;desc=\"hit\"") {
			t.Fatalf("prewarm miss for %s: status=%d timing=%s", view.path, response.Code, response.Header().Get("Server-Timing"))
		}
	}
	request := httptest.NewRequest(http.MethodGet, paths[0].path, nil)
	request = request.WithContext(context.WithValue(request.Context(), userKey{}, user{ID: 999, Role: "admin"}))
	response := httptest.NewRecorder()
	paths[0].handler(response, request)
	if !strings.Contains(response.Header().Get("Server-Timing"), "app-cache;desc=\"miss\"") {
		t.Fatalf("another user received a cached response: %s", response.Header().Get("Server-Timing"))
	}
}
