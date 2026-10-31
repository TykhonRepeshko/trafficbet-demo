package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Restore changes availability only; source settings, rounds and credit
// history stay attached to the original camera. Concurrent retries audit once.
func (s *Store) RestoreStream(ctx context.Context, id int64) (Stream, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Stream{}, err
	}
	defer tx.Rollback(ctx)
	stream, err := scanStream(tx.QueryRow(ctx, `SELECT id,title,city,country,location_label,description,stream_type,stream_url,
		thumbnail_url,source_owner,source_page_url,terms_url,usage_notes,latitude,longitude,is_active,created_at,updated_at
		FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Stream{}, ErrNotFound
	}
	if err != nil || stream.IsActive {
		return stream, err
	}
	if err := tx.QueryRow(ctx, `UPDATE streams SET is_active=true,updated_at=now() WHERE id=$1 RETURNING updated_at`, id).Scan(&stream.UpdatedAt); err != nil {
		return Stream{}, err
	}
	stream.IsActive = true
	if err := auditTx(ctx, tx, "stream.restored", "stream", id, nil); err != nil {
		return Stream{}, err
	}
	return stream, tx.Commit(ctx)
}
