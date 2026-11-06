package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var sizePattern = regexp.MustCompile("(?i)^([0-9]{1,4})[[:space:]]*[x×][[:space:]]*([0-9]{1,4})$")
var hostnamePattern = regexp.MustCompile("^[a-z0-9-]+([.][a-z0-9-]+)+$")

const gamCreationColumns = "id,gam_account_id gamAccountId,network_code networkCode,site_name siteName,site_url siteUrl,domain,parent_ad_unit parentAdUnit,display_name displayName,ad_unit_code adUnitCode,sizes_json sizesJson,description,adsense_enabled adsenseEnabled,target_window targetWindow,status,provider_id providerId,publish_error publishError,created_at createdAt,published_at publishedAt"

func gamSiteDomain(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(text), "https://") && !strings.HasPrefix(strings.ToLower(text), "http://") {
		text = "https://" + text
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return "", errors.New("invalid_gam_site_url")
	}
	host := strings.ToLower(parsed.Hostname())
	if !hostnamePattern.MatchString(host) {
		return "", errors.New("invalid_gam_site_url")
	}
	return host, nil
}
func gamSelectedSiteDomain(siteURL, selected string) (string, error) {
	base, err := gamSiteDomain(siteURL)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(selected) == "" {
		return base, nil
	}
	domain, err := gamSiteDomain(selected)
	if err != nil || (domain != base && !strings.HasSuffix(domain, "."+base)) {
		return "", errors.New("invalid_gam_site_domain")
	}
	return domain, nil
}
func parseGamSizes(value any) ([]map[string]any, error) {
	entries := array(value)
	if entries == nil {
		entries = []any{value}
	}
	if len(entries) == 0 || len(entries) > 20 {
		return nil, errors.New("invalid_ad_unit_sizes")
	}
	sizes := make([]map[string]any, 0, len(entries))
	seen := make(map[string]bool)
	special := map[string]string{"fluid": "FLUID", "responsive": "FLUID", "自适应尺寸": "FLUID", "out-of-page": "INTERSTITIAL", "页外": "INTERSTITIAL", "native": "NATIVE", "custom rendering": "NATIVE", "自定义呈现": "NATIVE"}
	for _, entry := range entries {
		raw := strings.ToLower(importString(entry))
		size := map[string]any{}
		if match := sizePattern.FindStringSubmatch(raw); len(match) > 0 {
			width, _ := strconv.Atoi(match[1])
			height, _ := strconv.Atoi(match[2])
			if width == 0 || height == 0 {
				return nil, errors.New("invalid_ad_unit_size")
			}
			size = map[string]any{"width": width, "height": height, "sizeType": "PIXEL"}
		} else if kind := special[raw]; kind != "" {
			size = map[string]any{"width": 1, "height": 1, "sizeType": kind}
		} else {
			return nil, errors.New("unsupported_ad_unit_size_use_WxH_or_fluid")
		}
		key := fmt.Sprintf("%v:%v:%v", size["width"], size["height"], size["sizeType"])
		if seen[key] {
			return nil, errors.New("duplicate_ad_unit_size")
		}
		seen[key] = true
		sizes = append(sizes, map[string]any{"size": size, "environmentType": "BROWSER"})
	}
	return sizes, nil
}
func buildGamAdUnit(plan map[string]any, network, parent string) (map[string]any, error) {
	if err := resourceForNetwork(adUnitPattern, parent, network, "invalid_parent_ad_unit"); err != nil {
		return nil, err
	}
	name := fieldString(plan, "name")
	code := fieldString(plan, "gam_ad_unit_code")
	if code == "" {
		code = fieldString(plan, "code")
	}
	if name == "" || len(name) > 255 || code == "" || len(code) > 100 {
		return nil, errors.New("invalid_ad_unit_plan")
	}
	raw := plan["sizes"]
	if value, ok := plan["sizes_json"].(string); ok && value != "" {
		if err := json.Unmarshal([]byte(value), &raw); err != nil {
			return nil, err
		}
	} else if raw == nil {
		raw = plan["size"]
	}
	sizes, err := parseGamSizes(raw)
	if err != nil {
		return nil, err
	}
	unit := map[string]any{"parentAdUnit": parent, "displayName": name, "adUnitCode": code, "adUnitSizes": sizes}
	if description := fieldString(plan, "description"); description != "" {
		unit["description"] = description
	}
	if plan["adsense_enabled"] == float64(1) || plan["adsense_enabled"] == int64(1) || plan["adsense_enabled"] == true || plan["adsenseEnabled"] == true {
		unit["appliedAdsenseEnabled"] = true
	}
	target := fieldString(plan, "target_window")
	if target == "" {
		target = fieldString(plan, "targetWindow")
	}
	target = strings.ToUpper(target)
	if target == "TOP" || target == "_TOP" {
		unit["appliedTargetWindow"] = "TOP"
	}
	if target == "BLANK" || target == "_BLANK" {
		unit["appliedTargetWindow"] = "BLANK"
	}
	return unit, nil
}
func (a *app) getGamSite(r *http.Request, network, token, name string) (map[string]any, error) {
	if err := resourceForNetwork(sitePattern, name, network, "invalid_gam_site"); err != nil {
		return nil, err
	}
	return a.gamRequest(r.Context(), network, token, name, http.MethodGet, nil, nil)
}
func (a *app) getGamAdUnit(r *http.Request, network, token, name string) (map[string]any, error) {
	if err := resourceForNetwork(adUnitPattern, name, network, "invalid_parent_ad_unit"); err != nil {
		return nil, err
	}
	return a.gamRequest(r.Context(), network, token, name, http.MethodGet, nil, nil)
}
func (a *app) gamRootAdUnit(ctx context.Context, network, token string) (string, error) {
	result, err := a.gamRequest(ctx, network, token, "networks/"+network, http.MethodGet, nil, nil)
	if err != nil {
		return "", err
	}
	root := importString(result["effectiveRootAdUnit"])
	if result["name"] != "networks/"+network || resourceForNetwork(adUnitPattern, root, network, "invalid_gam_root_ad_unit") != nil {
		return "", errors.New("gam_root_ad_unit_unavailable")
	}
	return root, nil
}
func (a *app) findGamAdUnitByCode(r *http.Request, network, token, code string) (map[string]any, error) {
	encoded, _ := json.Marshal(code)
	values := url.Values{"pageSize": {"100"}, "filter": {"adUnitCode = " + string(encoded)}}
	result, err := a.gamRequest(r.Context(), network, token, "networks/"+network+"/adUnits", http.MethodGet, values, nil)
	if err != nil {
		return nil, err
	}
	for _, value := range array(result["adUnits"]) {
		unit := object(value)
		if unit["adUnitCode"] == code {
			return unit, nil
		}
	}
	return nil, nil
}
func (a *app) remoteCreateGamAdUnit(r *http.Request, network, token string, unit map[string]any) (map[string]any, error) {
	return a.gamRequest(r.Context(), network, token, "networks/"+network+"/adUnits", http.MethodPost, nil, unit)
}
func (a *app) gamCreation(id int64) map[string]any {
	row, _ := firstMap(a.db, "SELECT * FROM gam_ad_unit_creations WHERE id=?", id)
	return row
}
func (a *app) publicGamCreation(id int64) map[string]any {
	row, _ := firstMap(a.db, "SELECT "+gamCreationColumns+" FROM gam_ad_unit_creations WHERE id=?", id)
	return row
}
func (a *app) gamAdUnitCreations(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT "+gamCreationColumns+" FROM gam_ad_unit_creations ORDER BY id DESC LIMIT 1000")
}
func (a *app) saveGamCreated(row, remote map[string]any, actor, ip string) (map[string]any, error) {
	network := importString(row["network_code"])
	if err := resourceForNetwork(adUnitPattern, importString(remote["name"]), network, "invalid_created_ad_unit"); err != nil {
		return nil, err
	}
	if code := importString(remote["adUnitCode"]); code != "" && code != row["ad_unit_code"] {
		return nil, errors.New("created_ad_unit_mismatch")
	}
	if parent := importString(remote["parentAdUnit"]); parent != "" && parent != row["parent_ad_unit"] {
		return nil, errors.New("created_ad_unit_mismatch")
	}
	id := intMap(row, "id")
	_, err := a.db.Exec("UPDATE gam_ad_unit_creations SET status='created',provider_id=?,publish_error='',published_at=CURRENT_TIMESTAMP WHERE id=?", remote["name"], id)
	if err != nil {
		return nil, err
	}
	a.audit(actor, "gam.ad_unit_create", "gam_ad_unit_creation", id, marshalText(map[string]any{"networkCode": network, "siteName": row["site_name"], "parentAdUnit": row["parent_ad_unit"], "remoteName": remote["name"]}), ip)
	return a.publicGamCreation(id), nil
}
func (a *app) lockCreating(key string) bool {
	a.gamMu.Lock()
	defer a.gamMu.Unlock()
	if a.gamCreating[key] {
		return false
	}
	a.gamCreating[key] = true
	return true
}
func (a *app) unlockCreating(key string) {
	a.gamMu.Lock()
	delete(a.gamCreating, key)
	a.gamMu.Unlock()
}
func (a *app) createGamDirect(r *http.Request, input map[string]any, actor, ip, providedToken, providedRoot string) (map[string]any, error) {
	account, err := a.gamAccount(fieldID(input, "gamAccountId"))
	if err != nil || account["status"] != "active" || intMap(account, "enabled") != 1 {
		return nil, errors.New("invalid_gam_account_status")
	}
	network := importString(account["network_code"])
	siteName := fieldString(input, "siteName")
	if err := resourceForNetwork(sitePattern, siteName, network, "invalid_gam_site"); err != nil {
		return nil, err
	}
	token := providedToken
	if token == "" {
		token, err = a.tokenFor(r.Context(), account)
		if err != nil {
			return nil, err
		}
	}
	parent := providedRoot
	if parent == "" {
		parent, err = a.gamRootAdUnit(r.Context(), network, token)
		if err != nil {
			return nil, err
		}
	}
	if requested := fieldString(input, "parentAdUnit"); requested != "" && requested != parent {
		return nil, errors.New("invalid_nested_ad_unit")
	}
	unit, err := buildGamAdUnit(input, network, parent)
	if err != nil {
		return nil, err
	}
	code := importString(unit["adUnitCode"])
	key := network + ":" + strings.ToLower(code)
	if !a.lockCreating(key) {
		return nil, errors.New("gam_account_busy")
	}
	defer a.unlockCreating(key)
	if a.exists("SELECT id FROM gam_ad_unit_creations WHERE network_code=? AND ad_unit_code=?", network, code) {
		return nil, errors.New("ad_unit_already_created")
	}
	site, err := a.getGamSite(r, network, token, siteName)
	if err != nil {
		return nil, err
	}
	if site["name"] != siteName {
		return nil, errors.New("invalid_gam_site")
	}
	existing, err := a.findGamAdUnitByCode(r, network, token, code)
	if err != nil {
		return nil, err
	}
	if existing != nil && !sameRemoteGamUnit(existing, unit) {
		return nil, errors.New("ad_unit_already_exists_in_gam")
	}
	domain, err := gamSelectedSiteDomain(importString(site["url"]), fieldString(input, "domain"))
	if err != nil {
		return nil, err
	}
	rawSizes := input["sizes"]
	if rawSizes == nil {
		rawSizes = []any{input["size"]}
	}
	sizesText := marshalText(rawSizes)
	id, err := execID(a.db, "INSERT INTO gam_ad_unit_creations(gam_account_id,network_code,site_name,site_url,domain,parent_ad_unit,display_name,ad_unit_code,sizes_json,description,adsense_enabled,target_window,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", intMap(account, "id"), network, siteName, site["url"], domain, parent, unit["displayName"], code, sizesText, fieldString(unit, "description"), boolInt(unit["appliedAdsenseEnabled"] == true), fieldString(unit, "appliedTargetWindow"), actor)
	if err != nil {
		return nil, err
	}
	row := a.gamCreation(id)
	remote := existing
	if remote == nil {
		remote, err = a.remoteCreateGamAdUnit(r, network, token, unit)
	}
	if err == nil {
		var created map[string]any
		created, err = a.saveGamCreated(row, remote, actor, ip)
		if err == nil {
			return created, nil
		}
	}
	detail := err.Error()
	if len(detail) > 500 {
		detail = detail[:500]
	}
	_, _ = a.db.Exec("UPDATE gam_ad_unit_creations SET status='failed',publish_error=? WHERE id=?", detail, id)
	return nil, err
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
func (a *app) createGamAdUnit(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	item, err := a.createGamDirect(r, input, currentUser(r).Email, clientIP(r), "", "")
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"ok": true, "item": item})
	return nil
}
func (a *app) batchGamAdUnits(w http.ResponseWriter, r *http.Request) error {
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	account, err := a.gamAccount(fieldID(input, "gamAccountId"))
	if err != nil || account["status"] != "active" || intMap(account, "enabled") != 1 {
		return errors.New("invalid_gam_account_status")
	}
	entries := array(input["items"])
	if len(entries) == 0 || len(entries) > 100 {
		return errors.New("invalid_ad_unit_batch")
	}
	network := importString(account["network_code"])
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return err
	}
	root, err := a.gamRootAdUnit(r.Context(), network, token)
	if err != nil {
		return err
	}
	prepared := make([]map[string]any, len(entries))
	seen := make(map[string]bool)
	for index, value := range entries {
		item := object(value)
		if item == nil {
			return errors.New("invalid_ad_unit_plan")
		}
		site := fieldString(item, "siteName")
		if err := resourceForNetwork(sitePattern, site, network, "invalid_gam_site"); err != nil {
			return err
		}
		if requested := fieldString(item, "parentAdUnit"); requested != "" && requested != root {
			return errors.New("invalid_nested_ad_unit")
		}
		unit, err := buildGamAdUnit(item, network, root)
		if err != nil {
			return err
		}
		code := strings.ToLower(importString(unit["adUnitCode"]))
		if seen[code] {
			return errors.New("duplicate_ad_unit_code")
		}
		seen[code] = true
		item["gamAccountId"] = intMap(account, "id")
		prepared[index] = item
	}
	results := make([]map[string]any, len(entries))
	jobs := make(chan int)
	var group sync.WaitGroup
	for worker := 0; worker < 3; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				item := prepared[index]
				code := fieldString(item, "code")
				if code == "" {
					code = fieldString(item, "gam_ad_unit_code")
				}
				created, err := a.createGamDirect(r, item, currentUser(r).Email, clientIP(r), token, root)
				if err != nil {
					detail := err.Error()
					if len(detail) > 500 {
						detail = detail[:500]
					}
					log.Printf("gam_ad_unit_batch_failed account=%d index=%d error=%s", intMap(account, "id"), index, detail)
					results[index] = map[string]any{"index": index, "code": code, "siteName": item["siteName"], "status": "failed", "error": detail}
				} else {
					results[index] = map[string]any{"index": index, "code": code, "siteName": item["siteName"], "status": "created", "item": created}
				}
			}
		}()
	}
	for index := range prepared {
		jobs <- index
	}
	close(jobs)
	group.Wait()
	created, failed := 0, 0
	for _, result := range results {
		if result["status"] == "created" {
			created++
		} else {
			failed++
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "created": created, "failed": failed, "results": results})
	return nil
}
func sizeKey(unit map[string]any) string {
	entries := array(unit["adUnitSizes"])
	if direct, ok := unit["adUnitSizes"].([]map[string]any); ok {
		for _, entry := range direct {
			entries = append(entries, entry)
		}
	}
	keys := make([]string, 0, len(entries))
	for _, entry := range entries {
		value := object(entry)
		size := object(value["size"])
		keys = append(keys, fmt.Sprintf("%v:%v:%v:%v", size["width"], size["height"], size["sizeType"], value["environmentType"]))
	}
	sort.Strings(keys)
	return strings.Join(keys, "|")
}
func sameRemoteGamUnit(remote, expected map[string]any) bool {
	return remote["parentAdUnit"] == expected["parentAdUnit"] && remote["displayName"] == expected["displayName"] && remote["adUnitCode"] == expected["adUnitCode"] && sizeKey(remote) == sizeKey(expected)
}
func (a *app) retryGamAdUnit(w http.ResponseWriter, r *http.Request) error {
	row := a.gamCreation(pathID(r))
	if row == nil {
		writeError(w, 404, "ad_unit_not_found")
		return nil
	}
	if row["status"] == "created" {
		return errors.New("ad_unit_already_created")
	}
	account, err := a.gamAccount(intMap(row, "gam_account_id"))
	if err != nil || account["status"] != "active" || intMap(account, "enabled") != 1 || account["network_code"] != row["network_code"] {
		return errors.New("invalid_gam_account_status")
	}
	network, code := importString(row["network_code"]), importString(row["ad_unit_code"])
	key := network + ":" + strings.ToLower(code)
	if !a.lockCreating(key) {
		return errors.New("gam_account_busy")
	}
	defer a.unlockCreating(key)
	plan := map[string]any{"name": row["display_name"], "code": code, "sizes_json": row["sizes_json"], "description": row["description"], "adsense_enabled": row["adsense_enabled"], "target_window": row["target_window"]}
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return err
	}
	root, err := a.gamRootAdUnit(r.Context(), network, token)
	if err != nil {
		return a.failGamCreation(row, err)
	}
	if row["parent_ad_unit"] != root {
		return a.failGamCreation(row, errors.New("invalid_nested_ad_unit"))
	}
	unit, err := buildGamAdUnit(plan, network, root)
	if err != nil {
		return a.failGamCreation(row, err)
	}
	site, err := a.getGamSite(r, network, token, importString(row["site_name"]))
	if err != nil {
		return a.failGamCreation(row, err)
	}
	domain, err := gamSelectedSiteDomain(importString(site["url"]), importString(row["domain"]))
	if err != nil {
		return a.failGamCreation(row, err)
	}
	if site["name"] != row["site_name"] || domain != row["domain"] {
		return a.failGamCreation(row, errors.New("gam_site_mismatch"))
	}
	remote, err := a.findGamAdUnitByCode(r, network, token, code)
	if err != nil {
		return a.failGamCreation(row, err)
	}
	if remote != nil && !sameRemoteGamUnit(remote, unit) {
		return a.failGamCreation(row, errors.New("ad_unit_already_exists_in_gam"))
	}
	if remote == nil {
		remote, err = a.remoteCreateGamAdUnit(r, network, token, unit)
		if err != nil {
			return a.failGamCreation(row, err)
		}
	}
	item, err := a.saveGamCreated(row, remote, currentUser(r).Email, clientIP(r))
	if err != nil {
		return a.failGamCreation(row, err)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "item": item})
	return nil
}
func (a *app) failGamCreation(row map[string]any, err error) error {
	detail := err.Error()
	if len(detail) > 500 {
		detail = detail[:500]
	}
	_, _ = a.db.Exec("UPDATE gam_ad_unit_creations SET status='failed',publish_error=? WHERE id=?", detail, row["id"])
	return err
}
func (a *app) publishManagedAdUnit(w http.ResponseWriter, r *http.Request) error {
	id := pathID(r)
	item, err := firstMap(a.db, "SELECT * FROM managed_ad_units WHERE id=?", id)
	if err != nil {
		writeError(w, 404, "ad_unit_not_found")
		return nil
	}
	input, ok := bodyMap(w, r)
	if !ok {
		return nil
	}
	account, err := a.gamAccount(fieldID(input, "gamAccountId"))
	if err != nil || account["status"] != "active" || intMap(account, "enabled") != 1 {
		return errors.New("invalid_gam_account_status")
	}
	if item["status"] == "created" || item["provider_id"] != nil && item["provider_id"] != "" {
		return errors.New("ad_unit_already_created")
	}
	a.gamMu.Lock()
	if a.gamPublishing[id] {
		a.gamMu.Unlock()
		return errors.New("gam_account_busy")
	}
	a.gamPublishing[id] = true
	a.gamMu.Unlock()
	defer func() { a.gamMu.Lock(); delete(a.gamPublishing, id); a.gamMu.Unlock() }()
	network := importString(account["network_code"])
	token, err := a.tokenFor(r.Context(), account)
	if err != nil {
		return a.failManagedUnit(id, err)
	}
	parentName, err := a.gamRootAdUnit(r.Context(), network, token)
	if err != nil {
		return a.failManagedUnit(id, err)
	}
	if requested := fieldString(input, "parentAdUnit"); requested != "" && requested != parentName {
		return a.failManagedUnit(id, errors.New("invalid_nested_ad_unit"))
	}
	unit, err := buildGamAdUnit(item, network, parentName)
	if err != nil {
		return a.failManagedUnit(id, err)
	}
	remote, err := a.findGamAdUnitByCode(r, network, token, importString(item["code"]))
	if err != nil {
		return a.failManagedUnit(id, err)
	}
	if remote != nil && remote["parentAdUnit"] != parentName {
		return a.failManagedUnit(id, errors.New("parent_ad_unit_mismatch"))
	}
	if remote == nil {
		remote, err = a.remoteCreateGamAdUnit(r, network, token, unit)
		if err != nil {
			return a.failManagedUnit(id, err)
		}
	}
	name := importString(remote["name"])
	if name == "" {
		return a.failManagedUnit(id, errors.New("invalid_created_ad_unit"))
	}
	_, err = a.db.Exec("UPDATE managed_ad_units SET status='created',provider_id=?,gam_network_code=?,gam_parent_ad_unit=?,publish_error='',published_at=CURRENT_TIMESTAMP WHERE id=?", name, network, parentName, id)
	if err != nil {
		return a.failManagedUnit(id, err)
	}
	a.audit(currentUser(r).Email, "gam.ad_unit_publish", "managed_ad_unit", id, marshalText(map[string]any{"networkCode": network, "parentAdUnit": parentName, "remoteName": name}), clientIP(r))
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
	return nil
}
func (a *app) failManagedUnit(id int64, err error) error {
	detail := err.Error()
	if len(detail) > 500 {
		detail = detail[:500]
	}
	_, _ = a.db.Exec("UPDATE managed_ad_units SET status='failed',publish_error=? WHERE id=?", detail, id)
	return err
}
