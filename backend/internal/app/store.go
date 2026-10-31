package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")
var ErrInvalid = errors.New("invalid request")
var ErrConflict = errors.New("conflict")

type Store struct {
	pool *pgxpool.Pool
}

func OpenDB(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	return pgxpool.NewWithConfig(ctx, cfg)
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) CreateUserIfMissing(ctx context.Context, email, passwordHash, displayName, role string, balanceCredits int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, display_name, role, balance_credits)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (email) DO NOTHING
		RETURNING id
	`, strings.ToLower(strings.TrimSpace(email)), passwordHash, displayName, role, balanceCredits).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credit_ledger(user_id,reason,delta_credits,balance_after) VALUES ($1,'opening',$2,$2)`, id, balanceCredits); err != nil {
		return err
	}
	if err := auditTx(ctx, tx, "user.created", "user", id, map[string]any{"role": role}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (User, string, error) {
	var user User
	var passwordHash string
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, password_hash, display_name, role, balance_credits, created_at
		FROM users
		WHERE email = $1
	`, strings.ToLower(strings.TrimSpace(email))).Scan(
		&user.ID, &user.Email, &passwordHash, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrNotFound
	}
	return user, passwordHash, err
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (User, error) {
	var user User
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, display_name, role, balance_credits, created_at
		FROM users
		WHERE id = $1
	`, id).Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return user, err
}

func (s *Store) ListStreams(ctx context.Context, activeOnly bool) ([]Stream, error) {
	query := `
		SELECT id, title, city, country, location_label, description, stream_type, stream_url,
		       thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
		       latitude, longitude, is_active, created_at, updated_at
		FROM streams WHERE retired_at IS NULL
	`
	if activeOnly {
		query += ` AND is_active = true`
	}
	query += ` ORDER BY city, title`

	rows, err := s.pool.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	streams := []Stream{}
	for rows.Next() {
		stream, err := scanStream(rows)
		if err != nil {
			return nil, err
		}
		streams = append(streams, stream)
	}
	return streams, rows.Err()
}

