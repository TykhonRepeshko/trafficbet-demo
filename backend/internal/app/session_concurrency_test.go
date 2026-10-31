package app

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestPostgresLoginAndLogoutUseConsistentLockOrder(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "session-lock-order@example.org", RoleUser, 1000)
	oldToken, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, user.ID, sessionHash(oldToken), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	newToken, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	operationCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	gate, err := s.pool.Acquire(operationCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	gateKey := time.Now().UnixNano()
	var gatePID int32
	if err := gate.QueryRow(operationCtx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.Exec(operationCtx, `SELECT pg_advisory_lock($1)`, gateKey); err != nil {
		t.Fatal(err)
	}
	defer gate.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, gateKey)
	// Stop logout after deleting its session but before the audit's user FK
	// check. This reliably reproduces the old session-before-user deadlock.
	if _, err := s.pool.Exec(operationCtx, fmt.Sprintf(`
		CREATE FUNCTION hold_logout_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.action='session.revoked' THEN PERFORM pg_advisory_xact_lock(%d); END IF;
			RETURN NEW;
		END;
		$$;
		CREATE TRIGGER hold_logout_audit BEFORE INSERT ON audit_events
		FOR EACH ROW EXECUTE FUNCTION hold_logout_audit();`, gateKey)); err != nil {
		t.Fatal(err)
	}
	logoutResult := make(chan error, 1)
	go func() { logoutResult <- s.RevokeSession(operationCtx, sessionHash(oldToken)) }()
	logoutPID := waitForBlockedSourceOperation(t, s, operationCtx, gatePID)
	loginResult := make(chan error, 1)
	go func() {
		loginResult <- s.CreateSession(operationCtx, user.ID, sessionHash(newToken), time.Now().Add(time.Hour), oldToken)
	}()
	waitForBlockedSourceOperation(t, s, operationCtx, logoutPID)
	if _, err := gate.Exec(operationCtx, `SELECT pg_advisory_unlock($1)`, gateKey); err != nil {
		t.Fatal(err)
	}
	if err := <-logoutResult; err != nil {
		t.Fatal("logout deadlocked with session rotation", err)
	}
	if err := <-loginResult; err != nil {
		t.Fatal("session rotation deadlocked with logout", err)
	}
	if _, err := s.GetSessionUser(ctx, sessionHash(oldToken)); !errors.Is(err, ErrNotFound) {
		t.Fatal("old session remains valid", err)
	}
	if current, err := s.GetSessionUser(ctx, sessionHash(newToken)); err != nil || current.ID != user.ID {
		t.Fatal("logout revoked the newly rotated session", current, err)
	}
}
