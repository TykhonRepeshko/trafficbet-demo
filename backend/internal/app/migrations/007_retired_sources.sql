-- Removed legacy sources can retain immutable financial history without
-- appearing in the working camera catalog or becoming restorable.
ALTER TABLE streams ADD COLUMN retired_at TIMESTAMPTZ;
ALTER TABLE streams ADD CONSTRAINT retired_source_inactive CHECK (retired_at IS NULL OR NOT is_active);
CREATE INDEX bets_market_created ON bets(market_id,created_at DESC,id DESC);
