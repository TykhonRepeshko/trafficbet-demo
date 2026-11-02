package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// VoidMarket serializes with placement and settlement on the market row. Every
// stake refund, balance update, bet status and audit record commits together.
func (s *Store) VoidMarket(ctx context.Context, marketID int64, reason string) (Market, error) {
	reason = strings.TrimSpace(reason)
	if !validVoidReason(reason) {
		return Market{}, fmt.Errorf("%w: a cancellation reason of 5 to 500 characters is required", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Market{}, err
	}
	defer tx.Rollback(ctx)
	market, err := scanMarket(tx.QueryRow(ctx, `
		SELECT id,stream_id,'',title,threshold,window_start,window_end,betting_closes_at,
		       odds_over,odds_under,status,actual_count,created_at,updated_at,void_reason
		FROM bet_markets WHERE id=$1 FOR UPDATE`, marketID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Market{}, ErrNotFound
	}
	if err != nil {
		return Market{}, err
	}
	if market.Status == MarketVoid {
		if market.VoidReason != reason {
			return Market{}, fmt.Errorf("%w: market was already cancelled with a different reason", ErrConflict)
		}
		return market, tx.Commit(ctx)
	}
	if market.Status != MarketOpen && market.Status != MarketDraft {
		return Market{}, fmt.Errorf("%w: a settled market cannot be cancelled", ErrConflict)
	}
	updated, err := voidLockedMarket(ctx, tx, market, reason)
	if err != nil {
		return Market{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Market{}, err
	}
	return updated, nil
}

// voidLockedMarket refunds every pending stake and cancels the market. The
// caller holds the market row lock, validated the reason and commits.
func voidLockedMarket(ctx context.Context, tx pgx.Tx, market Market, reason string) (Market, error) {
	rows, err := tx.Query(ctx, `SELECT id,user_id,stake_credits FROM bets WHERE market_id=$1 AND status='pending' ORDER BY user_id,id FOR UPDATE`, market.ID)
	if err != nil {
		return Market{}, err
	}
	type refund struct{ betID, userID, stake int64 }
	refunds := []refund{}
	for rows.Next() {
		var item refund
		if err := rows.Scan(&item.betID, &item.userID, &item.stake); err != nil {
			rows.Close()
			return Market{}, err
		}
		refunds = append(refunds, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Market{}, err
	}
	var refundedCredits int64
	for _, item := range refunds {
		var balance int64
		if err := tx.QueryRow(ctx, `UPDATE users SET balance_credits=balance_credits+$1 WHERE id=$2 RETURNING balance_credits`, item.stake, item.userID).Scan(&balance); err != nil {
			return Market{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO credit_ledger(user_id,bet_id,market_id,reason,delta_credits,balance_after) VALUES ($1,$2,$3,'refund',$4,$5)`, item.userID, item.betID, market.ID, item.stake, balance); err != nil {
			return Market{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE bets SET status='void',settled_at=now() WHERE id=$1`, item.betID); err != nil {
			return Market{}, err
		}
		refundedCredits += item.stake
	}
	updated, err := scanMarket(tx.QueryRow(ctx, `
		UPDATE bet_markets SET status='void',void_reason=$2,updated_at=now() WHERE id=$1
		RETURNING id,stream_id,'',title,threshold,window_start,window_end,betting_closes_at,
		          odds_over,odds_under,status,actual_count,created_at,updated_at,void_reason`, market.ID, reason))
	if err != nil {
		return Market{}, err
	}
	if err := auditTx(ctx, tx, "market.voided", "market", market.ID, map[string]any{"reason": reason, "refundedBets": len(refunds), "refundedCredits": refundedCredits}); err != nil {
		return Market{}, err
	}
	return updated, nil
}
