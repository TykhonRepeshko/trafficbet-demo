package app

import (
	"context"
	_ "embed"
	"encoding/json"
)

//go:embed camera_catalog.json
var defaultCameraCatalogJSON []byte

// DefaultCameraCatalog returns independent values from the operator-attributed
// catalog. Loading it does not update an existing installation's cameras.
func DefaultCameraCatalog() ([]Stream, error) {
	var streams []Stream
	if err := json.Unmarshal(defaultCameraCatalogJSON, &streams); err != nil {
		return nil, err
	}
	return streams, nil
}

func seedCountingTitle(stream Stream) string {
	switch stream.Title {
	case "E6 · Djupdalen":
		return "Vehicle centers crossing the horizontal line at 55% frame height · both directions · 5 min"
	case "E39 · Fjøsangerveien", "E16 · Skaret":
		return "Vehicle centers crossing the horizontal line at 60% frame height · main road, both directions · 5 min"
	}
	return "Vehicle centers crossing the vertical mid-frame line · both directions · 5 min"
}

// Seed is opt-in local data. The operator's public HLS URLs are fetched only
// through the restricted media gateway. Existing data is never replaced.
func SeedDemoData(ctx context.Context, store *Store, cfg Config) error {
	adminHash, err := HashPassword(cfg.DemoAdminPassword)
	if err != nil {
		return err
	}
	playerHash, err := HashPassword(cfg.DemoPlayerPassword)
	if err != nil {
		return err
	}
	if err := store.CreateUserIfMissing(ctx, "admin@example.com", adminHash, "Administrator", RoleAdmin, 50000); err != nil {
		return err
	}
	if err := store.CreateUserIfMissing(ctx, "player@example.com", playerHash, "Demo player", RoleUser, 10000); err != nil {
		return err
	}
	var hasStreams bool
	if err := store.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM streams)`).Scan(&hasStreams); err != nil {
		return err
	}
	// Never reset existing accounts, cameras or round history on startup.
	if hasStreams {
		return nil
	}
	catalog, err := DefaultCameraCatalog()
	if err != nil {
		return err
	}
	for _, camera := range catalog {
		stream, err := store.CreateStream(ctx, camera)
		if err != nil {
			return err
		}
		settings := defaultRoundSchedule(stream)
		settings.Enabled = true
		err = store.SaveRoundSchedule(ctx, stream.ID, settings)
		if err != nil {
			return err
		}
	}
	return store.RunRoundSchedules(ctx)
}
