package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func auditTx(ctx context.Context, tx pgx.Tx, action, resourceType string, resourceID int64, details map[string]any) error {
	var actor any
	if user, ok := currentUser(ctx); ok {
		actor = user.ID
	}
	if details == nil {
		details = map[string]any{}
	}
	encoded, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)`, actor, action, resourceType, resourceID, string(encoded))
	return err
}

func (s *Store) CreateSession(ctx context.Context, userID int64, hash []byte, expires time.Time, previousToken string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize session rotation and cap concurrent sessions for one account.
	var id int64
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&id); err != nil {
		return err
	}
	if err := createSessionTx(ctx, tx, userID, hash, expires, previousToken); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func createSessionTx(ctx context.Context, tx pgx.Tx, userID int64, hash []byte, expires time.Time, previousToken string) error {
	if previousToken != "" {
		if _, err := tx.Exec(ctx, `DELETE FROM auth_sessions WHERE token_hash=$1`, sessionHash(previousToken)); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_sessions WHERE expires_at<=now()`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash IN (SELECT token_hash FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC OFFSET 4)`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, hash, userID, expires); err != nil {
		return err
	}
	auditCtx := context.WithValue(ctx, userContextKey, User{ID: userID})
	if err := auditTx(auditCtx, tx, "session.created", "user", userID, nil); err != nil {
		return err
	}
	return nil
}
func (s *Store) GetSessionUser(ctx context.Context, hash []byte) (User, error) {
	var user User
	err := s.pool.QueryRow(ctx, `SELECT u.id,u.email,u.display_name,u.role,u.balance_credits,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, hash).Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return user, err
}
func (s *Store) RevokeSession(ctx context.Context, hash []byte) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	err = tx.QueryRow(ctx, `SELECT user_id FROM auth_sessions WHERE token_hash=$1`, hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	// Match login's user-before-session lock order. Deleting a session first
	// could deadlock with login: logout's audit needs a user FK lock while
	// login holds that user and waits to rotate the deleted session.
	if _, err := tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, id); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM auth_sessions WHERE token_hash=$1 AND user_id=$2`, hash, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return tx.Commit(ctx) // Login or another logout already revoked it.
	}
	auditCtx := context.WithValue(ctx, userContextKey, User{ID: id})
	if err := auditTx(auditCtx, tx, "session.revoked", "user", id, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
