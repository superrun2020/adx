//go:build !sqlite_native

package main

import (
	_ "modernc.org/sqlite"
	"path/filepath"
)

const sqliteDriver = "sqlite"

func sqliteDSN(path string) string {
	return "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(30000)&_pragma=foreign_keys(1)"
}
