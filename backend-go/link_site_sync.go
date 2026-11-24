package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Only an exact URL in the selected publisher network confirms a standalone Site.
func (a *app) findLinkSite(ctx context.Context, network, token, domain string) (exact, parent map[string]any, err error) {
	query := url.Values{"pageSize": {"1000"}}
	seen := map[string]bool{}
	for {
		result, err := a.gamRequest(ctx, network, token, "networks/"+network+"/sites", http.MethodGet, query, nil)
		if err != nil {
			return nil, nil, err
		}
		for _, entry := range array(result["sites"]) {
			site, ok := entry.(map[string]any)
			if !ok || fieldString(site, "childNetworkCode") != "" || resourceForNetwork(sitePattern, fieldString(site, "name"), network, "invalid_gam_site") != nil {
				continue
			}
			host := normalizedDomain(fieldString(site, "url"))
			if host == domain {
				return site, parent, nil
			}
			if strings.HasSuffix(domain, "."+host) && len(host) > len(normalizedDomain(fieldString(parent, "url"))) {
				parent = site
			}
		}
		next := fieldString(result, "nextPageToken")
		if next == "" {
			return nil, parent, nil
		}
		if seen[next] {
			return nil, nil, errors.New("gam_site_repeated_page")
		}
		seen[next] = true
		query.Set("pageToken", next)
	}
}

func (a *app) syncLinkSite(r *http.Request, fields linkFields) (map[string]any, error) {
	ctx := r.Context()
	token, err := a.tokenFor(ctx, fields.account)
	if err != nil {
		return nil, err
	}
	exact, _, err := a.findLinkSite(ctx, fields.network, token, fields.domain)
	if err != nil {
		return nil, err
	}
	if exact != nil {
		return map[string]any{"status": "verified", "site": exact}, nil
	}
	created, createErr := a.gamRequest(ctx, fields.network, token, "networks/"+fields.network+"/sites", http.MethodPost, nil, map[string]any{"url": fields.domain})
	if createErr == nil && normalizedDomain(fieldString(created, "url")) == fields.domain && fieldString(created, "childNetworkCode") == "" && resourceForNetwork(sitePattern, fieldString(created, "name"), fields.network, "invalid_gam_site") == nil {
		return map[string]any{"status": "created", "site": created}, nil
	}
	exact, parent, err := a.findLinkSite(ctx, fields.network, token, fields.domain)
	if err != nil {
		return nil, err
	}
	if exact != nil {
		return map[string]any{"status": "verified", "site": exact}, nil
	}
	if parent != nil && (createErr == nil || strings.Contains(strings.ToLower(createErr.Error()), "already exists")) {
		return map[string]any{"status": "parent_only", "site": parent}, nil
	}
	if createErr != nil {
		return nil, createErr
	}
	return nil, errors.New("gam_site_exact_url_unconfirmed")
}

func (a *app) linkSiteSyncResult(r *http.Request, fields linkFields) map[string]any {
	result, err := a.syncLinkSite(r, fields)
	if err != nil {
		result = map[string]any{"status": "failed", "error": err.Error()}
	}
	a.audit(currentUser(r).Email, "gam.link_site_sync", "link", fields.network+":"+fields.domain, fieldString(result, "status"), clientIP(r))
	return result
}

func (a *app) retryLinkSiteSync(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	fields, err := a.parseLinkFields(input)
	if err != nil {
		return err
	}
	if !a.exists("SELECT 1 FROM link_metadata WHERE network_code=? AND domain=?", fields.network, fields.domain) {
		return errors.New("invalid_link_domain")
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sync": a.linkSiteSyncResult(r, fields)})
	return nil
}
