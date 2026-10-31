-- Existing migrations are immutable. Preserve historical records on upgrades.
ALTER TABLE users ADD CONSTRAINT users_balance_nonnegative CHECK (balance_credits >= 0);
ALTER TABLE bet_markets ADD COLUMN betting_closes_at TIMESTAMPTZ;
UPDATE bet_markets SET betting_closes_at = window_start;
ALTER TABLE bet_markets ALTER COLUMN betting_closes_at SET NOT NULL;
ALTER TABLE bet_markets ADD CONSTRAINT market_close_before_observation CHECK (betting_closes_at <= window_start);
ALTER TABLE bet_markets ADD CONSTRAINT market_bounded_odds CHECK (odds_over <= 100 AND odds_under <= 100);
ALTER TABLE bets ADD CONSTRAINT bet_bounded_stake CHECK (stake_credits <= 100000);
ALTER TABLE bets ADD CONSTRAINT bet_bounded_payout CHECK (potential_payout_credits <= 10000000);
ALTER TABLE bets ADD COLUMN idempotency_key TEXT;
UPDATE bets SET idempotency_key='legacy-' || id::text;
ALTER TABLE bets ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX bets_user_idempotency_unique ON bets(user_id,idempotency_key);
ALTER TABLE bet_markets DROP CONSTRAINT bet_markets_stream_id_fkey;
ALTER TABLE bet_markets ADD CONSTRAINT bet_markets_stream_id_fkey FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE RESTRICT;
ALTER TABLE bets DROP CONSTRAINT bets_user_id_fkey;
ALTER TABLE bets ADD CONSTRAINT bets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE bets DROP CONSTRAINT bets_market_id_fkey;
ALTER TABLE bets ADD CONSTRAINT bets_market_id_fkey FOREIGN KEY (market_id) REFERENCES bet_markets(id) ON DELETE RESTRICT;
ALTER TABLE stream_metrics DROP CONSTRAINT stream_metrics_stream_id_fkey;
ALTER TABLE stream_metrics ADD CONSTRAINT stream_metrics_stream_id_fkey FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE RESTRICT;
-- A worker retry of an interval must not produce a second count.
CREATE UNIQUE INDEX metrics_interval_unique ON stream_metrics (stream_id, source, interval_start, interval_end);

CREATE TABLE auth_sessions (
 token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user ON auth_sessions(user_id, created_at DESC);
CREATE INDEX sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE credit_ledger (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 bet_id BIGINT REFERENCES bets(id) ON DELETE RESTRICT,
 market_id BIGINT REFERENCES bet_markets(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK (reason IN ('opening', 'stake', 'payout')),
 delta_credits BIGINT NOT NULL,
 balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((reason='opening' AND bet_id IS NULL) OR (reason<>'opening' AND bet_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_opening_unique ON credit_ledger(user_id) WHERE reason='opening';
CREATE UNIQUE INDEX ledger_bet_reason_unique ON credit_ledger(bet_id,reason) WHERE bet_id IS NOT NULL;
INSERT INTO credit_ledger(user_id,reason,delta_credits,balance_after)
 SELECT id,'opening',balance_credits,balance_credits FROM users;

CREATE TABLE audit_events (
 id BIGSERIAL PRIMARY KEY,
 actor_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL,
 resource_type TEXT NOT NULL,
 resource_id BIGINT,
 details JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created ON audit_events(created_at DESC);
CREATE FUNCTION reject_history_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'history is append-only'; END;
$$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
