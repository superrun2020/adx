package main

import (
	"path/filepath"
	"testing"
)

func TestLegacyAdminMigrationPrefersNamedActiveOwner(t *testing.T) {
	t.Setenv("ADX_DB_PATH", filepath.Join(t.TempDir(), "adx.sqlite"))
	t.Setenv("ADX_ADMIN_EMAIL", "older@example.test")
	t.Setenv("ADX_ADMIN_PASSWORD", "AdminPass123!")
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	defer a.reportCache.close()
	hash, err := passwordHash("AdminPass123!")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("UPDATE users SET is_super_admin=0 WHERE email='older@example.test'"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec("INSERT INTO users(email,name,password_hash,role,status,is_super_admin) VALUES('disabled@example.test','Disabled',?,'admin','disabled',1),('eddyappcone.kr@gmail.com','Eddy',?,'admin','active',0)", hash, hash); err != nil {
		t.Fatal(err)
	}
	if err = a.ensureSchema(); err != nil {
		t.Fatal(err)
	}
	if !a.exists("SELECT 1 FROM users WHERE email='eddyappcone.kr@gmail.com' AND is_super_admin=1") ||
		a.exists("SELECT 1 FROM users WHERE email='older@example.test' AND is_super_admin=1") {
		t.Fatal("migration did not grant the named active owner highest access")
	}
}
