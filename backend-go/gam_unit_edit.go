package main

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (a *app) editableGamAdUnit(r *http.Request) (map[string]any, string, string, map[string]any, error) {
	account, err := a.gamAccount(pathID(r))
	if err != nil {
		return nil, "", "", nil, errors.New("invalid_gam_account")
	}
	if account["status"] != "active" || intMap(account, "enabled") != 1 {
		return nil, "", "", nil, errors.New("invalid_gam_account_status")
	}
	id, err := strconv.ParseUint(r.PathValue("unitId"), 10, 64)
	if err != nil || id == 0 {
		return nil, "", "", nil, errors.New("invalid_ad_unit_resource")
	}
	network := importString(account["network_code"])
	name := "networks/" + network + "/adUnits/" + strconv.FormatUint(id, 10)
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return nil, "", "", nil, err
	}
	unit, err := a.getGamAdUnit(r, network, token, name)
	if err != nil {
		return nil, "", "", nil, err
	}
	if importString(unit["name"]) != name {
		return nil, "", "", nil, errors.New("invalid_ad_unit_resource")
	}
	return account, token, name, unit, nil
}

func (a *app) gamAdUnitDetail(w http.ResponseWriter, r *http.Request) error {
	_, _, _, unit, err := a.editableGamAdUnit(r)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true, "item": unit})
	return nil
}

func (a *app) updateGamAdUnit(w http.ResponseWriter, r *http.Request) error {
	account, token, name, current, err := a.editableGamAdUnit(r)
	if err != nil {
		return err
	}
	network := importString(account["network_code"])
	root, err := a.gamRootAdUnit(r.Context(), network, token)
	if err != nil {
		return err
	}
	if name == root || current["status"] == "ARCHIVED" {
		return errors.New("invalid_ad_unit_update")
	}
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	allowed := map[string]bool{"displayName": true, "description": true, "sizes": true, "adsenseEnabled": true, "targetWindow": true}
	for key := range input {
		if !allowed[key] {
			return errors.New("invalid_ad_unit_update")
		}
	}
	patch := map[string]any{"name": name}
	mask := make([]string, 0, len(input))
	if raw, present := input["displayName"]; present {
		value, valid := raw.(string)
		value = strings.TrimSpace(value)
		if !valid || value == "" || len(value) > 255 {
			return errors.New("invalid_ad_unit_display_name")
		}
		if value != importString(current["displayName"]) {
			match, err := a.findGamAdUnitByName(r, network, token, value)
			if err != nil {
				return err
			}
			if match != nil && importString(match["name"]) != name {
				return errors.New("ad_unit_name_already_exists_in_gam")
			}
		}
		patch["displayName"] = value
		mask = append(mask, "displayName")
	}
	if raw, present := input["description"]; present {
		value, valid := raw.(string)
		if !valid || len(value) > 65535 {
			return errors.New("invalid_ad_unit_description")
		}
		patch["description"] = value
		mask = append(mask, "description")
	}
	if raw, present := input["sizes"]; present {
		sizes, err := parseGamSizes(raw)
		if err != nil {
			return err
		}
		combined := make([]any, 0, len(sizes)+len(array(current["adUnitSizes"])))
		for _, size := range sizes {
			combined = append(combined, size)
		}
		for _, value := range array(current["adUnitSizes"]) {
			if object(value)["environmentType"] != "BROWSER" {
				combined = append(combined, value)
			}
		}
		patch["adUnitSizes"] = combined
		mask = append(mask, "adUnitSizes")
	}
	if raw, present := input["adsenseEnabled"]; present {
		value, valid := raw.(bool)
		if !valid {
			return errors.New("invalid_ad_unit_adsense")
		}
		patch["appliedAdsenseEnabled"] = value
		mask = append(mask, "appliedAdsenseEnabled")
	}
	if raw, present := input["targetWindow"]; present {
		value, valid := raw.(string)
		if !valid || (value != "TOP" && value != "BLANK") {
			return errors.New("invalid_ad_unit_target_window")
		}
		patch["appliedTargetWindow"] = value
		mask = append(mask, "appliedTargetWindow")
	}
	if len(mask) == 0 {
		return errors.New("invalid_ad_unit_update")
	}
	query := url.Values{"updateMask": {strings.Join(mask, ",")}}
	updated, err := a.gamRequest(r.Context(), network, token, name, http.MethodPatch, query, patch)
	if err != nil {
		return err
	}
	if importString(updated["name"]) != name {
		return errors.New("gam_ad_unit_update_mismatch")
	}
	a.audit(currentUser(r).Email, "gam.ad_unit_update", "gam_ad_unit", name,
		marshalText(map[string]any{"networkCode": network, "before": current, "after": updated, "updateMask": mask}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "item": updated})
	return nil
}

func (a *app) archiveGamAdUnits(w http.ResponseWriter, r *http.Request) error {
	account, err := a.gamAccount(pathID(r))
	if err != nil || account["status"] != "active" || intMap(account, "enabled") != 1 {
		return errors.New("invalid_gam_account_status")
	}
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	entries := array(input["names"])
	if len(entries) == 0 || len(entries) > 100 {
		return errors.New("invalid_ad_unit_archive")
	}
	network := importString(account["network_code"])
	names := make([]string, 0, len(entries))
	seen := make(map[string]bool)
	for _, entry := range entries {
		name, valid := entry.(string)
		if !valid || resourceForNetwork(adUnitPattern, name, network, "invalid_ad_unit_resource") != nil || seen[name] {
			return errors.New("invalid_ad_unit_archive")
		}
		seen[name] = true
		names = append(names, name)
	}
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return err
	}
	root, err := a.gamRootAdUnit(r.Context(), network, token)
	if err != nil {
		return err
	}
	if seen[root] {
		return errors.New("invalid_ad_unit_archive")
	}
	_, err = a.gamRequest(r.Context(), network, token, "networks/"+network+"/adUnits:batchArchive", http.MethodPost, nil, map[string]any{"names": names})
	if err != nil {
		return err
	}
	a.audit(currentUser(r).Email, "gam.ad_unit_archive", "gam_ad_unit", network,
		marshalText(map[string]any{"networkCode": network, "names": names}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "archived": len(names)})
	return nil
}
