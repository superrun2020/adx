package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"
)

type catalogCacheEntry struct {
	body  []byte
	saved time.Time
	ready chan struct{}
}
type catalogReadCache struct {
	mu      sync.Mutex
	entries map[string]*catalogCacheEntry
}

// Authentication and permission checks run before this cache. Only successful,
// non-sensitive site catalog responses are retained, never errors or credentials.
func (a *app) cachedCatalog(next func(http.ResponseWriter, *http.Request) error) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		account, err := a.gamAccount(pathID(r))
		if err != nil || account["status"] != "active" {
			return next(w, r)
		}
		q := r.URL.Query()
		force := q.Get("refresh") == "1"
		q.Del("refresh")
		key := r.URL.Path + "?" + q.Encode() + ":" + sha256Hex(importString(account["credential_ciphertext"])+":"+importString(account["updated_at"])+":"+importString(account["network_code"]))
		cache := &a.catalogCache
		for {
			cache.mu.Lock()
			if cache.entries == nil {
				cache.entries = make(map[string]*catalogCacheEntry)
			}
			old := cache.entries[key]
			if old != nil && old.ready != nil {
				ready := old.ready
				cache.mu.Unlock()
				select {
				case <-r.Context().Done():
					return r.Context().Err()
				case <-ready:
				}
				force = false
				continue
			}
			if old != nil && !force && time.Since(old.saved) < 5*time.Minute {
				body := append([]byte(nil), old.body...)
				cache.mu.Unlock()
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Server-Timing", "catalog-cache;desc=\"hit\";dur=0")
				w.WriteHeader(http.StatusOK)
				_, err = w.Write(body)
				return err
			}
			// Bound both cached pages and memory as account catalogs grow.
			if len(cache.entries) >= 128 {
				for k, v := range cache.entries {
					if v.ready == nil {
						delete(cache.entries, k)
					}
				}
			}
			entry := &catalogCacheEntry{ready: make(chan struct{})}
			cache.entries[key] = entry
			cache.mu.Unlock()
			recorder := httptest.NewRecorder()
			// Shared work survives the cancellation of a tab that initiated it.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 45*time.Second)
			err = next(recorder, r.WithContext(ctx))
			cancel()
			cache.mu.Lock()
			if err == nil && recorder.Code == http.StatusOK && recorder.Body.Len() <= 2<<20 {
				entry.body = append([]byte(nil), recorder.Body.Bytes()...)
				entry.saved = time.Now()
			} else {
				delete(cache.entries, key)
			}
			close(entry.ready)
			entry.ready = nil
			cache.mu.Unlock()
			if err != nil {
				return err
			}
			copyHeaders(w.Header(), recorder.Header())
			w.Header().Set("Server-Timing", "catalog-cache;desc=\"miss\"")
			w.WriteHeader(recorder.Code)
			_, err = w.Write(recorder.Body.Bytes())
			return err
		}
	}
}
