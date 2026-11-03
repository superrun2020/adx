package main

import (
	"container/list"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"time"
)

type responseCache struct {
	mu      sync.Mutex
	conn    *sql.Conn
	version int64
	entries map[string]*list.Element
	order   *list.List
}
type cachedResponse struct {
	key     string
	body    []byte
	headers http.Header
}

func newResponseCache(db *sql.DB) (*responseCache, error) {
	conn, err := db.Conn(context.Background())
	if err != nil {
		return nil, err
	}
	cache := &responseCache{conn: conn, entries: make(map[string]*list.Element), order: list.New()}
	if err = conn.QueryRowContext(context.Background(), "PRAGMA data_version").Scan(&cache.version); err != nil {
		conn.Close()
		return nil, err
	}
	return cache, nil
}
func (cache *responseCache) close() {
	if cache != nil && cache.conn != nil {
		cache.conn.Close()
	}
}
func (a *app) invalidateReportCache() {
	cache := a.reportCache
	if cache == nil {
		return
	}
	cache.mu.Lock()
	cache.entries = make(map[string]*list.Element)
	cache.order.Init()
	cache.mu.Unlock()
}
func (cache *responseCache) lookup(ctx context.Context, key string) (*cachedResponse, int64) {
	var version int64
	if err := cache.conn.QueryRowContext(ctx, "PRAGMA data_version").Scan(&version); err != nil {
		return nil, -1
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if version != cache.version {
		cache.version = version
		cache.entries = make(map[string]*list.Element)
		cache.order.Init()
	}
	element := cache.entries[key]
	if element == nil {
		return nil, version
	}
	cache.order.MoveToBack(element)
	saved := element.Value.(*cachedResponse)
	return &cachedResponse{body: append([]byte(nil), saved.body...), headers: saved.headers.Clone()}, version
}
func (cache *responseCache) save(ctx context.Context, startVersion int64, key string, body []byte, headers http.Header) {
	if startVersion < 0 {
		return
	}
	var version int64
	if err := cache.conn.QueryRowContext(ctx, "PRAGMA data_version").Scan(&version); err != nil {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if version != startVersion || version != cache.version {
		return
	}
	if element := cache.entries[key]; element != nil {
		cache.order.Remove(element)
	}
	entry := &cachedResponse{key: key, body: append([]byte(nil), body...), headers: headers.Clone()}
	cache.entries[key] = cache.order.PushBack(entry)
	if cache.order.Len() > 128 {
		old := cache.order.Front()
		delete(cache.entries, old.Value.(*cachedResponse).key)
		cache.order.Remove(old)
	}
}
func copyHeaders(target, source http.Header) {
	for key, values := range source {
		for _, value := range values {
			target.Add(key, value)
		}
	}
}
func (a *app) cachedReport(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.reportCache == nil {
			next(w, r)
			return
		}
		u := currentUser(r)
		key := strconv.FormatInt(u.ID, 10) + ":" + u.Role + ":" + strconv.FormatInt(u.ChannelID.Int64, 10) + ":" + r.URL.RequestURI()
		hit, version := a.reportCache.lookup(r.Context(), key)
		if hit != nil {
			copyHeaders(w.Header(), hit.headers)
			w.Header().Set("Server-Timing", "app-cache;desc=\"hit\";dur=0")
			w.WriteHeader(200)
			_, _ = w.Write(hit.body)
			return
		}
		started := time.Now()
		recorder := httptest.NewRecorder()
		next(recorder, r)
		response := recorder.Result()
		defer response.Body.Close()
		data := recorder.Body.Bytes()
		copyHeaders(w.Header(), response.Header)
		timing := w.Header().Get("Server-Timing")
		if timing != "" {
			timing += ","
		}
		w.Header().Set("Server-Timing", timing+"app-cache;desc=\"miss\";dur="+strconv.FormatFloat(float64(time.Since(started).Microseconds())/1000, 'f', 1, 64))
		if response.StatusCode == 200 {
			var body map[string]any
			if json.Unmarshal(data, &body) == nil && body["ok"] == true {
				a.reportCache.save(r.Context(), version, key, data, response.Header)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(data)
	}
}
