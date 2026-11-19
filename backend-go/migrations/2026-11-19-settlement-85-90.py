"""Restate the two existing GAM networks to 85% upstream / 90% channel.

Run once against this site's SQLite database while its service is stopped and
only after taking a SQLite backup. The 90% channel share is of the 85% upstream
settlement, so $100 raw becomes $85 upstream, $8.50 platform, $76.50 channel.
"""

import json
import sqlite3
import sys

NETWORKS = {"23375144983", "23380056141"}
CHANNELS = {"赵飞", "Rinser"}


def apply(path):
    db = sqlite3.connect(path, timeout=60)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE")
        networks = db.execute(
            "SELECT id,network_code FROM soap_accounts WHERE network_code IN (?,?) ORDER BY network_code",
            tuple(sorted(NETWORKS)),
        ).fetchall()
        if {code for _, code in networks} != NETWORKS or len(networks) != 2:
            raise RuntimeError("expected exactly the two authorized GAM networks")
        accounts = db.execute(
            "SELECT u.id,u.account_key,u.soap_account_id FROM upstream_accounts u "
            "WHERE u.status='active' AND u.soap_account_id IN (?,?) ORDER BY u.id",
            tuple(row[0] for row in networks),
        ).fetchall()
        if len(accounts) != 2 or {row[2] for row in accounts} != {row[0] for row in networks}:
            raise RuntimeError("expected one active upstream account per GAM network")
        channels = db.execute(
            "SELECT id,name FROM channels WHERE name IN (?,?) ORDER BY name",
            tuple(sorted(CHANNELS)),
        ).fetchall()
        if {name for _, name in channels} != CHANNELS or len(channels) != 2:
            raise RuntimeError("expected exactly the two authorized channels")
        known_accounts = {key.lower() for _, key, _ in accounts}
        known_channels = {row[0] for row in channels}
        if any(row[0].lower() not in known_accounts for row in db.execute("SELECT DISTINCT account FROM revenue_facts")):
            raise RuntimeError("unmapped revenue account: no safe uniform backfill")
        if any(row[0] not in known_channels for row in db.execute("SELECT DISTINCT channel_id FROM revenue_facts")):
            raise RuntimeError("unmapped revenue channel: no safe uniform backfill")

        account_ids = tuple(row[0] for row in accounts)
        channel_ids = tuple(row[0] for row in channels)
        old = {
            "upstream": db.execute("SELECT id,share_percent FROM upstream_accounts WHERE id IN (?,?)", account_ids).fetchall(),
            "channels": db.execute("SELECT id,share_percent FROM channels WHERE id IN (?,?)", channel_ids).fetchall(),
        }
        db.execute("UPDATE upstream_accounts SET share_percent=85,updated_at=CURRENT_TIMESTAMP WHERE id IN (?,?)", account_ids)
        db.execute("UPDATE upstream_share_versions SET share_percent=85 WHERE upstream_account_id IN (?,?)", account_ids)
        db.execute("UPDATE channels SET share_percent=90,updated_at=CURRENT_TIMESTAMP WHERE id IN (?,?)", channel_ids)
        db.execute("UPDATE channel_share_versions SET share_percent=90 WHERE channel_id IN (?,?)", channel_ids)
        db.execute("UPDATE channel_share_rules SET share_percent=90 WHERE channel_id IN (?,?)", channel_ids)
        db.execute("UPDATE channel_domain_share_rules SET share_percent=90 "
                   "WHERE channel_id IN (?,?) AND upstream_account_id IN (?,?)", channel_ids + account_ids)

        for table in ("dashboard_daily", "dashboard_rest_daily"):
            columns = {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}
            if "upstream_revenue" not in columns:
                db.execute("ALTER TABLE " + table + " ADD COLUMN upstream_revenue REAL NOT NULL DEFAULT 0")
            db.execute("UPDATE " + table + " SET upstream_revenue=revenue*0.85,settled_revenue=revenue*0.765")
            revenue, upstream, channel = db.execute(
                "SELECT COALESCE(SUM(revenue),0),COALESCE(SUM(upstream_revenue),0),"
                "COALESCE(SUM(settled_revenue),0) FROM " + table
            ).fetchone()
            if abs(upstream - revenue * 0.85) > 0.01 or abs(channel - revenue * 0.765) > 0.01:
                raise RuntimeError(table + " settlement totals failed")

        db.execute(
            "INSERT INTO audit_logs(actor_email,action,target_type,target_id,detail,ip) "
            "VALUES('deployment','settlement_policy.restate','gam_accounts','',?,'localhost')",
            (json.dumps({"networks": sorted(NETWORKS), "upstreamPercent": 85,
                         "channelPercentOfUpstream": 90, "previous": old}, ensure_ascii=False),),
        )
        db.commit()
        print("SETTLEMENT_MIGRATED networks=2 channels=2 upstream=85 channel_of_upstream=90", flush=True)
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: settlement-migration.py PATH_TO_ADX_SQLITE")
    apply(sys.argv[1])
