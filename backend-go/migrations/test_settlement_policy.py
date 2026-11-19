import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest


source = Path(__file__).with_name("2026-11-19-settlement-85-90.py")
spec = importlib.util.spec_from_file_location("settlement_policy", source)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class SettlementPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "adx.sqlite")
        db = sqlite3.connect(self.path)
        db.executescript("""
            CREATE TABLE soap_accounts(id INTEGER,network_code TEXT);
            CREATE TABLE upstream_accounts(id INTEGER,account_key TEXT,status TEXT,soap_account_id INTEGER,share_percent REAL,updated_at TEXT);
            CREATE TABLE channels(id INTEGER,name TEXT,share_percent REAL,updated_at TEXT);
            CREATE TABLE upstream_share_versions(upstream_account_id INTEGER,share_percent REAL);
            CREATE TABLE channel_share_versions(channel_id INTEGER,share_percent REAL);
            CREATE TABLE channel_share_rules(channel_id INTEGER,share_percent REAL);
            CREATE TABLE channel_domain_share_rules(channel_id INTEGER,upstream_account_id INTEGER,share_percent REAL);
            CREATE TABLE revenue_facts(account TEXT,channel_id INTEGER);
            CREATE TABLE dashboard_daily(revenue REAL,settled_revenue REAL);
            CREATE TABLE dashboard_rest_daily(revenue REAL,settled_revenue REAL);
            CREATE TABLE audit_logs(actor_email TEXT,action TEXT,target_type TEXT,target_id TEXT,detail TEXT,ip TEXT);
            INSERT INTO soap_accounts VALUES(1,'23375144983'),(2,'23380056141');
            INSERT INTO upstream_accounts VALUES(1,'acct-a','active',1,100,''),(2,'acct-b','active',2,85,'');
            INSERT INTO channels VALUES(1,'赵飞',70,''),(2,'Rinser',70,'');
            INSERT INTO upstream_share_versions VALUES(1,100),(2,85);
            INSERT INTO channel_share_versions VALUES(1,70),(2,70);
            INSERT INTO channel_domain_share_rules VALUES(1,1,70);
            INSERT INTO revenue_facts VALUES('acct-a',1),('acct-b',2);
            INSERT INTO dashboard_daily VALUES(100,70);
            INSERT INTO dashboard_rest_daily VALUES(100,70);
        """)
        db.close()

    def test_restates_both_accounts_and_daily_totals(self):
        migration.apply(self.path)
        db = sqlite3.connect(self.path)
        self.addCleanup(db.close)
        self.assertEqual(db.execute("SELECT DISTINCT share_percent FROM upstream_accounts").fetchall(), [(85.0,)])
        self.assertEqual(db.execute("SELECT DISTINCT share_percent FROM upstream_share_versions").fetchall(), [(85.0,)])
        self.assertEqual(db.execute("SELECT DISTINCT share_percent FROM channels").fetchall(), [(90.0,)])
        self.assertEqual(db.execute("SELECT DISTINCT share_percent FROM channel_share_versions").fetchall(), [(90.0,)])
        self.assertEqual(db.execute("SELECT DISTINCT share_percent FROM channel_domain_share_rules").fetchall(), [(90.0,)])
        for table in ("dashboard_daily", "dashboard_rest_daily"):
            revenue, upstream, channel = db.execute(
                "SELECT revenue,upstream_revenue,settled_revenue FROM " + table
            ).fetchone()
            self.assertEqual((revenue, upstream, channel), (100, 85, 76.5))
        self.assertEqual(db.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], 1)

    def test_unmapped_account_rolls_back(self):
        db = sqlite3.connect(self.path)
        db.execute("INSERT INTO revenue_facts VALUES('unknown',1)")
        db.commit()
        db.close()
        with self.assertRaisesRegex(RuntimeError, "unmapped revenue account"):
            migration.apply(self.path)
        db = sqlite3.connect(self.path)
        self.addCleanup(db.close)
        self.assertEqual(db.execute("SELECT share_percent FROM upstream_accounts WHERE id=1").fetchone()[0], 100)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], 0)

    def test_duplicate_account_network_rolls_back(self):
        db = sqlite3.connect(self.path)
        db.execute("UPDATE upstream_accounts SET soap_account_id=1 WHERE id=2")
        db.commit()
        db.close()
        with self.assertRaisesRegex(RuntimeError, "one active upstream account per GAM network"):
            migration.apply(self.path)
        db = sqlite3.connect(self.path)
        self.addCleanup(db.close)
        self.assertEqual(db.execute("SELECT share_percent FROM upstream_accounts WHERE id=1").fetchone()[0], 100)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
