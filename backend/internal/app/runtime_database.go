package app

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PrepareDatabase keeps native development compatible while Docker explicitly
// selects the separately migrated, restricted runtime connection.
func PrepareDatabase(ctx context.Context, pool *pgxpool.Pool) error {
	run := true
	if raw := os.Getenv("RUN_DATABASE_MIGRATIONS"); raw != "" {
		var err error
		run, err = strconv.ParseBool(raw)
		if err != nil {
			return errors.New("RUN_DATABASE_MIGRATIONS must be a boolean")
		}
	}
	if run {
		if os.Getenv("APP_ENV") == "production" {
			return errors.New("production requires RUN_DATABASE_MIGRATIONS=false and the separate migration command")
		}
		return RunMigrations(ctx, pool)
	}
	return ValidateRuntimeDatabase(ctx, pool)
}

// ValidateRuntimeDatabase fails closed if a supposedly restricted runtime can
// change its own privileges, own application objects, or modify migration state.
func ValidateRuntimeDatabase(ctx context.Context, pool *pgxpool.Pool) error {
	var unsafe bool
	err := pool.QueryRow(ctx, `SELECT
	 EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND
	 (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
	 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))
	 OR EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user))
	 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
	 OR has_schema_privilege(current_user,'public','CREATE')
	 OR has_database_privilege(current_user,current_database(),'CREATE')
	 OR has_database_privilege(current_user,current_database(),'TEMP')
	 OR has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')`).Scan(&unsafe)
	if err != nil || unsafe {
		return errors.New("runtime database role is not restricted or schema is unavailable")
	}
	rows, err := pool.Query(ctx, `SELECT version FROM public.schema_migrations`)
	if err != nil {
		return errors.New("runtime migration state is unavailable")
	}
	got := map[string]bool{}
	for rows.Next() {
		var version string
		if err = rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		got[version] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return err
	}
	expected := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			expected++
			if !got[entry.Name()] {
				return errors.New("database migrations must be applied by the migration service first")
			}
		}
	}
	if len(got) != expected {
		return errors.New("database schema version does not match this runtime")
	}
	return nil
}

// ConfigureRuntimeRole is called only by the privileged, short-lived migration
// command. Password values use server-side quoting and are never interpolated
// into SQL by this program. Runtime never receives migration credentials.
func ConfigureRuntimeRole(ctx context.Context, pool *pgxpool.Pool, role, password string) error {
	if !regexp.MustCompile(`^trafficbet_runtime(?:_[a-z0-9_]{1,24})?$`).MatchString(role) || len(password) < 32 || len(password) > 128 {
		return errors.New("runtime role requires its own name and a 32–128 character secret")
	}
	if pool.Config().ConnConfig.Password != "" && password == pool.Config().ConnConfig.Password {
		return errors.New("runtime and migration passwords must differ")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(749882490)`); err != nil {
		return err
	}
	var exists, unsafe bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1), EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=$1 AND
	 (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)))`, role).Scan(&exists, &unsafe); err != nil {
		return err
	}
	if unsafe {
		return errors.New("existing runtime role is elevated; migration refused to repurpose it")
	}
	identifier := pgx.Identifier{role}.Sanitize()
	if !exists {
		if _, err = tx.Exec(ctx, `CREATE ROLE `+identifier+` LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('trafficbet.runtime_role',$1,true),set_config('trafficbet.runtime_password',$2,true)`, role, password); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DO $$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L',current_setting('trafficbet.runtime_role'),current_setting('trafficbet.runtime_password')); END $$`); err != nil {
		return err
	}
	var db string
	if err = tx.QueryRow(ctx, `SELECT current_database()`).Scan(&db); err != nil {
		return err
	}
	for _, query := range []string{
		`REVOKE CREATE,TEMPORARY ON DATABASE ` + pgx.Identifier{db}.Sanitize() + ` FROM PUBLIC`,
		`REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
		`REVOKE ALL ON SCHEMA public FROM ` + identifier,
		`GRANT USAGE ON SCHEMA public TO ` + identifier,
		`REVOKE ALL ON DATABASE ` + pgx.Identifier{db}.Sanitize() + ` FROM ` + identifier,
		`GRANT CONNECT ON DATABASE ` + pgx.Identifier{db}.Sanitize() + ` TO ` + identifier,
		`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ` + identifier,
		`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ` + identifier,
		`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ` + identifier,
		`REVOKE INSERT,UPDATE,DELETE ON TABLE public.video_evidence_retirements FROM ` + identifier,
		`GRANT DELETE ON TABLE public.auth_sessions,public.source_observations TO ` + identifier,
		`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ` + identifier,
		`REVOKE ALL ON TABLE public.schema_migrations FROM ` + identifier,
		`GRANT SELECT ON TABLE public.schema_migrations TO ` + identifier,
	} {
		if _, err = tx.Exec(ctx, query); err != nil {
			return err
		}
	}
	// Discover immutable application tables from their enforcement functions,
	// including newly applied migrations, rather than maintaining a stale list.
	rows, err := tx.Query(ctx, `SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND NOT t.tgisinternal AND p.proname IN ('immutable_counting_record','reject_history_mutation')`)
	if err != nil {
		return err
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		names = append(names, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if _, err = tx.Exec(ctx, `REVOKE UPDATE,DELETE ON TABLE `+pgx.Identifier{"public", name}.Sanitize()+` FROM `+identifier); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
