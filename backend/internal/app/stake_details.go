package app

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type stakeDetailOptions struct {
	StreamID       int64
	MarketID       *int64
	Status         string
	Page, PageSize int
}

type AdminStakeBet struct {
	Bet
	StreamID    int64  `json:"streamId"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
}

type StakeBetPage struct {
	AsOf         time.Time       `json:"asOf"`
	StreamID     int64           `json:"streamId"`
	MarketID     *int64          `json:"marketId,omitempty"`
	Status       string          `json:"status"`
	Items        []AdminStakeBet `json:"items"`
	Total        int             `json:"total"`
	StakeCredits int64           `json:"stakeCredits"`
	Page         int             `json:"page"`
	PageSize     int             `json:"pageSize"`
	TotalPages   int             `json:"totalPages"`
}

func parseStakeDetailOptions(r *http.Request) (stakeDetailOptions, error) {
	options := stakeDetailOptions{Status: "pending"}
	query := r.URL.Query()
	for name, values := range query {
		if len(values) != 1 {
			return options, ErrInvalid
		}
		switch name {
		case "streamId", "marketId", "status", "page", "pageSize":
		default:
			return options, ErrInvalid
		}
	}
	page, err := parseUserListOptions(r)
	if err != nil {
		return options, ErrInvalid
	}
	options.Page, options.PageSize = page.Page, page.PageSize
	options.StreamID, err = parseID(query.Get("streamId"))
	if err != nil {
		return options, ErrInvalid
	}
	if query.Has("marketId") {
		id, err := parseID(query.Get("marketId"))
		if err != nil {
			return options, ErrInvalid
		}
		options.MarketID = &id
	}
	if query.Has("status") {
		options.Status = query.Get("status")
	}
	switch options.Status {
	case "pending", "won", "lost", "void", "all":
	default:
		return options, ErrInvalid
	}
	return options, nil
}

func (s *Store) StakeBetDetails(ctx context.Context, options stakeDetailOptions) (StakeBetPage, error) {
	page := StakeBetPage{StreamID: options.StreamID, MarketID: options.MarketID, Status: options.Status, Items: []AdminStakeBet{}, Page: options.Page, PageSize: options.PageSize, TotalPages: 1}
	if options.StreamID <= 0 || options.Page < 1 || options.Page > 1000000 || options.PageSize < 1 || options.PageSize > 200 {
		return page, ErrInvalid
	}
	switch options.Status {
	case "pending", "won", "lost", "void", "all":
	default:
		return page, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT transaction_timestamp(),EXISTS(SELECT 1 FROM streams s WHERE s.id=$1 AND s.retired_at IS NULL AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM bet_markets m WHERE m.id=$2 AND m.stream_id=s.id)))`, options.StreamID, options.MarketID).Scan(&page.AsOf, &exists); err != nil {
		return page, err
	}
	if !exists {
		return page, ErrNotFound
	}
	const filter = ` FROM bets b JOIN bet_markets m ON m.id=b.market_id JOIN streams s ON s.id=m.stream_id JOIN users u ON u.id=b.user_id WHERE m.stream_id=$1 AND ($2::bigint IS NULL OR m.id=$2) AND ($3='all' OR b.status=$3)`
	if err := tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(b.stake_credits),0)`+filter, options.StreamID, options.MarketID, options.Status).Scan(&page.Total, &page.StakeCredits); err != nil {
		return page, err
	}
	if page.Total > 0 {
		page.TotalPages = (page.Total-1)/page.PageSize + 1
	}
	if page.Page > page.TotalPages {
		page.Page = page.TotalPages
	}
	rows, err := tx.Query(ctx, `SELECT b.id,b.user_id,b.market_id,m.title,s.title,b.side,b.stake_credits,b.potential_payout_credits,b.status,b.created_at,b.settled_at,s.id,u.display_name,u.email`+filter+` ORDER BY b.created_at DESC,b.id DESC LIMIT $4 OFFSET $5`, options.StreamID, options.MarketID, options.Status, page.PageSize, (page.Page-1)*page.PageSize)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		var item AdminStakeBet
		if err := rows.Scan(&item.ID, &item.UserID, &item.MarketID, &item.MarketTitle, &item.StreamTitle, &item.Side, &item.StakeCredits, &item.PotentialPayoutCredits, &item.Status, &item.CreatedAt, &item.SettledAt, &item.StreamID, &item.DisplayName, &item.Email); err != nil {
			rows.Close()
			return page, err
		}
		page.Items = append(page.Items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return page, err
	}
	return page, tx.Commit(ctx)
}

func (api *API) handleStakeDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	options, err := parseStakeDetailOptions(r)
	if err != nil {
		writeError(w, 400, "invalid_stake_query", "Select a camera, an optional round, a valid status and a bounded page.")
		return
	}
	page, err := api.store.StakeBetDetails(r.Context(), options)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, page)
}
