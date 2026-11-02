-- Live AI progress for a round while it is being counted. Display only: the
-- immutable automatic_round_results row remains the sole settlement input.
CREATE TABLE round_live_counts (
 market_id BIGINT PRIMARY KEY REFERENCES bet_markets(id) ON DELETE RESTRICT,
 vehicle_count INTEGER NOT NULL CHECK (vehicle_count BETWEEN 0 AND 100000000),
 progress JSONB NOT NULL CHECK (jsonb_typeof(progress)='object' AND octet_length(progress::text)<=65536),
 processed_until TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
