package main

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type requestLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newRequestLimiter() *requestLimiter { return &requestLimiter{hits: make(map[string][]time.Time)} }
func (l *requestLimiter) limited(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	old := l.hits[key]
	recent := old[:0]
	for _, at := range old {
		if now.Sub(at) < time.Minute {
			recent = append(recent, at)
		}
	}
	if len(recent) >= 60 {
		l.hits[key] = recent
		return true
	}
	l.hits[key] = append(recent, now)
	if len(l.hits) > 5000 {
		for k, times := range l.hits {
			if len(times) == 0 || now.Sub(times[len(times)-1]) >= time.Minute {
				delete(l.hits, k)
			}
		}
	}
	return false
}
func channelAPIError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"code": status, "msg": message})
}
func (a *app) publicChannelRevenue(w http.ResponseWriter, r *http.Request) {
	secret := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(secret), "bearer ") {
		secret = strings.TrimSpace(secret[7:])
	} else {
		secret = ""
	}
	if secret == "" {
		channelAPIError(w, 401, "渠道密钥无效")
		return
	}
	channel, err := firstMap(a.db, "SELECT id,email,status FROM channels WHERE api_secret_hash=?", sha256Hex(secret))
	if err != nil {
		channelAPIError(w, 401, "渠道密钥无效")
		return
	}
	if channel["status"] != "active" {
		channelAPIError(w, 403, "渠道已被禁用")
		return
	}
	channelID := int64(numberValue(channel["id"]))
	if a.apiLimiter.limited(clientIP(r) + "|" + strconv.FormatInt(channelID, 10)) {
		channelAPIError(w, 429, "请求过于频繁")
		return
	}
	q := r.URL.Query()
	now := time.Now().UTC()
	start, end := q.Get("start_date"), q.Get("end_date")
	if !validDate(start) {
		start = now.AddDate(0, 0, -2).Format("2006-01-02")
	}
	if !validDate(end) {
		end = now.Format("2006-01-02")
	}
	first, _ := time.Parse("2006-01-02", start)
	last, _ := time.Parse("2006-01-02", end)
	if last.Sub(first) > 90*24*time.Hour {
		channelAPIError(w, 400, "日期跨度不能超过90天")
		return
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(q.Get("page_size"))
	if size < 1 {
		size = 500
	}
	if size > 5000 {
		size = 5000
	}
	var total int64
	err = a.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM revenue_facts WHERE channel_id=? AND report_date BETWEEN ? AND ?", channelID, start, end).Scan(&total)
	if err != nil {
		serverError(w, err)
		return
	}
	settled := settledRevenueSQL("revenue_facts")
	query := "SELECT report_date date," + mappedDomainSQL("revenue_facts") + " url,ad_unit,country,account,requests,matched_requests,impressions,clicks,ROUND(" + settled + ",6) revenue,CASE WHEN impressions>0 THEN ROUND(" + settled + "*1000.0/impressions,6) ELSE 0 END ecpm FROM revenue_facts WHERE channel_id=? AND report_date BETWEEN ? AND ? ORDER BY url,ad_unit LIMIT ? OFFSET ?"
	rows, err := queryMaps(a.db, query, channelID, start, end, size, (page-1)*size)
	if err != nil {
		serverError(w, err)
		return
	}
	a.audit(strings.TrimSpace(importString(channel["email"])), "api.revenue", "channel", channelID, marshalText(map[string]any{"start": start, "end": end, "page": page, "pageSize": size}), "api")
	writeJSON(w, 200, map[string]any{"code": 0, "msg": "ok", "data": rows, "meta": map[string]any{"total": total, "page": page, "page_size": size}})
}
