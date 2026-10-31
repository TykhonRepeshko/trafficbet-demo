// db-tool makes a consistent PostgreSQL archive and verifies restoration into a
// new database. URLs are read only from the environment, never command arguments.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type tableProof struct {
	Rows   int64  `json:"rows"`
	Digest string `json:"digest"`
}
type manifest struct {
	Version          int                   `json:"version"`
	CreatedAt        time.Time             `json:"createdAt"`
	SHA256           string                `json:"sha256"`
	Tables           map[string]tableProof `json:"tables"`
	LedgerMismatches int64                 `json:"ledgerMismatches"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Database operation failed:", err)
		os.Exit(1)
	}
}
func connect(ctx context.Context, raw string) (*pgx.Conn, error) {
	if raw == "" {
		return nil, errors.New("required database URL is missing from environment")
	}
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	cfg.ConnectTimeout = 5 * time.Second
	c, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("cannot connect to selected database")
	}
	return c, nil
}
func tool(ctx context.Context, name, raw string, args ...string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return errors.New("invalid PostgreSQL tool configuration")
	}
	bin := os.Getenv("PG_BIN")
	exe := name
	if bin != "" {
		exe = filepath.Join(bin, name)
		if os.PathSeparator == '\\' {
			exe += ".exe"
		}
	}
	command := exec.CommandContext(ctx, exe, args...)
	// libpq receives authentication through its environment, not a command line.
	env := []string{}
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if !strings.HasPrefix(key, "PG") && key != "DATABASE_URL" && key != "RESTORE_DATABASE_URL" {
			env = append(env, entry)
		}
	}
	sslmode := "prefer"
	if u, e := url.Parse(raw); e == nil && u.Query().Get("sslmode") != "" {
		sslmode = u.Query().Get("sslmode")
	}
	command.Env = append(env, "PGHOST="+cfg.Host, fmt.Sprintf("PGPORT=%d", cfg.Port), "PGUSER="+cfg.User, "PGPASSWORD="+cfg.Password, "PGDATABASE="+cfg.Database, "PGSSLMODE="+sslmode, "PGCONNECT_TIMEOUT=5")
	// Errors from database tools may contain private object names. Keep them in
	// the caller's restricted PostgreSQL logs; do not echo arbitrary stderr.
	if err = command.Run(); err != nil {
		return fmt.Errorf("%s failed; no source data was changed", name)
	}
	return nil
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func proof(ctx context.Context, q querier) (manifest, error) {
	m := manifest{Version: 2, CreatedAt: time.Now().UTC(), Tables: map[string]tableProof{}}
	rows, err := q.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
	if err != nil {
		return m, err
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return m, err
		}
		names = append(names, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return m, err
	}
	for _, name := range names {
		var p tableProof
		query := `SELECT count(*),md5(COALESCE(string_agg(digest,'' ORDER BY digest),'')) FROM (SELECT md5(to_jsonb(t)::text) digest FROM ` + pgx.Identifier{"public", name}.Sanitize() + ` t) fingerprints`
		if err = q.QueryRow(ctx, query).Scan(&p.Rows, &p.Digest); err != nil {
			return m, err
		}
		m.Tables[name] = p
	}
	if _, ok := m.Tables["users"]; !ok {
		return m, errors.New("selected database is not a migrated TrafficBet database")
	}
	err = q.QueryRow(ctx, `SELECT (SELECT count(*) FROM users u WHERE u.balance_credits<>COALESCE((SELECT sum(delta_credits) FROM credit_ledger WHERE user_id=u.id),0)) + (SELECT count(*) FROM (SELECT balance_after,sum(delta_credits) OVER(PARTITION BY user_id ORDER BY id) running FROM credit_ledger) l WHERE balance_after<>running)`).Scan(&m.LedgerMismatches)
	return m, err
}
func checksum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func run() error {
	if len(os.Args) != 3 || (os.Args[1] != "backup" && os.Args[1] != "restore-check") {
		return errors.New("usage: db-tool backup|restore-check <new archive path>; use DATABASE_URL or RESTORE_DATABASE_URL environment")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	path, err := filepath.Abs(os.Args[2])
	if err != nil {
		return err
	}
	if os.Args[1] == "backup" {
		if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			return errors.New("archive target already exists or is inaccessible")
		}
		if _, err = os.Stat(path + ".json"); !errors.Is(err, os.ErrNotExist) {
			return errors.New("manifest target already exists or is inaccessible")
		}
		c, err := connect(ctx, os.Getenv("DATABASE_URL"))
		if err != nil {
			return err
		}
		defer c.Close(ctx)
		tx, err := c.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
			return err
		}
		var snapshot string
		if err = tx.QueryRow(ctx, `SELECT pg_export_snapshot()`).Scan(&snapshot); err != nil {
			return err
		}
		m, err := proof(ctx, tx)
		if err != nil {
			return errors.New("could not collect archive integrity proof")
		}
		if m.LedgerMismatches != 0 {
			return errors.New("source ledger does not reconcile; archive approval refused")
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = tool(ctx, "pg_dump", os.Getenv("DATABASE_URL"), "--format=custom", "--no-owner", "--no-acl", "--snapshot="+snapshot, "--file="+path); err != nil {
			return err
		}
		if err = os.Chmod(path, 0600); err != nil {
			return err
		}
		m.SHA256, err = checksum(path)
		if err != nil {
			return err
		}
		data, err := json.MarshalIndent(m, "", "  ")
		if err != nil {
			return err
		}
		f, err := os.OpenFile(path+".json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		fmt.Printf("Consistent archive created; %d tables; ledger mismatches: 0. Contains private account data: keep archive and manifest restricted.\n", len(m.Tables))
		return nil
	}
	body, err := os.ReadFile(path + ".json")
	if err != nil {
		return errors.New("archive manifest is missing")
	}
	var expected manifest
	if json.Unmarshal(body, &expected) != nil || (expected.Version != 1 && expected.Version != 2) || len(expected.Tables) == 0 || expected.LedgerMismatches != 0 {
		return errors.New("invalid archive manifest")
	}
	actualHash, err := checksum(path)
	if err != nil || actualHash != expected.SHA256 {
		return errors.New("archive integrity mismatch")
	}
	raw := os.Getenv("RESTORE_DATABASE_URL")
	cfg, err := pgx.ParseConfig(raw)
	if err != nil || !regexp.MustCompile(`^trafficbet_(restore|migration)_[a-z0-9_]{1,40}$`).MatchString(cfg.Database) {
		return errors.New("restore target must be a NEW database named trafficbet_restore_<suffix> or trafficbet_migration_<suffix>")
	}
	// Never permit a restore to an existing database, including the live one.
	adminCfg := cfg.Copy()
	adminCfg.Database = "postgres"
	admin, err := pgx.ConnectConfig(ctx, adminCfg)
	if err != nil {
		return errors.New("cannot connect to restore maintenance database")
	}
	defer admin.Close(ctx)
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, cfg.Database).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return errors.New("restore target already exists; no data overwritten")
	}
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{cfg.Database}.Sanitize()+" TEMPLATE template0"); err != nil {
		return errors.New("cannot create fresh restore database")
	}
	if err = tool(ctx, "pg_restore", raw, "--dbname="+cfg.Database, "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", path); err != nil {
		return err
	}
	c, err := connect(ctx, raw)
	if err != nil {
		return err
	}
	defer c.Close(ctx)
	tx, err := c.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if expected.Version == 2 {
		if _, err = tx.Exec(ctx, `SET LOCAL TIME ZONE 'UTC'`); err != nil {
			return err
		}
	}
	got, err := proof(ctx, tx)
	if err != nil {
		return errors.New("restored integrity proof failed")
	}
	if got.LedgerMismatches != 0 || len(got.Tables) != len(expected.Tables) {
		return errors.New("restored relationships or ledger mismatch")
	}
	for name, p := range expected.Tables {
		if got.Tables[name] != p {
			return fmt.Errorf("restored table differs: %s", name)
		}
	}
	fmt.Printf("Restore verified in fresh database %s: %d tables match the snapshot; ledger mismatches: 0. Source database unchanged.\n", cfg.Database, len(got.Tables))
	return nil
}
