package main

import (
	"net/http"
	"strconv"
)

func channelDomainOwnerAtSQL(domainExpr, dateExpr string) string {
	domain := "LOWER(RTRIM(SUBSTR(" + domainExpr + ",1,INSTR(" + domainExpr + "||'/', '/')-1),'.'))"
	return "(SELECT owner.channel_id FROM (" +
		"SELECT m.channel_id,m.domain,3 priority,m.updated_at stamp FROM link_metadata m WHERE m.channel_id IS NOT NULL " +
		"UNION ALL SELECT d.channel_id,d.root_domain,2 priority,d.effective_from stamp FROM gam_domain_channel_assignments d WHERE d.effective_from<=" + dateExpr + " " +
		"UNION ALL SELECT cd.channel_id,cd.domain,1 priority,cd.created_at stamp FROM channel_domains cd" +
		") owner WHERE " + domain + "=LOWER(owner.domain) OR " + domain + " LIKE '%.'||LOWER(owner.domain) " +
		"ORDER BY LENGTH(owner.domain) DESC,owner.priority DESC,owner.stamp DESC LIMIT 1)"
}

func channelDomainOwnerSQL(domainExpr string) string {
	return channelDomainOwnerAtSQL(domainExpr, "'9999-12-31'")
}

func channelDomainScopeSQL(alias string, channelID int64) string {
	return "COALESCE(" + channelDomainOwnerAtSQL(mappedDomainSQL(alias), alias+".report_date") + "," + alias + ".channel_id)=" + strconv.FormatInt(channelID, 10)
}

func channelRuleShareForSQL(alias string, channelID int64) string {
	id := strconv.FormatInt(channelID, 10)
	domain := mappedDomainSQL(alias)
	return "COALESCE(" +
		"(SELECT r.share_percent FROM channel_domain_share_rules r JOIN upstream_accounts u ON u.id=r.upstream_account_id " +
		"WHERE r.channel_id=" + id + " AND u.account_key=" + alias + ".account COLLATE NOCASE " +
		"AND (r.domain='' OR r.domain=" + domain + " COLLATE NOCASE) AND r.effective_from<=" + alias + ".report_date " +
		"ORDER BY CASE WHEN r.domain='' THEN 1 ELSE 0 END,r.effective_from DESC,r.id DESC LIMIT 1)," +
		"(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=" + id + " AND r.scope_type='ad_unit' " +
		"AND r.scope_value=" + alias + ".ad_unit COLLATE NOCASE AND r.effective_from<=" + alias + ".report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1)," +
		"(SELECT r.share_percent FROM channel_share_rules r WHERE r.channel_id=" + id + " AND r.scope_type='account' " +
		"AND r.scope_value=" + alias + ".account COLLATE NOCASE AND r.effective_from<=" + alias + ".report_date ORDER BY r.effective_from DESC,r.id DESC LIMIT 1)," +
		"(SELECT v.share_percent FROM channel_share_versions v WHERE v.channel_id=" + id + " AND v.effective_from<=" + alias + ".report_date ORDER BY v.effective_from DESC,v.id DESC LIMIT 1),100)"
}

func settledRevenueForChannelSQL(alias string, channelID int64) string {
	return "(" + alias + ".revenue*(" + upstreamShareSQL(alias) + "/100.0)*(" + channelRuleShareForSQL(alias, channelID) + "/100.0))"
}

func (a *app) channelDomains(w http.ResponseWriter, r *http.Request) {
	channelID := currentUser(r).ChannelID.Int64
	sql := "SELECT DISTINCT cd.domain,cd.adx_txt adxTxt,cd.gam_account_id gamAccountId," +
		"COALESCE(s.name,'') accountName,COALESCE(lm.network_code,'') networkCode,cd.created_at assignedAt " +
		"FROM channel_domains cd LEFT JOIN soap_accounts s ON s.id=cd.gam_account_id " +
		"LEFT JOIN link_metadata lm ON lower(lm.domain)=lower(cd.domain) AND lm.channel_id=cd.channel_id WHERE " +
		channelDomainOwnerSQL("cd.domain") + "=? ORDER BY cd.domain"
	rows, err := queryMaps(a.db, sql, channelID)
	if err != nil {
		writeError(w, 500, "channel_domains_unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": rows})
}

func (a *app) channelContract(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	registration, found := a.one("SELECT id,company_name companyName,contact_name contactName,registration_number registrationNumber,country,registered_address registeredAddress,phone,status,created_at createdAt FROM channel_registrations WHERE user_id=?", user.ID)
	if !found {
		writeJSON(w, 200, map[string]any{"ok": true, "contract": nil})
		return
	}
	contract, found := a.one("SELECT version,contract_text contractText,contract_hash contractHash,signer_name signerName,signer_title signerTitle,signed_at signedAt,signature_data signatureData,counter_signer counterSigner,counter_signer_title counterSignerTitle,counter_signature_data counterSignatureData,countersigned_at countersignedAt FROM channel_registration_contracts WHERE registration_id=? ORDER BY id DESC LIMIT 1", intMap(registration, "id"))
	if !found {
		writeJSON(w, 200, map[string]any{"ok": true, "contract": map[string]any{"status": registration["status"], "registration": registration}})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "contract": map[string]any{"status": registration["status"], "registration": registration, "agreement": contract}})
}

func (a *app) channelRegressionEvents(w http.ResponseWriter, r *http.Request) {
	a.listRegressionEvents(w, r, currentUser(r).ChannelID.Int64)
}

func (a *app) channelCoverageEvents(w http.ResponseWriter, r *http.Request) {
	a.listCoverageEvents(w, r, currentUser(r).ChannelID.Int64)
}
