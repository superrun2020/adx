package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

type user struct {
	ID        int64
	Email     string
	Name      string
	Role      string
	ChannelID sql.NullInt64
	Status    string
	Token     string
}

func (u user) public() map[string]any {
	var channel any
	if u.ChannelID.Valid {
		channel = u.ChannelID.Int64
	}
	return map[string]any{"id": u.ID, "email": u.Email, "name": u.Name,
		"role": u.Role, "channelId": channel}
}

type userKey struct{}

func currentUser(r *http.Request) user { return r.Context().Value(userKey{}).(user) }

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{attempts: make(map[string][]time.Time)} }
func (l *loginLimiter) check(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	old := l.attempts[key]
	recent := old[:0]
	for _, when := range old {
		if now.Sub(when) < 15*time.Minute {
			recent = append(recent, when)
		}
	}
	if len(recent) >= 8 {
		l.attempts[key] = recent
		return true
	}
	l.attempts[key] = append(recent, now)
	if len(l.attempts) > 5000 {
		for k, times := range l.attempts {
			if len(times) == 0 || now.Sub(times[len(times)-1]) >= 15*time.Minute {
				delete(l.attempts, k)
			}
		}
	}
	return false
}
func (l *loginLimiter) clear(key string) { l.mu.Lock(); delete(l.attempts, key); l.mu.Unlock() }

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if host == "127.0.0.1" || host == "::1" {
		if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); forwarded != "" {
			return forwarded
		}
	}
	return host
}

func (a *app) portalRole(r *http.Request) string {
	host := r.Host
	remote, _, _ := net.SplitHostPort(r.RemoteAddr)
	if remote == "127.0.0.1" || remote == "::1" {
		if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
			host = strings.Split(forwarded, ",")[0]
		}
	}
	host = strings.ToLower(strings.TrimSpace(strings.Split(host, ":")[0]))
	if host == a.adminHost {
		return "admin"
	}
	if host == a.publisherHost {
		return "channel"
	}
	return ""
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func passwordMatches(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 3 || parts[0] != "scrypt" {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil || len(expected) != 64 {
		return false
	}
	actual, err := scrypt.Key([]byte(password), []byte(parts[1]), 1<<14, 8, 1, 64)
	return err == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}
func passwordHash(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	saltHex := hex.EncodeToString(salt)
	key, err := scrypt.Key([]byte(password), []byte(saltHex), 1<<14, 8, 1, 64)
	if err != nil {
		return "", err
	}
	return "scrypt$" + saltHex + "$" + hex.EncodeToString(key), nil
}

func tokenFrom(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	if cookie, err := r.Cookie("adx_session"); err == nil {
		return cookie.Value
	}
	return ""
}

func (a *app) auth(role string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := tokenFrom(r)
		if token == "" {
			writeError(w, 401, "unauthorized")
			return
		}
		var u user
		err := a.db.QueryRowContext(r.Context(),
			"SELECT u.id,u.email,u.name,u.role,u.channel_id,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')",
			sha256Hex(token)).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.ChannelID, &u.Status)
		if err != nil || u.Status != "active" {
			writeError(w, 401, "unauthorized")
			return
		}
		if portal := a.portalRole(r); portal != "" && u.Role != portal {
			writeError(w, 403, "wrong_portal")
			return
		}
		if role != "" && u.Role != role {
			writeError(w, 403, "forbidden")
			return
		}
		u.Token = token
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	}
}

func (a *app) audit(actor, action, targetType string, targetID any, detail, ip string) {
	if len(detail) > 2000 {
		detail = detail[:2000]
	}
	if len(ip) > 80 {
		ip = ip[:80]
	}
	_, _ = a.db.Exec("INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,ip) VALUES(?,?,?,?,?,?)",
		actor, action, targetType, targetID, detail, ip)
	if !strings.HasPrefix(action, "auth.") && action != "api.revenue" && action != "gam.report_preview" {
		a.invalidateReportCache()
	}
}

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var input map[string]string
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, 400, "invalid_request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(input["email"]))
	key := clientIP(r) + "|" + email
	if a.attempts.check(key) {
		a.audit(email, "auth.login_blocked", "user", "", "", clientIP(r))
		writeError(w, 429, "too_many_attempts")
		return
	}
	var u user
	var encoded string
	err := a.db.QueryRowContext(r.Context(), "SELECT id,email,name,role,channel_id,status,password_hash FROM users WHERE email=?", email).
		Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.ChannelID, &u.Status, &encoded)
	if err != nil || u.Status != "active" || (a.portalRole(r) != "" && a.portalRole(r) != u.Role) || !passwordMatches(input["password"], encoded) {
		writeError(w, 401, "invalid_credentials")
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	ttl, err := strconv.Atoi(envDefault("SESSION_TTL_HOURS", "12"))
	if err != nil {
		ttl = 12
	}
	if ttl < 1 {
		ttl = 1
	}
	if ttl > 168 {
		ttl = 168
	}
	if _, err := a.db.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))",
		sha256Hex(token), u.ID, "+"+strconv.Itoa(ttl)+" hours"); err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	a.audit(email, "auth.login", "user", u.ID, "", clientIP(r))
	a.attempts.clear(key)
	secure := r.TLS != nil
	remote, _, _ := net.SplitHostPort(r.RemoteAddr)
	if (remote == "127.0.0.1" || remote == "::1") && r.Header.Get("X-Forwarded-Proto") == "https" {
		secure = true
	}
	http.SetCookie(w, &http.Cookie{Name: "adx_session", Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: ttl * 3600})
	writeJSON(w, 200, map[string]any{"ok": true, "user": u.public()})
}

func (a *app) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "user": currentUser(r).public()})
}

func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	_, err := a.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE token_hash=?", sha256Hex(currentUser(r).Token))
	if err != nil {
		writeError(w, 500, "internal_error")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "adx_session", Value: "", Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1})
	writeJSON(w, 200, map[string]any{"ok": true})
}
