//go:build sqlite_native

package main

import (
	_ "github.com/mattn/go-sqlite3"
	"path/filepath"
)

const sqliteDriver = "sqlite3"

func sqliteDSN(path string) string {
	return "file:" + filepath.ToSlash(path) + "?_busy_timeout=30000&_foreign_keys=on"
}