func (s *Store) GetStream(ctx context.Context, id int64) (Stream, error) {
	stream, err := scanStream(s.pool.QueryRow(ctx, `
		SELECT id, title, city, country, location_label, description, stream_type, stream_url,
		       thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
		       latitude, longitude, is_active, created_at, updated_at
		FROM streams
		WHERE id = $1
	`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Stream{}, ErrNotFound
	}
	return stream, err
}

func (s *Store) CreateStream(ctx context.Context, stream Stream) (Stream, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Stream{}, err
	}
	defer tx.Rollback(ctx)
	created, err := scanStream(tx.QueryRow(ctx, `
		INSERT INTO streams (
			title, city, country, location_label, description, stream_type, stream_url,
			thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
			latitude, longitude, is_active
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		RETURNING id, title, city, country, location_label, description, stream_type, stream_url,
		          thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
		          latitude, longitude, is_active, created_at, updated_at
	`, stream.Title, stream.City, stream.Country, stream.LocationLabel, stream.Description, stream.StreamType,
		stream.StreamURL, stream.ThumbnailURL, stream.SourceOwner, stream.SourcePageURL, stream.TermsURL,
		stream.UsageNotes, stream.Latitude, stream.Longitude, stream.IsActive))
	if err != nil {
		return Stream{}, err
	}
	if err := auditTx(ctx, tx, "stream.created", "stream", created.ID, map[string]any{"active": created.IsActive}); err != nil {
		return Stream{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Stream{}, err
	}
	return created, nil
}

func (s *Store) UpdateStream(ctx context.Context, stream Stream) (Stream, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Stream{}, err
	}
	defer tx.Rollback(ctx)
	// Placement and creation hold a shared source lock before taking a user
	// lock. Serialize source changes here, but do not lock market rows: placement
	// already holds its market row before requesting the source lock.
	current, err := scanStream(tx.QueryRow(ctx, `
		SELECT id, title, city, country, location_label, description, stream_type, stream_url,
		       thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
		       latitude, longitude, is_active, created_at, updated_at
		FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, stream.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Stream{}, ErrNotFound
	}
	if err != nil {
		return Stream{}, err
	}
	if streamSourceChanged(current, stream) {
		var pending bool
		// This statement receives a fresh READ COMMITTED snapshot after the
		// source lock is acquired, including any bet whose transaction just ended.
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM bet_markets m JOIN bets b ON b.market_id=m.id
			WHERE m.stream_id=$1 AND m.status='open' AND b.status='pending'
		)`, stream.ID).Scan(&pending); err != nil {
			return Stream{}, err
		}
		if pending {
			return Stream{}, fmt.Errorf("%w: void and refund open rounds before changing this camera source or location", ErrConflict)
		}
	}
	updated, err := scanStream(tx.QueryRow(ctx, `
		UPDATE streams
		SET title = $2,
		    city = $3,
		    country = $4,
		    location_label = $5,
		    description = $6,
		    stream_type = $7,
		    stream_url = $8,
		    thumbnail_url = $9,
		    source_owner = $10,
		    source_page_url = $11,
		    terms_url = $12,
		    usage_notes = $13,
		    latitude = $14,
		    longitude = $15,
		    is_active = $16,
		    updated_at = now()
		WHERE id = $1
		RETURNING id, title, city, country, location_label, description, stream_type, stream_url,
		          thumbnail_url, source_owner, source_page_url, terms_url, usage_notes,
		          latitude, longitude, is_active, created_at, updated_at
	`, stream.ID, stream.Title, stream.City, stream.Country, stream.LocationLabel, stream.Description,
		stream.StreamType, stream.StreamURL, stream.ThumbnailURL, stream.SourceOwner, stream.SourcePageURL,
		stream.TermsURL, stream.UsageNotes, stream.Latitude, stream.Longitude, stream.IsActive))
	if errors.Is(err, pgx.ErrNoRows) {
		return Stream{}, ErrNotFound
	}
	if err != nil {
		return Stream{}, err
	}
	if err := auditTx(ctx, tx, "stream.updated", "stream", updated.ID, map[string]any{"active": updated.IsActive}); err != nil {
		return Stream{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Stream{}, err
	}
	return updated, nil
}

func streamSourceChanged(before, after Stream) bool {
	return before.StreamURL != after.StreamURL || before.StreamType != after.StreamType ||
		before.City != after.City || before.Country != after.Country || before.LocationLabel != after.LocationLabel ||
		before.Description != after.Description || before.UsageNotes != after.UsageNotes || before.SourceOwner != after.SourceOwner ||
		!sameStreamCoordinate(before.Latitude, after.Latitude) || !sameStreamCoordinate(before.Longitude, after.Longitude)
}

func sameStreamCoordinate(before, after *float64) bool {
	if before == nil || after == nil {
		return before == nil && after == nil
	}
	return *before == *after
}

func (s *Store) DeleteStream(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE streams SET is_active=false, updated_at=now() WHERE id = $1 AND retired_at IS NULL`, id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := auditTx(ctx, tx, "stream.archived", "stream", id, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ListMarkets(ctx context.Context, streamID *int64, status string) ([]Market, error) {
	return s.listMarkets(ctx, streamID, status, false)
}

// Public camera history includes completed and cancelled rounds, but draft
// rules and odds remain private until an administrator opens the round.
func (s *Store) ListPublicMarkets(ctx context.Context, streamID int64, status string) ([]Market, error) {
	if status != "" && status != MarketOpen && status != MarketSettled && status != MarketVoid {
		return nil, fmt.Errorf("%w: market status is invalid", ErrInvalid)
	}
	return s.listMarkets(ctx, &streamID, status, true)
}

func (s *Store) listMarkets(ctx context.Context, streamID *int64, status string, publicOnly bool) ([]Market, error) {
	args := []any{}
	where := []string{}
	if publicOnly {
		where = append(where, "m.status <> 'draft'")
	}
	if streamID != nil {
		args = append(args, *streamID)
		where = append(where, fmt.Sprintf("m.stream_id = $%d", len(args)))
	}
	if status != "" {
		args = append(args, status)
		where = append(where, fmt.Sprintf("m.status = $%d", len(args)))
	}

	query := `
		SELECT m.id, m.stream_id, s.title, m.title, m.threshold, m.window_start, m.window_end, m.betting_closes_at,
	       m.odds_over, m.odds_under, m.status, m.actual_count, m.created_at, m.updated_at, m.void_reason
		FROM bet_markets m
		JOIN streams s ON s.id = m.stream_id
	`
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += ` ORDER BY m.window_start DESC, m.id DESC`

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	markets := []Market{}
	for rows.Next() {
		market, err := scanMarket(rows)
		if err != nil {
			return nil, err
		}
		markets = append(markets, market)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := s.attachCountingSnapshots(ctx, markets); err != nil {
		return nil, err
	}
	return markets, nil
}

func (s *Store) CreateMarket(ctx context.Context, market Market) (Market, error) {
	if market.BettingClosesAt.IsZero() {
		market.BettingClosesAt = market.WindowStart.Add(-minimumObservationLead)
	}
	if !validOdds(market.OddsOver) || !validOdds(market.OddsUnder) || market.Threshold < 0 || market.Threshold > maxVehicleCount || !validObservationLead(market) || !market.WindowEnd.After(market.WindowStart) || (market.Status != MarketOpen && market.Status != MarketDraft) {
		return Market{}, fmt.Errorf("%w: market fields are invalid", ErrInvalid)
	}
	if market.Status == MarketOpen && !market.BettingClosesAt.After(time.Now()) {
		return Market{}, fmt.Errorf("%w: an open market must close in the future", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Market{}, err
	}
	defer tx.Rollback(ctx)
	var active bool
	var streamType string
	if err := tx.QueryRow(ctx, `SELECT is_active,stream_type FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, market.StreamID).Scan(&active, &streamType); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Market{}, ErrNotFound
		}
		return Market{}, err
	}
	if !active || !supportsLivePredictions(streamType) {
		return Market{}, fmt.Errorf("%w: predictions require an active continuous live stream", ErrConflict)
	}
	if market.Status == MarketOpen {
		var overlaps bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM round_schedules WHERE stream_id=$1 AND enabled)
			AND EXISTS(SELECT 1 FROM bet_markets WHERE stream_id=$1 AND status='open' AND window_start<$2 AND window_end>$3)`,
			market.StreamID, market.WindowEnd, market.WindowStart).Scan(&overlaps); err != nil {
			return Market{}, err
		}
		if overlaps {
			return Market{}, fmt.Errorf("%w: counting interval overlaps a published round on an automatically scheduled camera", ErrConflict)
		}
	}
	created, err := scanMarket(tx.QueryRow(ctx, `
		INSERT INTO bet_markets (
			stream_id, title, threshold, window_start, window_end, odds_over, odds_under, status, betting_closes_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, stream_id, '', title, threshold, window_start, window_end, betting_closes_at,
	          odds_over, odds_under, status, actual_count, created_at, updated_at, void_reason
	`, market.StreamID, market.Title, market.Threshold, market.WindowStart, market.WindowEnd,
		market.OddsOver, market.OddsUnder, market.Status, market.BettingClosesAt))
	if err != nil {
		return Market{}, err
	}
	if err := auditTx(ctx, tx, "market.created", "market", created.ID, map[string]any{"streamId": market.StreamID, "status": market.Status}); err != nil {
		return Market{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Market{}, err
	}
	return created, nil
}

func (s *Store) PlaceBet(ctx context.Context, userID int64, marketID int64, side string, stakeCredits int64, idempotencyKey string) (Bet, User, error) {
	if !validBetSide(side) || stakeCredits < 1 || stakeCredits > maxStakeCredits || !validIdempotencyKey(idempotencyKey) {
		return Bet{}, User{}, fmt.Errorf("%w: side, stake or idempotency key is invalid", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Bet{}, User{}, err
	}
	defer tx.Rollback(ctx)

	var market Market
	var actual sql.NullInt32
	err = tx.QueryRow(ctx, `
		SELECT id, stream_id, '', title, threshold, window_start, window_end, betting_closes_at, odds_over, odds_under,
		       status, actual_count, created_at, updated_at
		FROM bet_markets
		WHERE id = $1
		FOR UPDATE
	`, marketID).Scan(
		&market.ID, &market.StreamID, &market.StreamTitle, &market.Title, &market.Threshold,
		&market.WindowStart, &market.WindowEnd, &market.BettingClosesAt, &market.OddsOver, &market.OddsUnder,
		&market.Status, &actual, &market.CreatedAt, &market.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Bet{}, User{}, ErrNotFound
	}
	if err != nil {
		return Bet{}, User{}, err
	}
	if actual.Valid {
		v := int(actual.Int32)
		market.ActualCount = &v
	}
	// Lock source configuration before the user, matching source updates which
	// also audit an actor user. This prevents a source being archived mid-bet.
	var active bool
	var streamType string
	if err := tx.QueryRow(ctx, `SELECT is_active,stream_type FROM streams WHERE id=$1 FOR SHARE`, market.StreamID).Scan(&active, &streamType); err != nil {
		return Bet{}, User{}, err
	}

	var user User
	err = tx.QueryRow(ctx, `
		SELECT id, email, display_name, role, balance_credits, created_at
		FROM users
		WHERE id = $1
		FOR UPDATE
	`, userID).Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &user.BalanceCredits, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Bet{}, User{}, ErrNotFound
	}
	if err != nil {
		return Bet{}, User{}, err
	}
	var existing Bet
	err = tx.QueryRow(ctx, `SELECT id,user_id,market_id,side,stake_credits,potential_payout_credits,status,created_at,settled_at FROM bets WHERE user_id=$1 AND idempotency_key=$2`, userID, idempotencyKey).Scan(&existing.ID, &existing.UserID, &existing.MarketID, &existing.Side, &existing.StakeCredits, &existing.PotentialPayoutCredits, &existing.Status, &existing.CreatedAt, &existing.SettledAt)
	if err == nil {
		if existing.MarketID != marketID || existing.Side != side || existing.StakeCredits != stakeCredits {
			return Bet{}, User{}, fmt.Errorf("%w: idempotency key was already used for a different bet", ErrConflict)
		}
		return existing, user, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Bet{}, User{}, err
	}
	if err := checkBettingOpen(market, time.Now()); err != nil {
		return Bet{}, User{}, err
	}
	if !active || !supportsLivePredictions(streamType) {
		return Bet{}, User{}, fmt.Errorf("%w: predictions require an active continuous live stream", ErrConflict)
	}
	if user.BalanceCredits < stakeCredits {
		return Bet{}, User{}, fmt.Errorf("%w: not enough credits", ErrConflict)
	}

	odds := market.OddsUnder
	if side == BetSideOver {
		odds = market.OddsOver
	}
	payout, err := payoutCredits(stakeCredits, odds)
	if err != nil {
		return Bet{}, User{}, err
	}

	var bet Bet
	err = tx.QueryRow(ctx, `
		INSERT INTO bets (user_id, market_id, side, stake_credits, potential_payout_credits, status, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, 'pending', $6)
		RETURNING id, user_id, market_id, side, stake_credits, potential_payout_credits, status, created_at, settled_at
	`, user.ID, market.ID, side, stakeCredits, payout, idempotencyKey).Scan(
		&bet.ID, &bet.UserID, &bet.MarketID, &bet.Side, &bet.StakeCredits,
		&bet.PotentialPayoutCredits, &bet.Status, &bet.CreatedAt, &bet.SettledAt,
	)
	if err != nil {
		return Bet{}, User{}, err
	}

	user.BalanceCredits -= stakeCredits
	if _, err := tx.Exec(ctx, `UPDATE users SET balance_credits = $1 WHERE id = $2`, user.BalanceCredits, user.ID); err != nil {
		return Bet{}, User{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credit_ledger(user_id,bet_id,market_id,reason,delta_credits,balance_after) VALUES ($1,$2,$3,'stake',$4,$5)`, user.ID, bet.ID, market.ID, -stakeCredits, user.BalanceCredits); err != nil {
		return Bet{}, User{}, err
	}
	if err := auditTx(ctx, tx, "bet.placed", "bet", bet.ID, map[string]any{"marketId": market.ID, "stakeCredits": stakeCredits, "side": side}); err != nil {
		return Bet{}, User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Bet{}, User{}, err
	}
	return bet, user, nil
}

