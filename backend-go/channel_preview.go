package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
)

func (a *app) channelPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || a.portalRole(r) == "channel" {
		writeError(w, http.StatusForbidden, "channel_preview_forbidden")
		return
	}

	path := "/" + r.PathValue("path")
	var handler http.HandlerFunc
	switch path {
	case "/api/auth/me":
		handler = a.me
	case "/api/dashboard":
		handler = a.cachedReport(a.dashboard)
	case "/api/dashboard/highlights":
		handler = a.cachedReport(a.dashboardHighlights)
	case "/api/reports":
		handler = a.cachedReport(a.reports)
	case "/api/reports/export":
		handler = a.reportsExport
	case "/api/channel/domains":
		handler = a.channelDomains
	case "/api/channel/contract":
		handler = a.channelContract
	case "/api/channel/contract/pdf":
		handler = a.channelContractPDF
	case "/api/channel/regression/events":
		handler = a.channelRegressionEvents
	case "/api/channel/regression/coverage-events":
		handler = a.channelCoverageEvents
	case "/api/public/channel-contract":
		handler = a.publicChannelContract
	default:
		writeError(w, http.StatusNotFound, "channel_preview_path_unavailable")
		return
	}

	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		writeError(w, http.StatusBadRequest, "invalid_channel_preview")
		return
	}
	target := user{Role: "channel"}
	err = a.db.QueryRowContext(r.Context(), "SELECT u.id,u.email,u.name,u.company_name,u.channel_id,u.status "+
		"FROM users u LEFT JOIN channels c ON c.id=u.channel_id WHERE u.id=? AND u.role='channel' AND "+
		"((u.status='active' AND c.status='active') OR (u.status='pending' AND u.channel_id IS NULL))", id).
		Scan(&target.ID, &target.Email, &target.Name, &target.CompanyName, &target.ChannelID, &target.Status)
	if err == sql.ErrNoRows {
		writeError(w, http.StatusNotFound, "channel_preview_unavailable")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if target.Status == "pending" && path != "/api/auth/me" && path != "/api/channel/contract" && path != "/api/public/channel-contract" {
		writeError(w, http.StatusForbidden, "registration_pending_review")
		return
	}
	if path == "/api/auth/me" {
		a.audit(currentUser(r).Email, "auth.channel_preview", "user", target.ID, "{}", clientIP(r))
	}

	// Reuse the publisher handlers with the selected channel's identity. The
	// original admin session remains outside the channel request context.
	preview := r.Clone(context.WithValue(r.Context(), userKey{}, target))
	preview.URL.Path = path
	preview.URL.RawPath = ""
	handler(w, preview)
}
