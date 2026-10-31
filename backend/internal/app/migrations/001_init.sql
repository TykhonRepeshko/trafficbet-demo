CREATE TABLE IF NOT EXISTS users (
	id BIGSERIAL PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
	balance_credits BIGINT NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS streams (
	id BIGSERIAL PRIMARY KEY,
	title TEXT NOT NULL,
	city TEXT NOT NULL,
	country TEXT NOT NULL,
	location_label TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	stream_type TEXT NOT NULL CHECK (stream_type IN ('hls', 'youtube', 'iframe', 'rtsp', 'image', 'mjpeg')),
	stream_url TEXT NOT NULL,
	thumbnail_url TEXT NOT NULL DEFAULT '',
	source_owner TEXT NOT NULL DEFAULT '',
	source_page_url TEXT NOT NULL DEFAULT '',
	terms_url TEXT NOT NULL DEFAULT '',
	usage_notes TEXT NOT NULL DEFAULT '',
	latitude DOUBLE PRECISION,
	longitude DOUBLE PRECISION,
	is_active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bet_markets (
	id BIGSERIAL PRIMARY KEY,
	stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	threshold INTEGER NOT NULL CHECK (threshold >= 0),
	window_start TIMESTAMPTZ NOT NULL,
	window_end TIMESTAMPTZ NOT NULL,
	odds_over DOUBLE PRECISION NOT NULL CHECK (odds_over >= 1),
	odds_under DOUBLE PRECISION NOT NULL CHECK (odds_under >= 1),
	status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'settled', 'void')),
	actual_count INTEGER CHECK (actual_count >= 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CHECK (window_end > window_start)
);

CREATE TABLE IF NOT EXISTS bets (
	id BIGSERIAL PRIMARY KEY,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	market_id BIGINT NOT NULL REFERENCES bet_markets(id) ON DELETE CASCADE,
	side TEXT NOT NULL CHECK (side IN ('over', 'under')),
	stake_credits BIGINT NOT NULL CHECK (stake_credits > 0),
	potential_payout_credits BIGINT NOT NULL CHECK (potential_payout_credits > 0),
	status TEXT NOT NULL CHECK (status IN ('pending', 'won', 'lost', 'void')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	settled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stream_metrics (
	id BIGSERIAL PRIMARY KEY,
	stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
	source TEXT NOT NULL CHECK (source IN ('manual', 'ai')),
	vehicle_count INTEGER NOT NULL CHECK (vehicle_count >= 0),
	interval_start TIMESTAMPTZ NOT NULL,
	interval_end TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CHECK (interval_end > interval_start)
);

CREATE TABLE IF NOT EXISTS ai_detections (
	id BIGSERIAL PRIMARY KEY,
	stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
	frame_ts TIMESTAMPTZ NOT NULL,
	vehicle_type TEXT NOT NULL,
	confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
	bbox JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_streams_active ON streams (is_active);
CREATE INDEX IF NOT EXISTS idx_markets_stream_status ON bet_markets (stream_id, status);
CREATE INDEX IF NOT EXISTS idx_bets_user_created ON bets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_stream_created ON stream_metrics (stream_id, created_at DESC);
