package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

func (a *app) listLinkMetadata(w http.ResponseWriter, r *http.Request) error {
	items, err := queryMaps(a.db, `SELECT m.network_code networkCode,m.domain,m.is_manual isManual,
        m.monitor_domains_json monitorDomainsJson,m.channel_id channelId,COALESCE(c.name,'') channelName,
        m.notes FROM link_metadata m
        LEFT JOIN channels c ON c.id=m.channel_id ORDER BY m.network_code,m.domain`)
	if err != nil {
		return err
	}
	channels, err := queryMaps(a.db, "SELECT id,name FROM channels WHERE status='active' ORDER BY name")
	if err != nil {
		return err
	}
	assignments, err := queryMaps(a.db, `SELECT cd.domain,c.id channelId,c.name channelName FROM channel_domains cd
        JOIN channels c ON c.id=cd.channel_id WHERE c.status='active' ORDER BY cd.domain`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": items, "channels": channels, "assignments": assignments})
	return nil
}

type linkFields struct {
	account                             map[string]any
	network, domain, monitorJSON, notes string
	channel                             any
}

func (a *app) parseLinkFields(input map[string]any) (linkFields, error) {
	account, err := a.gamAccount(fieldID(input, "gamAccountId"))
	if err != nil || account["status"] != "active" {
		return linkFields{}, errors.New("invalid_gam_account_status")
	}
	domain, err := gamSiteDomain(fieldString(input, "domain"))
	if err != nil {
		return linkFields{}, errors.New("invalid_link_domain")
	}
	rawMonitors := array(input["monitorDomains"])
	if input["monitorDomains"] != nil && rawMonitors == nil {
		return linkFields{}, errors.New("invalid_monitor_domain")
	}
	if len(rawMonitors) > 20 {
		return linkFields{}, errors.New("invalid_monitor_domain")
	}
	monitors, seen := make([]string, 0, len(rawMonitors)), map[string]bool{}
	for _, value := range rawMonitors {
		monitor, err := gamSiteDomain(importString(value))
		if err != nil {
			return linkFields{}, errors.New("invalid_monitor_domain")
		}
		if !seen[monitor] {
			monitors, seen[monitor] = append(monitors, monitor), true
		}
	}
	encoded, _ := json.Marshal(monitors)
	notes := fieldString(input, "notes")
	if len(notes) > 2000 {
		return linkFields{}, errors.New("invalid_link_metadata")
	}
	var channel any
	if input["channelId"] != nil {
		id := fieldID(input, "channelId")
		if id == 0 || !a.exists("SELECT id FROM channels WHERE id=? AND status='active'", id) {
			return linkFields{}, errors.New("invalid_channel_id")
		}
		channel = id
	}
	return linkFields{account: account, network: importString(account["network_code"]), domain: domain, monitorJSON: string(encoded), notes: notes, channel: channel}, nil
}

func (a *app) createLinkMetadata(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	fields, err := a.parseLinkFields(input)
	if err != nil {
		return err
	}
	if a.exists("SELECT 1 FROM link_metadata WHERE network_code=? AND domain=?", fields.network, fields.domain) {
		return errors.New("link_already_exists")
	}
	_, main, _ := domainInfo(fields.domain)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if main != fields.domain {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO link_metadata(network_code,domain,is_manual,updated_by)
            VALUES(?,?,1,?)`, fields.network, main, currentUser(r).Email); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`INSERT INTO link_metadata(network_code,domain,is_manual,monitor_domains_json,channel_id,notes,updated_by)
        VALUES(?,?,1,?,?,?,?)`, fields.network, fields.domain, fields.monitorJSON, fields.channel, fields.notes, currentUser(r).Email)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return errors.New("link_already_exists")
		}
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam.link_create", "link", fields.network+":"+fields.domain, "{}", clientIP(r))
	writeJSON(w, 201, map[string]any{"ok": true})
	return nil
}

func (a *app) updateLinkMetadata(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	fields, err := a.parseLinkFields(input)
	if err != nil {
		return err
	}
	originalNetwork := fieldString(input, "originalNetworkCode")
	originalDomain, err := gamSiteDomain(fieldString(input, "originalDomain"))
	if err != nil {
		return errors.New("invalid_link_domain")
	}
	existing, err := firstMap(a.db, "SELECT is_manual FROM link_metadata WHERE network_code=? AND domain=?", originalNetwork, originalDomain)
	if err != nil {
		return err
	}
	manual := existing != nil && intMap(existing, "is_manual") == 1 && fieldString(input, "siteName") == ""
	if !manual {
		if originalNetwork != fields.network || originalDomain != fields.domain {
			return errors.New("invalid_gam_site_move")
		}
		token, err := a.tokenFor(r.Context(), fields.account)
		if err != nil {
			return err
		}
		siteName := fieldString(input, "siteName")
		site, err := a.getGamSite(r, fields.network, token, siteName)
		if err != nil {
			return err
		}
		if site["name"] != siteName || normalizedDomain(importString(site["url"])) != fields.domain {
			return errors.New("invalid_gam_site_domain")
		}
		_, err = a.db.Exec(`INSERT INTO link_metadata(network_code,domain,is_manual,monitor_domains_json,channel_id,notes,updated_by)
            VALUES(?,?,0,?,?,?,?) ON CONFLICT(network_code,domain) DO UPDATE SET
			is_manual=0,monitor_domains_json=excluded.monitor_domains_json,channel_id=excluded.channel_id,notes=excluded.notes,
            updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
			fields.network, fields.domain, fields.monitorJSON, fields.channel, fields.notes, currentUser(r).Email)
	} else {
		if (originalNetwork != fields.network || originalDomain != fields.domain) &&
			a.exists("SELECT 1 FROM link_metadata WHERE network_code=? AND domain=?", fields.network, fields.domain) {
			return errors.New("link_already_exists")
		}
		_, err = a.db.Exec(`UPDATE link_metadata SET network_code=?,domain=?,monitor_domains_json=?,channel_id=?,
            notes=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE network_code=? AND domain=? AND is_manual=1`,
			fields.network, fields.domain, fields.monitorJSON, fields.channel, fields.notes, currentUser(r).Email, originalNetwork, originalDomain)
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return errors.New("link_already_exists")
		}
		return err
	}
	a.audit(currentUser(r).Email, "gam.link_update", "link", fields.network+":"+fields.domain, "{}", clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}
