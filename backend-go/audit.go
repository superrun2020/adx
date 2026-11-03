package main

import "net/http"

func (a *app) auditLogs(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200")
}
