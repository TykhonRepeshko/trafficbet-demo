package app

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Recheck credentials under the same user lock as session publication.
func (s *Store) authenticatedSession(ctx context.Context, user User, checkedHash string, hash []byte, expires time.Time, previous string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current string
	if err = tx.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1 FOR UPDATE`, user.ID).Scan(&current); err != nil {
		return err
	}
	if current != checkedHash {
		return errUnauthorized
	}
	ctx = context.WithValue(ctx, userContextKey, user)
	if err = createSessionTx(ctx, tx, user.ID, hash, expires, previous); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (api *API) handleAccountSecurity(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" || r.URL.RawPath != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	user, _ := currentUser(r.Context())
	path := strings.TrimPrefix(r.URL.Path, "/api/me/security")
	if path == "" && r.Method == http.MethodGet {
		rows, err := api.store.pool.Query(r.Context(), `SELECT id,created_at,expires_at,token_hash=$2 FROM auth_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY id DESC LIMIT 100`, user.ID, sessionHash(sessionToken(r)))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		defer rows.Close()
		sessions := []map[string]any{}
		for rows.Next() {
			var id int64
			var created, expires time.Time
			var current bool
			if err = rows.Scan(&id, &created, &expires, &current); err != nil {
				writeStoreError(w, err)
				return
			}
			sessions = append(sessions, map[string]any{"id": id, "createdAt": created, "expiresAt": expires, "current": current})
		}
		if err = rows.Err(); err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"sessions": sessions})
		return
	}
	if path != "/revoke" && path != "/password" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input struct {
		Password    string `json:"password"`
		NewPassword string `json:"newPassword"`
		SessionID   int64  `json:"sessionId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Password) > 72 || path == "/password" && !ValidPassword(input.NewPassword) || path == "/revoke" && input.SessionID < 1 {
		writeStoreError(w, ErrInvalid)
		return
	}
	if !api.logins.allowLimited(r.RemoteAddr, "security:"+strconv.FormatInt(user.ID, 10), time.Now(), 60, 8) {
		writeError(w, 429, "security_rate_limited", "Too many security attempts. Try again in 15 minutes.")
		return
	}
	tx, err := api.store.pool.Begin(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	ctx := r.Context()
	var stored string
	if err = tx.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1 FOR UPDATE`, user.ID).Scan(&stored); err != nil {
		writeStoreError(w, err)
		return
	}
	if !CheckPassword(stored, input.Password) {
		writeError(w, 400, "security_credentials", "The current password is incorrect.")
		return
	}
	if path == "/password" {
		newHash, e := HashPassword(input.NewPassword)
		if e != nil {
			writeStoreError(w, e)
			return
		}
		if _, err = tx.Exec(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1`, user.ID, newHash); err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2`, user.ID, sessionHash(sessionToken(r)))
		}
	}
	if path == "/revoke" {
		_, err = tx.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1 AND id=$2 AND token_hash<>$3`, user.ID, input.SessionID, sessionHash(sessionToken(r)))
	}
	if err == nil {
		err = auditTx(ctx, tx, "account.security"+strings.ReplaceAll(path, "/", "."), "user", user.ID, map[string]any{"sessionId": input.SessionID})
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
