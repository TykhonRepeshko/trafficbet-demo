-- Automatic counting: one immutable outcome per round, proposed by the AI worker
-- (counted / invalid) or by the API watchdog (expired / legacy rounds).
CREATE TABLE automatic_round_results (
 market_id BIGINT PRIMARY KEY REFERENCES bet_markets(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK (outcome IN ('counted','invalid','expired')),
 vehicle_count INTEGER CHECK (vehicle_count BETWEEN 0 AND 100000000),
 reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
 worker TEXT NOT NULL CHECK (length(worker) BETWEEN 1 AND 120),
 evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((outcome='counted') = (vehicle_count IS NOT NULL))
);
CREATE TRIGGER automatic_round_results_immutable BEFORE UPDATE OR DELETE ON automatic_round_results
 FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();

-- A camera the worker cannot verify (e.g. no readable capture clock) has its
-- schedule paused by automation. Operator decisions clear the note and win.
ALTER TABLE round_schedules ADD COLUMN automation_note TEXT
 CHECK (automation_note IS NULL OR length(automation_note) BETWEEN 5 AND 300);
