package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRuntimeRoleInputValidation(t *testing.T) {
	for _, input := range []struct{ role, password string }{
		{"postgres", "01234567890123456789012345678901"},
		{"trafficbet_runtime; DROP ROLE postgres", "01234567890123456789012345678901"},
		{"trafficbet_runtime", "short"},
	} {
		if ConfigureRuntimeRole(context.Background(), nil, input.role, input.password) == nil {
			t.Fatal("invalid role configuration accepted")
		}
	}
}

func TestProductionRequiresSeparateMigrationStep(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	for _, raw := range []string{"", "true", "not-a-boolean"} {
		t.Setenv("RUN_DATABASE_MIGRATIONS", raw)
		if PrepareDatabase(context.Background(), nil) == nil {
			t.Fatal("production accepted startup migrations or malformed mode")
		}
	}
}

// Use a fresh database and role, never the public schema of the shared fixture
// database. This exercises PostgreSQL's real permission errors, not mocked SQL.
func TestPostgresRuntimeDatabasePrivileges(t *testing.T) {
	raw := os.Getenv("TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal("cannot connect to isolated test database")
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	var random [8]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random[:])
	database := "trafficbet_runtime_test_" + suffix
	role := "trafficbet_runtime_" + suffix
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{database}.Sanitize()+" TEMPLATE template0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		if _, e := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{database}.Sanitize()+" WITH (FORCE)"); e != nil {
			t.Error("cannot remove isolated role test database")
		}
		if _, e := admin.Exec(cleanup, "DROP ROLE IF EXISTS "+pgx.Identifier{role}.Sanitize()); e != nil {
			t.Error("cannot remove isolated test role")
		}
	})
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = database
	owner, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if err = RunMigrations(ctx, owner); err != nil {
		t.Fatal(err)
	}
	password := "separate-test-secret-" + suffix
	if err = ConfigureRuntimeRole(ctx, owner, role, password); err != nil {
		t.Fatal(err)
	}
	if err = ConfigureRuntimeRole(ctx, owner, role, password); err != nil {
		t.Fatal("repeat migration grant configuration failed")
	}
	if ValidateRuntimeDatabase(ctx, owner) == nil {
		t.Fatal("elevated owner passed runtime validation")
	}
	runtimeCfg := cfg.Copy()
	runtimeCfg.ConnConfig.User = role
	runtimeCfg.ConnConfig.Password = password
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if err = ValidateRuntimeDatabase(ctx, runtime); err != nil {
		t.Fatal(err)
	}
	var canRead, canInsert, canUpdate, canDelete bool
	if err = runtime.QueryRow(ctx, `SELECT has_table_privilege(current_user,'public.video_evidence_retirements','SELECT'),has_table_privilege(current_user,'public.video_evidence_retirements','INSERT'),has_table_privilege(current_user,'public.video_evidence_retirements','UPDATE'),has_table_privilege(current_user,'public.video_evidence_retirements','DELETE')`).Scan(&canRead, &canInsert, &canUpdate, &canDelete); err != nil || !canRead || canInsert || canUpdate || canDelete {
		t.Fatal("runtime retirement access must be SELECT only", err)
	}
	for _, statement := range []string{
		`CREATE TABLE public.forbidden_runtime_table(id integer)`,
		`CREATE TEMP TABLE forbidden_runtime_temp(id integer)`,
		`ALTER TABLE public.users ADD COLUMN forbidden_runtime_column integer`,
		`DELETE FROM public.schema_migrations`,
		`UPDATE public.credit_ledger SET delta_credits=delta_credits`,
		`TRUNCATE public.audit_events`,
		`DELETE FROM public.counting_references`,
		`SET ROLE trafficbet`,
	} {
		if _, err = runtime.Exec(ctx, statement); err == nil {
			t.Fatalf("restricted role accepted %s", statement)
		}
	}
	if err = RunMigrations(ctx, runtime); err == nil {
		t.Fatal("runtime could execute migration setup")
	}
	store := NewStore(runtime)
	if err = store.CreateUserIfMissing(ctx, "runtime@example.com", "test-hash", "Runtime check", "user", 10000); err != nil {
		t.Fatal("runtime cannot atomically create account and opening ledger", err)
	}
	var mismatches int
	if err = runtime.QueryRow(ctx, `SELECT count(*) FROM users u WHERE u.balance_credits<>(SELECT COALESCE(sum(delta_credits),0) FROM credit_ledger WHERE user_id=u.id)`).Scan(&mismatches); err != nil || mismatches != 0 {
		t.Fatal("runtime account ledger does not reconcile")
	}
}
