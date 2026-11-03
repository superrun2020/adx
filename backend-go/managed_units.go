package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

var builderAliases = map[string][]string{
	"subdomain":     {"subdomain", "sub_domain", "domain", "hostname", "url", "site", "子域名", "域名"},
	"inventoryType": {"inventory_type", "ad_type", "placement_type", "type", "广告位类型", "广告类型", "广告位"},
	"size":          {"size", "sizes", "ad_size", "dimensions", "dimension", "尺寸", "广告尺寸"},
	"adUnit":        {"ad_unit", "adunit", "ad_unit_name", "广告单元", "广告位名称"},
	"name":          {"name", "名称", "广告单元名称"}, "description": {"description", "说明", "描述"},
	"adsenseEnabled": {"adsense_enabled", "已启用 adsense", "启用 adsense"}, "placement": {"placement", "刊登位置"},
	"targetWindow": {"target_window", "目标视窗", "目标窗口"}, "label": {"label", "标签"},
}
var splitBuilderValues = regexp.MustCompile("[;,|，、\n]+")
var nonCode = regexp.MustCompile("[^a-z0-9]+")

func builderFirst(row map[string]any, name string) any {
	for key, value := range row {
		for _, alias := range builderAliases[name] {
			if canonicalName(key) == canonicalName(alias) {
				return value
			}
		}
	}
	return nil
}
func builderValues(value any) []string {
	if values, ok := value.([]any); ok {
		out := make([]string, 0)
		for _, item := range values {
			out = append(out, builderValues(item)...)
		}
		return out
	}
	out := make([]string, 0)
	for _, part := range splitBuilderValues.Split(importString(value), -1) {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
func ruleValues(rules map[string]any, name string) []string { return builderValues(rules[name]) }
func managedRows(payload any) []any {
	if rows, ok := payload.([]any); ok {
		return rows
	}
	value := object(payload)
	for _, key := range []string{"data", "rows"} {
		if rows, ok := value[key].([]any); ok {
			return rows
		}
	}
	return nil
}
func buildManagedUnits(payload any, rules map[string]any) []map[string]any {
	selectedDomains := ruleValues(rules, "subdomains")
	selectedTypes := ruleValues(rules, "inventoryTypes")
	selectedSizes := ruleValues(rules, "sizes")
	for index, domain := range selectedDomains {
		selectedDomains[index] = normalizedDomain(domain)
	}
	items := make([]map[string]any, 0)
	byCode := make(map[string]int)
	for _, value := range managedRows(payload) {
		row := object(value)
		domains := selectedDomains
		if len(domains) == 0 {
			raw := builderValues(builderFirst(row, "subdomain"))
			domains = make([]string, 0, len(raw))
			for _, part := range raw {
				if domain := normalizedDomain(part); domain != "" {
					domains = append(domains, domain)
				}
			}
			if len(domains) == 0 {
				domains = []string{"unmapped"}
			}
		}
		types := selectedTypes
		if len(types) == 0 {
			types = builderValues(builderFirst(row, "inventoryType"))
			if len(types) == 0 {
				types = []string{"standard"}
			}
		}
		sizes := selectedSizes
		if len(sizes) == 0 {
			sizes = builderValues(builderFirst(row, "size"))
			if len(sizes) == 0 {
				sizes = []string{"responsive"}
			}
		}
		for _, domain := range domains {
			for _, kind := range types {
				for _, size := range sizes {
					code := strings.Trim(nonCode.ReplaceAllString(strings.ToLower(domain+"-"+kind+"-"+size), "-"), "-")
					if len(code) > 120 {
						code = code[:120]
					}
					name := importString(builderFirst(row, "name"))
					if name == "" {
						name = domain + " / " + kind + " / " + size
					}
					enabled := strings.ToLower(importString(builderFirst(row, "adsenseEnabled")))
					adsense := enabled == "true" || enabled == "1" || enabled == "yes" || enabled == "是"
					item := map[string]any{"code": code, "name": name, "subdomain": domain, "inventoryType": kind, "size": size, "description": importString(builderFirst(row, "description")), "adsenseEnabled": adsense, "placement": importString(builderFirst(row, "placement")), "targetWindow": importString(builderFirst(row, "targetWindow")), "label": importString(builderFirst(row, "label")), "sourceRow": row}
					if index, exists := byCode[code]; exists {
						items[index] = item
					} else {
						byCode[code] = len(items)
						items = append(items, item)
					}
				}
			}
		}
	}
	return items
}
func (a *app) previewManagedAdUnits(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	items := buildManagedUnits(input["payload"], object(input["rules"]))
	if len(items) == 0 {
		writeError(w, 400, "no_ad_units_detected")
		return
	}
	rows, err := queryMaps(a.db, "SELECT code FROM managed_ad_units")
	if err != nil {
		serverError(w, err)
		return
	}
	existing := make(map[string]bool)
	for _, row := range rows {
		existing[strings.ToLower(importString(row["code"]))] = true
	}
	duplicates := make([]string, 0)
	for _, item := range items {
		code := importString(item["code"])
		if existing[code] {
			duplicates = append(duplicates, code)
		}
	}
	preview := items
	if len(preview) > 500 {
		preview = preview[:500]
	}
	writeJSON(w, 200, map[string]any{"ok": true, "total": len(items), "duplicates": duplicates, "items": preview})
}
func (a *app) createManagedAdUnits(w http.ResponseWriter, r *http.Request) {
	input, ok := bodyMap(w, r)
	if !ok {
		return
	}
	items := make([]map[string]any, 0)
	if provided, ok := input["items"].([]any); ok {
		for _, entry := range provided {
			items = append(items, object(entry))
		}
	} else {
		items = buildManagedUnits(input["payload"], object(input["rules"]))
	}
	if len(items) == 0 {
		writeError(w, 400, "no_ad_units")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	statement, err := tx.PrepareContext(r.Context(), "INSERT OR IGNORE INTO managed_ad_units(code,name,subdomain,inventory_type,size,description,adsense_enabled,placement,target_window,label,source_row_json,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
	if err != nil {
		serverError(w, err)
		return
	}
	defer statement.Close()
	created := int64(0)
	for _, item := range items {
		raw, _ := json.Marshal(item["sourceRow"])
		if len(raw) == 0 || string(raw) == "null" {
			raw = []byte("{}")
		}
		result, err := statement.ExecContext(r.Context(), item["code"], item["name"], item["subdomain"], item["inventoryType"], item["size"], fieldString(item, "description"), boolInt(item["adsenseEnabled"] == true), fieldString(item, "placement"), fieldString(item, "targetWindow"), fieldString(item, "label"), string(raw), "planned", currentUser(r).Email)
		if err != nil {
			serverError(w, err)
			return
		}
		changed, _ := result.RowsAffected()
		created += changed
	}
	if err = tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.audit(currentUser(r).Email, "ad_units.create", "ad_unit_batch", "", marshalText(map[string]any{"requested": len(items), "created": created}), clientIP(r))
	writeJSON(w, 201, map[string]any{"ok": true, "created": created, "skipped": int64(len(items)) - created, "status": "planned", "message": "已保存本地广告单元计划，等待 GAM API 授权后执行真实创建"})
}
func (a *app) managedAdUnits(w http.ResponseWriter, r *http.Request) {
	a.sendItems(w, "SELECT id,code,name,subdomain,inventory_type inventoryType,size,description,adsense_enabled adsenseEnabled,placement,target_window targetWindow,label,status,provider_id providerId,gam_network_code gamNetworkCode,gam_parent_ad_unit gamParentAdUnit,publish_error publishError,published_at publishedAt,created_at createdAt FROM managed_ad_units ORDER BY id DESC LIMIT 1000")
}
