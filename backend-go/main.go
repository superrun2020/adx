package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/joho/godotenv"
)

type app struct {
	db             *sql.DB
	root           string
	adminHost      string
	publisherHost  string
	production     bool
	attempts       *loginLimiter
	apiLimiter     *requestLimiter
	gamMu          sync.Mutex
	gamTokens      map[int64]*gamTokenEntry
	gamBusy        map[int64]bool
	gamCreating    map[string]bool
	gamPublishing  map[int64]bool
	gamScheduled   bool
	diagnosticMu   sync.Mutex
	diagnosticBusy bool
	gamClient      *http.Client
	reportCache    *responseCache
	gamAPIBase     string
	oauthURL       string
	dailyReady     atomic.Bool
	restDailyReady atomic.Bool
	credentialKey  [32]byte
}

func envDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func newApp(root string) (*app, error) {
	dbPath := os.Getenv("ADX_DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(root, "data", "adx-channel.sqlite")
	}
	if !filepath.IsAbs(dbPath) {
		dbPath = filepath.Join(root, dbPath)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open(sqliteDriver, sqliteDSN(dbPath))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, err
	}
	a := &app{db: db, root: root,
		adminHost:     strings.ToLower(envDefault("ADX_ADMIN_HOST", "adx.geekforest.ai")),
		publisherHost: strings.ToLower(envDefault("ADX_PUBLISHER_HOST", "adxpub.geekforest.ai")),
		production:    os.Getenv("NODE_ENV") == "production" || os.Getenv("ADX_ENV") == "production",
		attempts:      newLoginLimiter(),
		apiLimiter:    newRequestLimiter(),
		gamTokens:     make(map[int64]*gamTokenEntry),
		gamBusy:       make(map[int64]bool),
		gamCreating:   make(map[string]bool),
		gamPublishing: make(map[int64]bool),
		gamClient:     &http.Client{Timeout: 30 * time.Second},
		gamAPIBase:    "https://admanager.googleapis.com/v1/",
		oauthURL:      "https://oauth2.googleapis.com/token",
	}
	if err := a.initializeCredentialKey(); err != nil {
		db.Close()
		return nil, err
	}
	if err := a.ensureSchema(); err != nil {
		db.Close()
		return nil, err
	}
	if err := a.initializeDashboardDaily(); err != nil {
		db.Close()
		return nil, err
	}
	a.reportCache, err = newResponseCache(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	return a, nil
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("GET /api/auth/me", a.auth("", a.me))
	mux.HandleFunc("POST /api/auth/logout", a.auth("", a.logout))
	mux.HandleFunc("GET /api/dashboard", a.auth("", a.cachedReport(a.dashboard)))
	mux.HandleFunc("GET /api/dashboard/highlights", a.auth("", a.cachedReport(a.dashboardHighlights)))
	mux.HandleFunc("GET /api/reports", a.auth("", a.cachedReport(a.reports)))
	mux.HandleFunc("GET /api/reports/export", a.auth("", a.reportsExport))
	mux.HandleFunc("GET /api/admin/reports/diagnostics", a.auth("admin", a.diagnosticReport))
	mux.HandleFunc("GET /api/admin/reports/filter-options", a.auth("admin", a.reportFilterOptions))
	mux.HandleFunc("GET /api/admin/reports/accounts", a.auth("admin", a.cachedReport(a.accountReport)))
	mux.HandleFunc("GET /api/admin/report-api-keys", a.auth("admin", a.reportAPIKeys))
	mux.HandleFunc("POST /api/admin/report-api-keys", a.auth("admin", a.createReportAPIKey))
	mux.HandleFunc("POST /api/admin/report-api-keys/{id}/revoke", a.auth("admin", a.revokeReportAPIKey))
	mux.HandleFunc("GET /api/public/account/revenue", a.publicAccountReport)
	mux.HandleFunc("GET /api/admin/upstream-accounts", a.auth("admin", a.upstreamAccounts))
	mux.HandleFunc("POST /api/admin/upstream-accounts", a.auth("admin", a.createUpstreamAccount))
	mux.HandleFunc("PUT /api/admin/upstream-accounts/{id}", a.auth("admin", a.updateUpstreamAccount))
	mux.HandleFunc("GET /api/admin/ad-unit-domains", a.auth("admin", a.adUnitDomains))
	mux.HandleFunc("POST /api/admin/ad-unit-domains", a.auth("admin", a.createAdUnitDomain))
	mux.HandleFunc("PUT /api/admin/ad-unit-domains/{id}", a.auth("admin", a.updateAdUnitDomain))
	mux.HandleFunc("GET /api/admin/share-rules", a.auth("admin", a.shareRules))
	mux.HandleFunc("POST /api/admin/share-rules", a.auth("admin", a.createShareRule))
	mux.HandleFunc("GET /api/admin/domain-share-rules", a.auth("admin", a.domainShareRules))
	mux.HandleFunc("POST /api/admin/domain-share-rules", a.auth("admin", a.createDomainShareRule))
	mux.HandleFunc("PUT /api/admin/domain-share-rules/{id}", a.auth("admin", a.updateDomainShareRule))
	mux.HandleFunc("GET /api/admin/channels", a.auth("admin", a.channels))
	mux.HandleFunc("POST /api/admin/channels", a.auth("admin", a.createChannel))
	mux.HandleFunc("PUT /api/admin/channels/{id}", a.auth("admin", a.updateChannel))
	mux.HandleFunc("POST /api/admin/channels/{id}/password", a.auth("admin", a.resetChannelPassword))
	mux.HandleFunc("POST /api/admin/channels/{id}/api-secret", a.auth("admin", a.rotateChannelSecret))
	mux.HandleFunc("GET /api/channel/api-secret", a.auth("", a.channelAPISecret))
	mux.HandleFunc("GET /api/admin/users", a.auth("admin", a.admins))
	mux.HandleFunc("POST /api/admin/users", a.auth("admin", a.createAdmin))
	mux.HandleFunc("PUT /api/admin/users/{id}", a.auth("admin", a.updateAdmin))
	mux.HandleFunc("DELETE /api/admin/users/{id}", a.auth("admin", a.deleteAdmin))
	mux.HandleFunc("POST /api/admin/users/{id}/password", a.auth("admin", a.resetAdminPassword))
	mux.HandleFunc("GET /api/admin/audit", a.auth("admin", a.auditLogs))
	mux.HandleFunc("POST /api/admin/imports/preview", a.auth("admin", a.previewImport))
	mux.HandleFunc("POST /api/admin/imports", a.auth("admin", a.importRows))
	mux.HandleFunc("GET /api/admin/imports", a.auth("admin", a.importRuns))
	mux.HandleFunc("GET /api/public/channel/revenue", a.publicChannelRevenue)
	mux.HandleFunc("GET /api/admin/gam-accounts", a.auth("admin", a.gamAccounts))
	mux.HandleFunc("POST /api/admin/gam-accounts", a.auth("admin", gamRoute(a.createGamAccount)))
	mux.HandleFunc("PUT /api/admin/gam-accounts/{id}", a.auth("admin", gamRoute(a.updateGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/test", a.auth("admin", gamRoute(a.testGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/report", a.auth("admin", gamRoute(a.reportGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/preview", a.auth("admin", gamRoute(a.previewGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/activate", a.auth("admin", gamRoute(a.activateGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/pause", a.auth("admin", gamRoute(a.pauseGamAccount)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/sync-now", a.auth("admin", gamRoute(a.syncGamAccount)))
	mux.HandleFunc("GET /api/admin/gam-sync/runs", a.auth("admin", a.gamSyncRuns))
	mux.HandleFunc("GET /api/admin/regression/settings", a.auth("admin", a.regressionSettings))
	mux.HandleFunc("PUT /api/admin/regression/settings", a.auth("admin", gamRoute(a.updateRegressionSettings)))
	mux.HandleFunc("GET /api/admin/regression/events", a.auth("admin", a.regressionEvents))
	mux.HandleFunc("GET /api/admin/regression/runs", a.auth("admin", a.regressionRuns))
	mux.HandleFunc("GET /api/admin/bot-report/settings", a.auth("admin", a.botReportSettings))
	mux.HandleFunc("PUT /api/admin/bot-report/settings", a.auth("admin", gamRoute(a.updateBotReportSettings)))
	mux.HandleFunc("POST /api/admin/bot-report/test", a.auth("admin", a.testBotReport))
	mux.HandleFunc("GET /api/admin/gam-accounts/{id}/ad-units", a.auth("admin", gamRoute(a.listGamAccountAdUnits)))
	mux.HandleFunc("GET /api/admin/gam-accounts/{id}/ad-units/{unitId}", a.auth("admin", gamRoute(a.gamAdUnitDetail)))
	mux.HandleFunc("PATCH /api/admin/gam-accounts/{id}/ad-units/{unitId}", a.auth("admin", gamRoute(a.updateGamAdUnit)))
	mux.HandleFunc("POST /api/admin/gam-accounts/{id}/ad-units/batch-archive", a.auth("admin", gamRoute(a.archiveGamAdUnits)))
	mux.HandleFunc("GET /api/admin/gam-accounts/{id}/ad-unit-sizes", a.auth("admin", gamRoute(a.listGamAccountAdUnitSizes)))
	mux.HandleFunc("GET /api/admin/gam-accounts/{id}/sites", a.auth("admin", gamRoute(a.listGamAccountSites)))
	mux.HandleFunc("GET /api/admin/gam-accounts/{id}/site-domains", a.auth("admin", gamRoute(a.gamAccountSiteDomains)))
	mux.HandleFunc("GET /api/admin/link-metadata", a.auth("admin", gamRoute(a.listLinkMetadata)))
	mux.HandleFunc("POST /api/admin/link-metadata", a.auth("admin", gamRoute(a.createLinkMetadata)))
	mux.HandleFunc("PUT /api/admin/link-metadata", a.auth("admin", gamRoute(a.updateLinkMetadata)))
	mux.HandleFunc("GET /api/admin/gam-ad-units", a.auth("admin", a.gamAdUnitCreations))
	mux.HandleFunc("GET /api/admin/gam-ad-units/domain-map", a.auth("admin", a.gamAdUnitDomainMap))
	mux.HandleFunc("POST /api/admin/gam-ad-units", a.auth("admin", gamRoute(a.createGamAdUnit)))
	mux.HandleFunc("POST /api/admin/gam-ad-units/batch", a.auth("admin", gamRoute(a.batchGamAdUnits)))
	mux.HandleFunc("POST /api/admin/gam-ad-units/{id}/retry", a.auth("admin", gamRoute(a.retryGamAdUnit)))
	mux.HandleFunc("POST /api/admin/ad-units/{id}/publish", a.auth("admin", gamRoute(a.publishManagedAdUnit)))
	mux.HandleFunc("POST /api/admin/ad-units/preview", a.auth("admin", a.previewManagedAdUnits))
	mux.HandleFunc("POST /api/admin/ad-units/create", a.auth("admin", a.createManagedAdUnits))
	mux.HandleFunc("GET /api/admin/ad-units", a.auth("admin", a.managedAdUnits))
	mux.HandleFunc("/", a.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.production && a.portalRole(r) == "" {
			writeError(w, 421, "unknown_host")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}

func main() {
	if err := godotenv.Load(); err != nil && !os.IsNotExist(err) {
		log.Fatal(err)
	}
	root := envDefault("ADX_SITE_ROOT", ".")
	abs, err := filepath.Abs(root)
	if err != nil {
		log.Fatal(err)
	}
	if err := godotenv.Load(filepath.Join(abs, ".env")); err != nil && !os.IsNotExist(err) {
		log.Fatal(err)
	}
	a, err := newApp(abs)
	if err != nil {
		log.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	port, err := strconv.Atoi(envDefault("PORT", "4181"))
	if err != nil || port < 1 || port > 65535 {
		log.Fatal("invalid PORT")
	}
	host := envDefault("HOST", "127.0.0.1")
	srv := &http.Server{Addr: fmt.Sprintf("%s:%d", host, port), Handler: a.routes(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("adx-go listening on %s", srv.Addr)
	if os.Getenv("ADX_GAM_WORKER_DISABLED") != "true" {
		go func() {
			run := func() {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if err := a.runBotReportAt(ctx, time.Now(), postFeishu); err != nil {
					log.Printf("bot_report_delivery_failed: %v", err)
				}
			}
			run()
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				run()
			}
		}()
		go func() {
			a.warmDefaultReports()
			go a.runScheduledDiagnostics()
			if os.Getenv("ADX_SYNC_ON_START") == "true" {
				a.runScheduledGamSync()
			}
			ticker := time.NewTicker(15 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				a.runScheduledGamSync()
				go a.runScheduledDiagnostics()
			}
		}()
	}
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": code})
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	portal := a.portalRole(r)
	if portal == "" {
		portal = "local"
	}
	writeJSON(w, 200, map[string]any{"ok": true, "status": "ok", "portal": portal})
}

func (a *app) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, 404, "not_found")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", 405)
		return
	}
	dist := filepath.Join(a.root, "dist")
	requested := filepath.Clean(filepath.Join(dist, filepath.FromSlash(r.URL.Path)))
	if !strings.HasPrefix(requested, dist+string(filepath.Separator)) && requested != dist {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(requested)
	if err == nil && !info.IsDir() {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		http.ServeFile(w, r, requested)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(dist, "index.html"))
}

func queryMaps(db *sql.DB, query string, args ...any) ([]map[string]any, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(columns))
		ptrs := make([]any, len(columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		item := make(map[string]any, len(columns))
		for i, column := range columns {
			if data, ok := values[i].([]byte); ok {
				item[column] = string(data)
			} else {
				item[column] = values[i]
			}
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func firstMap(db *sql.DB, query string, args ...any) (map[string]any, error) {
	rows, err := queryMaps(db, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, sql.ErrNoRows
	}
	return rows[0], nil
}
