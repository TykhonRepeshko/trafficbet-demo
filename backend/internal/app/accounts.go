package app

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
)

const openingVirtualCredits int64 = 10000

var errAccountUnavailable = errors.New("account could not be created with these details")

type registrationInput struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

func normalizeRegistration(input registrationInput) (registrationInput, bool) {
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if len(input.Email) == 0 || len(input.Email) > 254 || !utf8.ValidString(input.Email) {
		return registrationInput{}, false
	}
	address, err := mail.ParseAddress(input.Email)
	if err != nil || address.Name != "" || address.Address != input.Email {
		return registrationInput{}, false
	}
	nameLength := utf8.RuneCountInString(input.DisplayName)
	if !utf8.ValidString(input.DisplayName) || nameLength < 2 || nameLength > 80 || strings.IndexFunc(input.DisplayName, unicode.IsControl) >= 0 {
		return registrationInput{}, false
	}
	if !ValidPassword(input.Password) {
		return registrationInput{}, false
	}
	return input, true
}

// RegisterAccount commits the account, its initial virtual balance, audit trail
// and session together. Public registration never accepts a role or balance.
func (s *Store) RegisterAccount(ctx context.Context, email, passwordHash, displayName string, hash []byte, expires time.Time, previousToken string) (User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)
	var user User
	err = tx.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,role,balance_credits)
		VALUES ($1,$2,$3,'user',$4)
		RETURNING id,email,display_name,role,balance_credits,created_at`, email, passwordHash, displayName, openingVirtualCredits).
		Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return User{}, errAccountUnavailable
		}
		return User{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credit_ledger(user_id,reason,delta_credits,balance_after) VALUES ($1,'opening',$2,$2)`, user.ID, openingVirtualCredits); err != nil {
		return User{}, err
	}
	auditCtx := context.WithValue(ctx, userContextKey, user)
	if err := auditTx(auditCtx, tx, "user.registered", "user", user.ID, map[string]any{"role": RoleUser, "credits": "virtual"}); err != nil {
		return User{}, err
	}
	if err := createSessionTx(auditCtx, tx, user.ID, hash, expires, previousToken); err != nil {
		return User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return user, nil
}

func (api *API) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input registrationInput
	if !decodeJSON(w, r, &input) {
		return
	}
	input, valid := normalizeRegistration(input)
	if !valid {
		writeError(w, http.StatusBadRequest, "invalid_registration", "Use a valid email, a display name of 2 to 80 characters and a password of at least 12 characters and at most 72 UTF-8 bytes.")
		return
	}
	if !api.registrations.allowLimited(r.RemoteAddr, input.Email, time.Now(), 20, 5) {
		w.Header().Set("Retry-After", "900")
		writeError(w, http.StatusTooManyRequests, "registration_rate_limited", "Too many registration attempts. Try again later.")
		return
	}
	passwordHash, err := HashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not create account.")
		return
	}
	token, err := newSessionToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not create account.")
		return
	}
	expires := time.Now().Add(sessionLifetime)
	user, err := api.store.RegisterAccount(r.Context(), input.Email, passwordHash, input.DisplayName, sessionHash(token), expires, sessionToken(r))
	if errors.Is(err, errAccountUnavailable) {
		writeError(w, http.StatusConflict, "account_unavailable", "An account could not be created with these details. Try signing in.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not create account.")
		return
	}
	api.setSessionCookie(w, token, expires)
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

type CreditLedgerEntry struct {
	ID           int64     `json:"id"`
	BetID        *int64    `json:"betId,omitempty"`
	MarketID     *int64    `json:"marketId,omitempty"`
	Reason       string    `json:"reason"`
	DeltaCredits int64     `json:"deltaCredits"`
	BalanceAfter int64     `json:"balanceAfter"`
	CreatedAt    time.Time `json:"createdAt"`
}

func accountListLimit(r *http.Request) int {
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func (s *Store) ListUserLedger(ctx context.Context, userID int64, limit int) ([]CreditLedgerEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,bet_id,market_id,reason,delta_credits,balance_after,created_at FROM credit_ledger WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []CreditLedgerEntry{}
	for rows.Next() {
		var entry CreditLedgerEntry
		if err := rows.Scan(&entry.ID, &entry.BetID, &entry.MarketID, &entry.Reason, &entry.DeltaCredits, &entry.BalanceAfter, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (api *API) handleMyLedger(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	user, _ := currentUser(r.Context())
	entries, err := api.store.ListUserLedger(r.Context(), user.ID, accountListLimit(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not load account history.")
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Store) ListUsers(ctx context.Context, limit int) ([]User, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,email,display_name,role,balance_credits,created_at FROM users ORDER BY created_at DESC,id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (api *API) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	// Preserve the original bounded array contract for existing API clients.
	// The administrator UI opts into the counted, searchable page contract.
	query := r.URL.Query()
	if query.Has("page") || query.Has("pageSize") || query.Has("q") {
		options, err := parseUserListOptions(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_directory_query", "Use a page from 1 to 1,000,000, a page size from 1 to 200, and a search of at most 254 characters.")
			return
		}
		page, err := api.store.ListUsersPage(r.Context(), options)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "server_error", "Could not load accounts.")
			return
		}
		writeJSON(w, http.StatusOK, page)
		return
	}
	users, err := api.store.ListUsers(r.Context(), accountListLimit(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not load accounts.")
		return
	}
	writeJSON(w, http.StatusOK, users)
}
