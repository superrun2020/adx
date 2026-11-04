package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func bodyMap(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 30<<20)
	decoder := json.NewDecoder(r.Body)
	var input map[string]any
	if err := decoder.Decode(&input); err != nil || input == nil {
		writeError(w, 400, "invalid_request")
		return nil, false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, 400, "invalid_request")
		return nil, false
	}
	return input, true
}

func optionalBodyMap(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 30<<20)
	decoder := json.NewDecoder(r.Body)
	var input map[string]any
	if err := decoder.Decode(&input); err == io.EOF {
		return map[string]any{}, true
	} else if err != nil {
		writeError(w, 400, "invalid_request")
		return nil, false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, 400, "invalid_request")
		return nil, false
	}
	if input == nil {
		input = map[string]any{}
	}
	return input, true
}

func fieldString(input map[string]any, key string) string {
	value := input[key]
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func fieldFloat(input map[string]any, key string) (float64, bool) {
	value, ok := input[key]
	if !ok || value == nil {
		return 0, false
	}
	var result float64
	switch v := value.(type) {
	case float64:
		result = v
	case int:
		result = float64(v)
	case int64:
		result = float64(v)
	case string:
		var err error
		result, err = strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return result, !math.IsNaN(result) && !math.IsInf(result, 0)
}

func fieldID(input map[string]any, key string) int64 {
	value, ok := fieldFloat(input, key)
	if !ok || value < 1 || value > 9007199254740991 || value != math.Trunc(value) {
		return 0
	}
	return int64(value)
}

func pathID(r *http.Request) int64 {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		return 0
	}
	return id
}

func validShare(input map[string]any, key string) (float64, bool) {
	value, ok := fieldFloat(input, key)
	return value, ok && value >= 0 && value <= 100
}

func newSecret(prefix string, size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func (a *app) rows(query string, args ...any) []map[string]any {
	items, err := queryMaps(a.db, query, args...)
	if err != nil {
		log.Printf("query_failed: %v", err)
		return nil
	}
	return items
}

func (a *app) sendItems(w http.ResponseWriter, query string, args ...any) {
	rows, err := queryMaps(a.db, query, args...)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows})
}

func (a *app) one(query string, args ...any) (map[string]any, bool) {
	row, err := firstMap(a.db, query, args...)
	return row, err == nil
}

func (a *app) exists(query string, args ...any) bool {
	var value int
	return a.db.QueryRow(query, args...).Scan(&value) == nil
}

func execID(db *sql.DB, query string, args ...any) (int64, error) {
	result, err := db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func updated(db *sql.DB, query string, args ...any) (bool, error) {
	result, err := db.Exec(query, args...)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}

func dateToday() string { return time.Now().UTC().Format("2006-01-02") }

func marshalText(value any) string { data, _ := json.Marshal(value); return string(data) }

func serverError(w http.ResponseWriter, err error) {
	log.Printf("request_failed: %v", err)
	writeError(w, 500, "internal_error")
}
