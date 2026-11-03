package main

import (
	"net/http"
	"strings"
)

func (a *app) channels(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT c.id,c.name,c.email,c.share_percent sharePercent,c.status,c.created_at createdAt,(SELECT COUNT(*) FROM channel_domains d WHERE d.channel_id=c.id) domainCount,CASE WHEN c.api_secret_hash IS NULL THEN 0 ELSE 1 END apiConfigured FROM channels c ORDER BY c.id DESC")
}

func (a *app) createChannel(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	name, email, password := fieldString(input, "name"), strings.ToLower(fieldString(input, "email")), fieldString(input, "password")
	share, valid := validShare(input, "sharePercent")
	if name == "" || email == "" || len(password) < 10 || !valid {
		writeError(w, 400, "invalid_channel")
		return
	}
	status := "active"
	if fieldString(input, "status") == "disabled" {
		status = "disabled"
	}
	secret, err := newSecret("adx_", 24)
	if err != nil {
		serverError(w, err)
		return
	}
	cipher, err := a.encryptCredential(map[string]string{"secret": secret})
	if err != nil {
		serverError(w, err)
		return
	}
	hash, err := passwordHash(password)
	if err != nil {
		serverError(w, err)
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.Exec("INSERT INTO channels(name,email,share_percent,status,api_secret_hash,api_secret_ciphertext) VALUES(?,?,?,?,?,?)", name, email, share, status, sha256Hex(secret), cipher)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, 409, "email_exists")
		} else {
			serverError(w, err)
		}
		return
	}
	id, _ := result.LastInsertId()
	if _, err = tx.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?)", id, share, "1900-01-01", currentUser(r).Email); err != nil {
		serverError(w, err)
		return
	}
	if _, err = tx.Exec("INSERT INTO users(email,name,password_hash,role,channel_id,status) VALUES(?,?,?,'channel',?,?)", email, name, hash, id, status); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.audit(currentUser(r).Email, "channel.create", "channel", id, marshalText(map[string]any{"name": name, "email": email, "share": share}), clientIP(r))
	item, _ := a.one("SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?", id)
	writeJSON(w, 201, map[string]any{"ok": true, "channel": item, "secret": secret})
}

func (a *app) updateChannel(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id := pathID(r)
	name := fieldString(input, "name")
	share, valid := validShare(input, "sharePercent")
	if id == 0 || name == "" || !valid {
		writeError(w, 400, "invalid_channel")
		return
	}
	status := "active"
	if fieldString(input, "status") == "disabled" {
		status = "disabled"
	}
	effective := fieldString(input, "effectiveFrom")
	if effective == "" {
		effective = dateToday()
	}
	if !validDate(effective) {
		writeError(w, 400, "invalid_effective_date")
		return
	}
	before, found := a.one("SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?", id)
	if !found {
		writeError(w, 404, "channel_not_found")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE channels SET name=?,share_percent=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", name, share, status, id); err != nil {
		serverError(w, err)
		return
	}
	if _, err = tx.Exec("UPDATE users SET name=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE channel_id=? AND role='channel'", name, status, id); err != nil {
		serverError(w, err)
		return
	}
	if _, err = tx.Exec("INSERT INTO channel_share_versions(channel_id,share_percent,effective_from,created_by) VALUES(?,?,?,?) ON CONFLICT(channel_id,effective_from) DO UPDATE SET share_percent=excluded.share_percent,created_by=excluded.created_by", id, share, effective, currentUser(r).Email); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	after, _ := a.one("SELECT id,name,email,share_percent sharePercent,status FROM channels WHERE id=?", id)
	a.audit(currentUser(r).Email, "channel.update", "channel", id, marshalText(map[string]any{"before": before, "after": after}), clientIP(r))
	a.refreshDailySafely(0, "", "")
	writeJSON(w, 200, map[string]any{"ok": true, "channel": after})
}

func (a *app) resetChannelPassword(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id, password := pathID(r), fieldString(input, "password")
	if len(password) < 10 {
		writeError(w, 400, "weak_password")
		return
	}
	hash, err := passwordHash(password)
	if err != nil {
		serverError(w, err)
		return
	}
	changed, err := updated(a.db, "UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE channel_id=? AND role='channel'", hash, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if !changed {
		writeError(w, 404, "channel_not_found")
		return
	}
	if _, err = a.db.Exec("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE channel_id=? AND role='channel')", id); err != nil {
		serverError(w, err)
		return
	}
	a.audit(currentUser(r).Email, "channel.password_reset", "channel", id, "", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *app) rotateChannelSecret(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	secret, err := newSecret("adx_", 24)
	if err != nil {
		serverError(w, err)
		return
	}
	cipher, err := a.encryptCredential(map[string]string{"secret": secret})
	if err != nil {
		serverError(w, err)
		return
	}
	changed, err := updated(a.db, "UPDATE channels SET api_secret_hash=?,api_secret_ciphertext=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", sha256Hex(secret), cipher, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if !changed {
		writeError(w, 404, "channel_not_found")
		return
	}
	a.audit(currentUser(r).Email, "channel.api_secret_rotate", "channel", id, "", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "secret": secret})
}

func (a *app) channelAPISecret(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u.Role != "channel" || !u.ChannelID.Valid {
		writeError(w, 403, "channel_only")
		return
	}
	row, found := a.one("SELECT api_secret_ciphertext FROM channels WHERE id=?", u.ChannelID.Int64)
	if !found || row["api_secret_ciphertext"] == nil || row["api_secret_ciphertext"] == "" {
		writeError(w, 404, "api_secret_not_generated")
		return
	}
	value, err := a.decryptCredential(fieldString(row, "api_secret_ciphertext"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "secret": value["secret"]})
}

func (a *app) admins(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT id,email,name,status,created_at createdAt FROM users WHERE role='admin' ORDER BY id")
}
func (a *app) createAdmin(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	email, name, password := strings.ToLower(fieldString(input, "email")), fieldString(input, "name"), fieldString(input, "password")
	if email == "" || name == "" || len(password) < 10 {
		writeError(w, 400, "invalid_admin")
		return
	}
	hash, err := passwordHash(password)
	if err != nil {
		serverError(w, err)
		return
	}
	id, err := execID(a.db, "INSERT INTO users(email,name,password_hash,role,status) VALUES(?,?,?,'admin','active')", email, name, hash)
	if err != nil {
		writeError(w, 409, "email_exists")
		return
	}
	a.audit(currentUser(r).Email, "admin.create", "user", id, email, clientIP(r))
	writeJSON(w, 201, map[string]any{"ok": true})
}
func (a *app) resetAdminPassword(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	id, password := pathID(r), fieldString(input, "password")
	if len(password) < 10 {
		writeError(w, 400, "weak_password")
		return
	}
	target, found := a.one("SELECT email FROM users WHERE id=? AND role='admin'", id)
	if !found {
		writeError(w, 404, "admin_not_found")
		return
	}
	hash, err := passwordHash(password)
	if err != nil {
		serverError(w, err)
		return
	}
	if _, err = a.db.Exec("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", hash, id); err != nil {
		serverError(w, err)
		return
	}
	if _, err = a.db.Exec("DELETE FROM sessions WHERE user_id=?", id); err != nil {
		serverError(w, err)
		return
	}
	a.audit(currentUser(r).Email, "admin.password_reset", "user", id, fieldString(target, "email"), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}
