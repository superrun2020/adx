package main

import (
	"database/sql"
	"strings"
)

type gamChannelAssignment struct {
	Date      string
	ChannelID int64
}

type gamDomainChannelAssignment struct {
	RootDomain string
	Date       string
	ChannelID  int64
}

func (a *app) gamDomainChannelAssignments(end string) ([]gamDomainChannelAssignment, error) {
	rows, err := a.db.Query("SELECT root_domain,effective_from,channel_id FROM gam_domain_channel_assignments WHERE effective_from<=? ORDER BY root_domain,effective_from", end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	assignments := []gamDomainChannelAssignment{}
	for rows.Next() {
		var item gamDomainChannelAssignment
		if err := rows.Scan(&item.RootDomain, &item.Date, &item.ChannelID); err != nil {
			return nil, err
		}
		assignments = append(assignments, item)
	}
	return assignments, rows.Err()
}

func channelForGamDomainDate(assignments []gamDomainChannelAssignment, date, domain string, fallback int64) int64 {
	domain = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	bestRoot, bestDate := "", ""
	channelID := fallback
	for _, item := range assignments {
		root := strings.ToLower(item.RootDomain)
		if item.Date > date || (domain != root && !strings.HasSuffix(domain, "."+root)) {
			continue
		}
		if len(root) > len(bestRoot) || (len(root) == len(bestRoot) && item.Date >= bestDate) {
			bestRoot, bestDate, channelID = root, item.Date, item.ChannelID
		}
	}
	return channelID
}

func (a *app) gamChannelForDomainDate(accountID, fallback int64, date, domain string) (int64, error) {
	channelID, err := a.gamChannelForDate(accountID, fallback, date)
	if err != nil {
		return 0, err
	}
	assignments, err := a.gamDomainChannelAssignments(date)
	if err != nil {
		return 0, err
	}
	return channelForGamDomainDate(assignments, date, domain, channelID), nil
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
