CREATE TABLE round_schedules (
    stream_id BIGINT PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    counting_rule TEXT NOT NULL CHECK (octet_length(counting_rule) BETWEEN 1 AND 160),
    threshold INTEGER NOT NULL CHECK (threshold BETWEEN 0 AND 100000000),
    odds_over DOUBLE PRECISION NOT NULL CHECK (odds_over BETWEEN 1 AND 100),
    odds_under DOUBLE PRECISION NOT NULL CHECK (odds_under BETWEEN 1 AND 100),
    entry_minutes INTEGER NOT NULL CHECK (entry_minutes BETWEEN 1 AND 60),
    lead_seconds INTEGER NOT NULL CHECK (lead_seconds BETWEEN 30 AND 3600),
    counting_minutes INTEGER NOT NULL CHECK (counting_minutes BETWEEN 1 AND 60),
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    last_market_id BIGINT REFERENCES bet_markets(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX markets_schedule_window ON bet_markets(stream_id, window_end) WHERE status = 'open';
