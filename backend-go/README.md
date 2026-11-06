# AdX Go backend

This server serves the existing Vite frontend and implements the same /api/ routes as server/index.mjs and server/gam-routes.mjs. It uses the existing SQLite database and .env file; no MySQL credentials are required by this application.

## Build and validate

- Portable build: go test ./... && go build -o adx-server .
- Linux native SQLite build: CGO_ENABLED=1 go test -tags sqlite_native ./... && CGO_ENABLED=1 go build -tags sqlite_native -o adx-server .
- Run the existing platform contract suite against the Go binary with ADX_TEST_GO_BINARY=/absolute/path/to/adx-server node --test tests/platform.test.mjs.
- Run npm test from the repository root to validate the Node reference and route inventory.

The native build requires a C compiler and is preferred for production when its measured performance is better. Both builds use the same schema and API handlers. Test with a copy of the production database before switching the AdX service. The startup migration creates missing tables and columns and preserves historical revenue facts.

## Configuration

The process reads existing environment variables and .env from the working directory and site root. ADX_SITE_ROOT defaults to the working directory. ADX_DB_PATH defaults to data/adx-channel.sqlite below that root. PORT defaults to 4181; production uses the port from the existing .env. ADX_CREDENTIAL_KEY must match the key used by Node to decrypt saved GAM service-account credentials. The Go worker runs every 15 minutes for active accounts with REST sync enabled. Separate GAM diagnostic reports sync by device, browser, and demand channel at most once per hour per account and dimension, backfilling the latest 30 account-local days on first run. Diagnostic facts never enter revenue_facts or dashboard totals. Set ADX_GAM_WORKER_DISABLED=true for sidecar testing, and ADX_SYNC_ON_START=true only when an immediate revenue sync is intended.

The service-account token exchange and GAM requests remain remote calls, so their latency depends on Google. Default monthly dashboards and REST reports are prewarmed for active users at startup and after each sync. Responses stay user-scoped and are invalidated when facts change; custom cold multi-dimensional reports still scan and group the selected facts. The browser keeps a small per-user session cache to show the last successful result while refreshing in the background.

## Revenue regression monitor

The existing 15-minute GAM sync also snapshots each network's most recent day with data (today if available, otherwise yesterday) by domain and compares it with that date's preceding snapshot. The first snapshot is a baseline, not an alert. Every 24 hours the worker fetches the last three complete days and preceding three days; every 72 hours it does the same for seven-day windows; every seven days it checks rolling 30-day windows. All dates use the individual GAM network timezone. Longer windows require data for every date in both periods; incomplete or failed reports never become zero-revenue alerts. Daily history is retained for 90 days and longer-window history for 365 days.

Administrators can review/filter the comparisons at /regression and configure the Feishu custom-bot webhook there. Its URL and optional signing secret are encrypted with ADX_CREDENTIAL_KEY. Sending is off until an administrator saves a webhook and enables it. The default alert condition requires original revenue greater than USD 50 and a drop of at least 2%; successful notifications are deduplicated by account, domain, cadence and period. No bot URL or secret belongs in Git.
