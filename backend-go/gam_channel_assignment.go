package main

import (
	"database/sql"
)

type gamChannelAssignment struct {
	Date      string
	ChannelID int64
}

func (a *app) gamChannelAssignments(accountID, fallback int64, end string) ([]gamChannelAssignment, error) {
	rows, err := a.db.Query("SELECT effective_from,channel_id FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from<=? ORDER BY effective_from", accountID, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	assignments := []gamChannelAssignment{{Date: "1900-01-01", ChannelID: fallback}}
	for rows.Next() {
		var item gamChannelAssignment
		if err := rows.Scan(&item.Date, &item.ChannelID); err != nil {
			return nil, err
		}
		assignments = append(assignments, item)
	}
	return assignments, rows.Err()
}

func channelForGamDate(assignments []gamChannelAssignment, date string) int64 {
	channelID := assignments[0].ChannelID
	for _, item := range assignments[1:] {
		if item.Date > date {
			break
		}
		channelID = item.ChannelID
	}
	return channelID
}

func (a *app) gamChannelForDate(accountID, fallback int64, date string) (int64, error) {
	var channelID int64
	err := a.db.QueryRow("SELECT channel_id FROM gam_channel_assignments WHERE soap_account_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1", accountID, date).Scan(&channelID)
	if err == sql.ErrNoRows {
		return fallback, nil
	}
	return channelID, err
}
