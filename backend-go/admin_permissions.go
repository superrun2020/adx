package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

var adminSidebarViews = []string{"dashboard", "gam", "links", "ad-units", "reports", "regression", "channels", "settlement", "report-keys", "api"}

func validSidebarPermissions(value any) ([]string, error) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 || len(items) > len(adminSidebarViews) {
		return nil, errors.New("invalid_sidebar_permissions")
	}
	allowed := make(map[string]bool, len(adminSidebarViews))
	for _, view := range adminSidebarViews {
		allowed[view] = true
	}
	seen := make(map[string]bool, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		view, ok := item.(string)
		if !ok || !allowed[view] || seen[view] {
			return nil, errors.New("invalid_sidebar_permissions")
		}
		seen[view] = true
		result = append(result, view)
	}
	return result, nil
}

func (u user) sidebarViews() []string {
	if u.Role != "admin" {
		return []string{"dashboard", "reports", "api"}
	}
	if u.IsSuperAdmin || !u.SidebarPermissions.Valid {
		return append([]string(nil), adminSidebarViews...)
	}
	var views []string
	if json.Unmarshal([]byte(u.SidebarPermissions.String), &views) != nil {
		return []string{}
	}
	return views
}

func (u user) canView(view string) bool {
	if view == "admins" {
		return u.Role == "admin" && u.IsSuperAdmin
	}
	if u.Role != "admin" {
		return view == "dashboard" || view == "reports" || view == "api"
	}
	for _, allowed := range u.sidebarViews() {
		if allowed == view {
			return true
		}
	}
	return false
}

func (u user) allowedRequest(r *http.Request) bool {
	if u.Role != "admin" || u.IsSuperAdmin {
		return true
	}
	path, method := r.URL.Path, r.Method
	views := []string{}
	switch {
	case path == "/api/auth/me" || path == "/api/auth/logout":
		return true
	case path == "/api/dashboard" || path == "/api/dashboard/highlights":
		views = []string{"dashboard"}
	case path == "/api/reports" || path == "/api/reports/export" || path == "/api/admin/reports/accounts":
		views = []string{"reports"}
	case strings.HasPrefix(path, "/api/admin/users") || path == "/api/admin/audit":
		return false
	case strings.HasPrefix(path, "/api/admin/report-api-keys"):
		views = []string{"report-keys"}
	case strings.HasPrefix(path, "/api/admin/regression/"):
		views = []string{"regression"}
	case path == "/api/admin/gam-accounts" && method == http.MethodGet:
		views = []string{"gam", "links", "ad-units", "regression"}
	case strings.HasPrefix(path, "/api/admin/gam-accounts/") && method == http.MethodGet &&
		(strings.HasSuffix(path, "/sites") || strings.HasSuffix(path, "/site-domains")):
		views = []string{"gam", "links", "ad-units"}
	case strings.HasPrefix(path, "/api/admin/gam-accounts/") && method == http.MethodGet && strings.HasSuffix(path, "/ad-units"):
		views = []string{"gam", "ad-units"}
	case strings.HasPrefix(path, "/api/admin/gam-accounts") || strings.HasPrefix(path, "/api/admin/gam-sync/"):
		views = []string{"gam"}
	case strings.HasPrefix(path, "/api/admin/gam-ad-units") || strings.HasPrefix(path, "/api/admin/ad-units"):
		views = []string{"ad-units"}
	case path == "/api/admin/channels" && method == http.MethodGet:
		views = []string{"channels", "settlement", "gam", "reports"}
	case strings.HasPrefix(path, "/api/admin/channels"):
		views = []string{"channels"}
	case path == "/api/admin/upstream-accounts" && method == http.MethodGet:
		views = []string{"settlement", "gam", "reports"}
	case strings.HasPrefix(path, "/api/admin/upstream-accounts") || strings.HasPrefix(path, "/api/admin/ad-unit-domains") ||
		strings.HasPrefix(path, "/api/admin/share-rules") || strings.HasPrefix(path, "/api/admin/domain-share-rules"):
		views = []string{"settlement"}
	case strings.HasPrefix(path, "/api/admin/imports"):
		views = []string{"reports"}
	default:
		return false
	}
	for _, view := range views {
		if u.canView(view) {
			return true
		}
	}
	return false
}

func adminPermissionsJSON(views []string) string {
	encoded, _ := json.Marshal(views)
	return string(encoded)
}

func adminPermissionsFromRow(row map[string]any) sql.NullString {
	value := row["sidebar_permissions"]
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: importString(value), Valid: true}
}
