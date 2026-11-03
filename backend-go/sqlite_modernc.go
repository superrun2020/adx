//go:build !sqlite_native

package main

import (
	_ "modernc.org/sqlite"
	"path/filepath"
)

const sqliteDriver = "sqlite"

func sqliteDSN(path string) string {
	return "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
}
