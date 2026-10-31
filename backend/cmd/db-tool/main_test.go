package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestoreRejectsTamperingBeforeConnecting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.dump")
	if err := os.WriteFile(path, []byte("damaged archive"), 0600); err != nil {
		t.Fatal(err)
	}
	m := manifest{Version: 1, SHA256: strings.Repeat("0", 64), Tables: map[string]tableProof{"users": {Rows: 1, Digest: "fixture"}}}
	body, _ := json.Marshal(m)
	if err := os.WriteFile(path+".json", body, 0600); err != nil {
		t.Fatal(err)
	}
	args := os.Args
	defer func() { os.Args = args }()
	os.Args = []string{"db-tool", "restore-check", path}
	t.Setenv("RESTORE_DATABASE_URL", "")
	if err := run(); err == nil || !strings.Contains(err.Error(), "integrity mismatch") {
		t.Fatal("tampered archive reached database", err)
	}
}
func TestBackupRefusesOverwriteBeforeConnecting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.dump")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	args := os.Args
	defer func() { os.Args = args }()
	os.Args = []string{"db-tool", "backup", path}
	t.Setenv("DATABASE_URL", "")
	if err := run(); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatal("existing backup was not protected", err)
	}
}
