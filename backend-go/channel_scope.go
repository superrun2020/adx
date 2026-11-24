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
	sql := "WITH assigned AS (" +
		"SELECT m.domain,m.channel_id,m.network_code,s.id gam_account_id,m.updated_at assigned_at " +
		"FROM link_metadata m LEFT JOIN soap_accounts s ON s.network_code=m.network_code " +
		"UNION ALL SELECT d.domain,d.channel_id,COALESCE(s.network_code,''),d.gam_account_id,d.created_at " +
		"FROM channel_domains d LEFT JOIN soap_accounts s ON s.id=d.gam_account_id " +
		"WHERE NOT EXISTS (SELECT 1 FROM link_metadata m WHERE lower(m.domain)=lower(d.domain) AND m.channel_id=d.channel_id)) " +
		"SELECT DISTINCT a.domain,COALESCE(cd.adx_txt,'') adxTxt,a.gam_account_id gamAccountId," +
		"COALESCE(s.name,'') accountName,a.network_code networkCode,a.assigned_at assignedAt " +
		"FROM assigned a LEFT JOIN channel_domains cd ON lower(cd.domain)=lower(a.domain) AND cd.channel_id=a.channel_id " +
		"LEFT JOIN soap_accounts s ON s.id=a.gam_account_id WHERE a.channel_id=? AND " +
		channelDomainOwnerSQL("a.domain") + "=? ORDER BY a.domain"
	rows, err := queryMaps(a.db, sql, channelID, channelID)
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
		writeJSON(w, 200, map[string]any{"ok": true, "contract": map[string]any{"status": "registered", "registration": map[string]any{
			"companyName": user.CompanyName, "contactName": user.Name, "email": user.Email,
		}, "assignedDomainCount": 0, "gamAccountCount": 0, "emailVerificationRequired": contractEmailRequired()}})
		return
	}
	var assignedDomainCount, gamAccountCount int
	if user.ChannelID.Valid {
		_ = a.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM channel_domains WHERE channel_id=?", user.ChannelID.Int64).Scan(&assignedDomainCount)
		_ = a.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM soap_accounts WHERE rest_channel_id=?", user.ChannelID.Int64).Scan(&gamAccountCount)
	}
	contract, found := a.one("SELECT version,contract_text contractText,contract_hash contractHash,signer_name signerName,signer_title signerTitle,signed_at signedAt,signature_data signatureData,counter_signer counterSigner,counter_signer_title counterSignerTitle,counter_signature_data counterSignatureData,countersigned_at countersignedAt,signed_pdf_sha256 signedPdfSha256 FROM channel_registration_contracts WHERE registration_id=? ORDER BY id DESC LIMIT 1", intMap(registration, "id"))
	if !found {
		writeJSON(w, 200, map[string]any{"ok": true, "contract": map[string]any{"status": registration["status"], "registration": registration, "assignedDomainCount": assignedDomainCount, "gamAccountCount": gamAccountCount, "emailVerificationRequired": contractEmailRequired()}})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "contract": map[string]any{"status": registration["status"], "registration": registration, "agreement": contract, "assignedDomainCount": assignedDomainCount, "gamAccountCount": gamAccountCount, "emailVerificationRequired": contractEmailRequired()}})
}

func (a *app) channelRegressionEvents(w http.ResponseWriter, r *http.Request) {
	a.listRegressionEvents(w, r, currentUser(r).ChannelID.Int64)
}

func (a *app) channelCoverageEvents(w http.ResponseWriter, r *http.Request) {
	a.listCoverageEvents(w, r, currentUser(r).ChannelID.Int64)
}
