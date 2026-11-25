package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/textproto"
	"time"
)

const partyAContractEmail = "notice@junglelabs.uk"

func queueSignedContractEmail(tx *sql.Tx, registrationID int64, purpose, recipient string) error {
	_, err := tx.Exec("INSERT INTO channel_contract_mail_deliveries(registration_id,purpose,recipient) VALUES(?,?,?)",
		registrationID, purpose, recipient)
	return err
}

func contractMailFailure(err error) string {
	var smtpError *textproto.Error
	if errors.As(err, &smtpError) {
		return fmt.Sprintf("smtp_%d", smtpError.Code)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return fmt.Sprintf("%T", err)
}

func (a *app) deliverSignedContractEmail(ctx context.Context, registrationID int64, purpose string) error {
	return a.deliverSignedContractEmailWith(ctx, registrationID, purpose, sendSignedContractEmail)
}

func (a *app) deliverSignedContractEmailWith(ctx context.Context, registrationID int64, purpose string,
	sender func(context.Context, string, int64, []byte) error) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claimed, err := a.db.ExecContext(ctx, "UPDATE channel_contract_mail_deliveries SET status='sending',attempts=attempts+1,last_attempt_at=? "+
		"WHERE registration_id=? AND purpose=? AND status IN ('pending','failed','sending') AND attempts<8 "+
		"AND (last_attempt_at IS NULL OR julianday(last_attempt_at)<=julianday('now','-15 minutes'))", now, registrationID, purpose)
	if err != nil {
		return err
	}
	count, _ := claimed.RowsAffected()
	if count != 1 {
		return nil
	}
	var recipient, storedHash string
	var pdf []byte
	err = a.db.QueryRowContext(ctx, "SELECT d.recipient,c.signed_pdf,c.signed_pdf_sha256 "+
		"FROM channel_contract_mail_deliveries d JOIN channel_registrations r ON r.id=d.registration_id "+
		"JOIN channel_registration_contracts c ON c.registration_id=r.id "+
		"WHERE d.registration_id=? AND d.purpose=? AND r.status='approved' AND c.countersigned_at IS NOT NULL ORDER BY c.id DESC LIMIT 1", registrationID, purpose).
		Scan(&recipient, &pdf, &storedHash)
	if err == nil {
		digest := sha256.Sum256(pdf)
		if len(pdf) == 0 || hex.EncodeToString(digest[:]) != storedHash {
			err = errors.New("signed_pdf_integrity_failed")
		}
	}
	if err == nil {
		err = sender(ctx, recipient, registrationID, pdf)
	}
	if err != nil {
		code := contractMailFailure(err)
		_, _ = a.db.ExecContext(context.Background(), "UPDATE channel_contract_mail_deliveries SET status='failed',last_error=? WHERE registration_id=? AND purpose=? AND status='sending'", code, registrationID, purpose)
		log.Printf("contract_mail_delivery_failed registration=%d purpose=%s code=%s", registrationID, purpose, code)
		return err
	}
	_, err = a.db.ExecContext(context.Background(), "UPDATE channel_contract_mail_deliveries SET status='sent',sent_at=?,last_error='' WHERE registration_id=? AND purpose=? AND status='sending'", time.Now().UTC().Format(time.RFC3339Nano), registrationID, purpose)
	return err
}

func (a *app) runPendingContractDeliveries(ctx context.Context) {
	if !contractEmailConfigured() {
		return
	}
	rows, err := a.db.QueryContext(ctx, "SELECT registration_id,purpose FROM channel_contract_mail_deliveries "+
		"WHERE status IN ('pending','failed','sending') AND attempts<8 "+
		"AND (last_attempt_at IS NULL OR julianday(last_attempt_at)<=julianday('now','-15 minutes')) "+
		"ORDER BY registration_id,purpose LIMIT 10")
	if err != nil {
		log.Printf("contract_mail_queue_read_failed code=%s", contractMailFailure(err))
		return
	}
	type queued struct {
		id      int64
		purpose string
	}
	var items []queued
	for rows.Next() {
		var item queued
		if rows.Scan(&item.id, &item.purpose) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		_ = a.deliverSignedContractEmail(ctx, item.id, item.purpose)
	}
}