func (s *Store) SettleMarket(ctx context.Context, marketID int64, actualCount int, verification SettlementVerification) (Market, error) {
	verification, err := normalizeSettlementVerification(verification)
	if err != nil {
		return Market{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Market{}, err
	}
	defer tx.Rollback(ctx)

	var market Market
	var actual sql.NullInt32
	err = tx.QueryRow(ctx, `
		SELECT id, stream_id, '', title, threshold, window_start, window_end, betting_closes_at, odds_over, odds_under,
		       status, actual_count, created_at, updated_at
		FROM bet_markets
		WHERE id = $1
		FOR UPDATE
	`, marketID).Scan(
		&market.ID, &market.StreamID, &market.StreamTitle, &market.Title, &market.Threshold,
		&market.WindowStart, &market.WindowEnd, &market.BettingClosesAt, &market.OddsOver, &market.OddsUnder,
		&market.Status, &actual, &market.CreatedAt, &market.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Market{}, ErrNotFound
	}
	if err != nil {
		return Market{}, err
	}
	if err := checkSettlementAllowed(market, actualCount, time.Now()); err != nil {
		return Market{}, err
	}
	if err := requireVersionedRoundReview(ctx, tx, marketID, actualCount); err != nil {
		return Market{}, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id, user_id, side, potential_payout_credits
		FROM bets
		WHERE market_id = $1 AND status = 'pending'
		ORDER BY user_id, id
		FOR UPDATE
	`, market.ID)
	if err != nil {
		return Market{}, err
	}

	type pendingBet struct {
		id     int64
		userID int64
		side   string
		payout int64
	}
	pending := []pendingBet{}
	for rows.Next() {
		var bet pendingBet
		if err := rows.Scan(&bet.id, &bet.userID, &bet.side, &bet.payout); err != nil {
			rows.Close()
			return Market{}, err
		}
		pending = append(pending, bet)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Market{}, err
	}
	rows.Close()

	for _, bet := range pending {
		won := (bet.side == BetSideOver && actualCount > market.Threshold) ||
			(bet.side == BetSideUnder && actualCount <= market.Threshold)
		status := BetLost
		if won {
			status = BetWon
			var balance int64
			if err := tx.QueryRow(ctx, `
				UPDATE users
				SET balance_credits = balance_credits + $1
				WHERE id = $2
				RETURNING balance_credits
			`, bet.payout, bet.userID).Scan(&balance); err != nil {
				return Market{}, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO credit_ledger(user_id,bet_id,market_id,reason,delta_credits,balance_after) VALUES ($1,$2,$3,'payout',$4,$5)`, bet.userID, bet.id, market.ID, bet.payout, balance); err != nil {
				return Market{}, err
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bets
			SET status = $1, settled_at = now()
			WHERE id = $2
		`, status, bet.id); err != nil {
			return Market{}, err
		}
	}

	updated, err := scanMarket(tx.QueryRow(ctx, `
		UPDATE bet_markets
		SET status = 'settled',
		    actual_count = $2,
		    updated_at = now()
		WHERE id = $1
		RETURNING id, stream_id, '', title, threshold, window_start, window_end, betting_closes_at,
	          odds_over, odds_under, status, actual_count, created_at, updated_at, void_reason
	`, market.ID, actualCount))
	if err != nil {
		return Market{}, err
	}

	var metricID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO stream_metrics (stream_id, source, vehicle_count, interval_start, interval_end)
		VALUES ($1, 'manual', $2, $3, $4)
		ON CONFLICT (stream_id,source,interval_start,interval_end) DO UPDATE SET vehicle_count=stream_metrics.vehicle_count WHERE stream_metrics.vehicle_count=EXCLUDED.vehicle_count
		RETURNING id
	`, market.StreamID, actualCount, market.WindowStart, market.WindowEnd).Scan(&metricID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Market{}, fmt.Errorf("%w: a different count already exists for this interval", ErrConflict)
		}
		return Market{}, err
	}
	if err := auditTx(ctx, tx, "market.settled", "market", market.ID, map[string]any{"actualCount": actualCount, "settledBets": len(pending), "verificationPolicy": settlementVerificationPolicy, "verification": verification}); err != nil {
		return Market{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Market{}, err
	}
	return updated, nil
}

func (s *Store) ListBetsForUser(ctx context.Context, userID int64) ([]Bet, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT b.id, b.user_id, b.market_id, m.title, s.title, b.side, b.stake_credits,
		       b.potential_payout_credits, b.status, b.created_at, b.settled_at
		FROM bets b
		JOIN bet_markets m ON m.id = b.market_id
		JOIN streams s ON s.id = m.stream_id
		WHERE b.user_id = $1
		ORDER BY b.created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBets(rows)
}

func (s *Store) ListAllBets(ctx context.Context, marketID *int64) ([]Bet, error) {
	args := []any{}
	query := `
		SELECT b.id, b.user_id, b.market_id, m.title, s.title, b.side, b.stake_credits,
		       b.potential_payout_credits, b.status, b.created_at, b.settled_at
		FROM bets b
		JOIN bet_markets m ON m.id = b.market_id
		JOIN streams s ON s.id = m.stream_id
	`
	if marketID != nil {
		args = append(args, *marketID)
		query += ` WHERE b.market_id = $1`
	}
	query += ` ORDER BY b.created_at DESC`
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBets(rows)
}

func (s *Store) CreateStreamMetric(ctx context.Context, metric StreamMetric) (StreamMetric, error) {
	created, err := scanMetric(s.pool.QueryRow(ctx, `
		INSERT INTO stream_metrics (stream_id, source, vehicle_count, interval_start, interval_end)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (stream_id,source,interval_start,interval_end) DO UPDATE SET vehicle_count=stream_metrics.vehicle_count WHERE stream_metrics.vehicle_count=EXCLUDED.vehicle_count
		RETURNING id, stream_id, source, vehicle_count, interval_start, interval_end, created_at
	`, metric.StreamID, metric.Source, metric.VehicleCount, metric.IntervalStart, metric.IntervalEnd))
	if errors.Is(err, pgx.ErrNoRows) {
		return StreamMetric{}, fmt.Errorf("%w: a different count already exists for this interval", ErrConflict)
	}
	return created, err
}

func (s *Store) ListStreamMetrics(ctx context.Context, streamID int64, limit int) ([]StreamMetric, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, stream_id, source, vehicle_count, interval_start, interval_end, created_at
		FROM stream_metrics
		WHERE stream_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, streamID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	metrics := []StreamMetric{}
	for rows.Next() {
		metric, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		metrics = append(metrics, metric)
	}
	return metrics, rows.Err()
}

func scanStream(row pgx.Row) (Stream, error) {
	var stream Stream
	var thumbnail sql.NullString
	var sourceOwner sql.NullString
	var sourcePageURL sql.NullString
	var termsURL sql.NullString
	var usageNotes sql.NullString
	var latitude sql.NullFloat64
	var longitude sql.NullFloat64
	err := row.Scan(
		&stream.ID, &stream.Title, &stream.City, &stream.Country, &stream.LocationLabel,
		&stream.Description, &stream.StreamType, &stream.StreamURL, &thumbnail, &sourceOwner,
		&sourcePageURL, &termsURL, &usageNotes, &latitude, &longitude, &stream.IsActive,
		&stream.CreatedAt, &stream.UpdatedAt,
	)
	if err != nil {
		return Stream{}, err
	}
	if thumbnail.Valid {
		stream.ThumbnailURL = thumbnail.String
	}
	if sourceOwner.Valid {
		stream.SourceOwner = sourceOwner.String
	}
	if sourcePageURL.Valid {
		stream.SourcePageURL = sourcePageURL.String
	}
	if termsURL.Valid {
		stream.TermsURL = termsURL.String
	}
	if usageNotes.Valid {
		stream.UsageNotes = usageNotes.String
	}
	if latitude.Valid {
		value := latitude.Float64
		stream.Latitude = &value
	}
	if longitude.Valid {
		value := longitude.Float64
		stream.Longitude = &value
	}
	return stream, nil
}

func scanMarket(row pgx.Row) (Market, error) {
	var market Market
	var actual sql.NullInt32
	err := row.Scan(
		&market.ID, &market.StreamID, &market.StreamTitle, &market.Title, &market.Threshold,
		&market.WindowStart, &market.WindowEnd, &market.BettingClosesAt, &market.OddsOver, &market.OddsUnder,
		&market.Status, &actual, &market.CreatedAt, &market.UpdatedAt, &market.VoidReason,
	)
	if err != nil {
		return Market{}, err
	}
	if actual.Valid {
		value := int(actual.Int32)
		market.ActualCount = &value
	}
	return market, nil
}

func scanBets(rows pgx.Rows) ([]Bet, error) {
	bets := []Bet{}
	for rows.Next() {
		var bet Bet
		var settledAt sql.NullTime
		if err := rows.Scan(
			&bet.ID, &bet.UserID, &bet.MarketID, &bet.MarketTitle, &bet.StreamTitle,
			&bet.Side, &bet.StakeCredits, &bet.PotentialPayoutCredits, &bet.Status,
			&bet.CreatedAt, &settledAt,
		); err != nil {
			return nil, err
		}
		if settledAt.Valid {
			bet.SettledAt = &settledAt.Time
		}
		bets = append(bets, bet)
	}
	return bets, rows.Err()
}

func scanMetric(row pgx.Row) (StreamMetric, error) {
	var metric StreamMetric
	err := row.Scan(
		&metric.ID, &metric.StreamID, &metric.Source, &metric.VehicleCount,
		&metric.IntervalStart, &metric.IntervalEnd, &metric.CreatedAt,
	)
	return metric, err
}
