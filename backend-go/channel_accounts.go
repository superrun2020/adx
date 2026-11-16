package main

import (
	"database/sql"
	"errors"
	"math"
	"sort"
)

var errInvalidChannelAccount = errors.New("invalid_channel_account")
var errChannelAccountBusy = errors.New("gam_account_busy")
var errConflictingChannelFacts = errors.New("conflicting_channel_facts")

func selectedChannelAccounts(input map[string]any) ([]int64, bool, error) {
	value, present := input["gamAccountIds"]
	if !present {
		return nil, false, nil
	}
	list, valid := value.([]any)
	if !valid || len(list) > 100 {
		return nil, true, errInvalidChannelAccount
	}
	ids := make([]int64, 0, len(list))
	seen := map[int64]bool{}
	for _, value := range list {
		number, valid := value.(float64)
		if !valid || number < 1 || number > 9007199254740991 || math.Trunc(number) != number {
			return nil, true, errInvalidChannelAccount
		}
		id := int64(number)
		if seen[id] {
			return nil, true, errInvalidChannelAccount
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, true, nil
}

func (a *app) lockChannelAccounts(ids []int64) (func(), error) {
	locked := make([]int64, 0, len(ids))
	for _, id := range ids {
		if !a.lockGam(id) {
			for _, prior := range locked {
				a.unlockGam(prior)
			}
			return nil, errChannelAccountBusy
		}
		locked = append(locked, id)
	}
	return func() {
		for _, id := range locked {
			a.unlockGam(id)
		}
	}, nil
}

// Bind selected GAM accounts to this channel from the report date onward.
// Previous report dates keep their original settlement owner.
func assignChannelAccounts(tx *sql.Tx, channelID int64, ids []int64, effective, actor string) (map[int64]string, error) {
	affected := map[int64]string{}
	for _, id := range ids {
		var network, status, reportName string
		var oldChannel, upstreamID sql.NullInt64
		var enabled int
		err := tx.QueryRow("SELECT network_code,status,enabled,rest_report_name,rest_channel_id,rest_upstream_account_id FROM soap_accounts WHERE id=?", id).
			Scan(&network, &status, &enabled, &reportName, &oldChannel, &upstreamID)
		if err == sql.ErrNoRows {
			return nil, errInvalidChannelAccount
		}
		if err != nil {
			return nil, err
		}
		if status != "active" || enabled != 1 || reportName == "" || !upstreamID.Valid {
			return nil, errInvalidChannelAccount
		}
		var accountKey string
		if err = tx.QueryRow("SELECT account_key FROM upstream_accounts WHERE id=? AND soap_account_id=? AND status='active'", upstreamID.Int64, id).Scan(&accountKey); err == sql.ErrNoRows {
			return nil, errInvalidChannelAccount
		} else if err != nil {
			return nil, err
		}
		if !oldChannel.Valid || oldChannel.Int64 != channelID {
			if oldChannel.Valid {
				_, err = tx.Exec("INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) SELECT ?,?,'1900-01-01',? WHERE NOT EXISTS (SELECT 1 FROM gam_channel_assignments WHERE soap_account_id=?)", id, oldChannel.Int64, actor, id)
			} else {
				_, err = tx.Exec("INSERT OR IGNORE INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(?,?,'1900-01-01',?)", id, channelID, actor)
			}
			if err != nil {
				return nil, err
			}
			if _, err = tx.Exec("DELETE FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from>=?", id, effective); err != nil {
				return nil, err
			}
			if _, err = tx.Exec("INSERT INTO gam_channel_assignments(soap_account_id,channel_id,effective_from,created_by) VALUES(?,?,?,?)", id, channelID, effective, actor); err != nil {
				return nil, err
			}
			var channels int
			var lastDate sql.NullString
			prefix := "gam-rest:" + network + ":%"
			if err = tx.QueryRow("SELECT COUNT(DISTINCT channel_id),MAX(report_date) FROM revenue_facts WHERE account=? AND report_date>=? AND source_file LIKE ?", accountKey, effective, prefix).Scan(&channels, &lastDate); err != nil {
				return nil, err
			}
			if channels > 1 {
				return nil, errConflictingChannelFacts
			}
			if lastDate.Valid {
				if _, err = tx.Exec("UPDATE revenue_facts SET channel_id=? WHERE account=? AND report_date>=? AND source_file LIKE ?", channelID, accountKey, effective, prefix); err != nil {
					return nil, err
				}
				if oldChannel.Valid && lastDate.String > affected[oldChannel.Int64] {
					affected[oldChannel.Int64] = lastDate.String
				}
				if lastDate.String > affected[channelID] {
					affected[channelID] = lastDate.String
				}
			}
		}
		if _, err = tx.Exec("UPDATE soap_accounts SET rest_channel_id=?,channel_locked_to_account=1,updated_at=CURRENT_TIMESTAMP WHERE id=?", channelID, id); err != nil {
			return nil, err
		}
		if _, err = tx.Exec("UPDATE link_metadata SET channel_id=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE network_code=?", channelID, actor, network); err != nil {
			return nil, err
		}
	}
	return affected, nil
}

func (a *app) refreshChannelAssignments(affected map[int64]string, effective string) {
	for channelID, end := range affected {
		a.refreshDailySafely(channelID, effective, end)
	}
	if len(affected) == 0 {
		a.invalidateReportCache()
	}
}
