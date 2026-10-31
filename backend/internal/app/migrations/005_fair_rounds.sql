-- Preserve old cutoffs and ledger history. The application rejects fresh bets
-- on old rounds which do not have the new observation safety gap.
ALTER TABLE bet_markets ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE bet_markets ADD CONSTRAINT market_void_reason_length CHECK (char_length(void_reason) <= 500);
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN ('opening', 'stake', 'payout', 'refund'));

-- Enforce the safety gap on new or rescheduled rounds without changing old
-- deadlines or preventing their cancellation / historical settlement.
CREATE FUNCTION enforce_market_observation_lead() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' OR NEW.betting_closes_at IS DISTINCT FROM OLD.betting_closes_at OR NEW.window_start IS DISTINCT FROM OLD.window_start THEN
  IF NEW.betting_closes_at > NEW.window_start - interval '30 seconds' THEN
   RAISE EXCEPTION 'betting must close at least 30 seconds before observation starts';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER market_observation_lead BEFORE INSERT OR UPDATE ON bet_markets FOR EACH ROW EXECUTE FUNCTION enforce_market_observation_lead();
