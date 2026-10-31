-- Add inclusive custom ranges without changing historical over/under predictions.
ALTER TABLE bets DROP CONSTRAINT bets_side_check;
ALTER TABLE bets ADD CONSTRAINT bets_side_check CHECK (side IN ('over','under','range'));
ALTER TABLE bets ADD COLUMN range_min INTEGER;
ALTER TABLE bets ADD COLUMN range_max INTEGER;
ALTER TABLE bets ADD COLUMN range_odds DOUBLE PRECISION;
ALTER TABLE bets ADD COLUMN pricing_model TEXT;
ALTER TABLE bets ADD CONSTRAINT bets_range_terms CHECK (
 (side='range' AND range_min IS NOT NULL AND range_max IS NOT NULL AND range_odds IS NOT NULL AND pricing_model IS NOT NULL
  AND range_min BETWEEN 0 AND 100000000 AND range_max BETWEEN range_min AND 100000000
  AND range_odds BETWEEN 1 AND 100 AND abs(range_odds*100-round(range_odds*100))<0.000001
  AND pricing_model='demo_geometric_v1')
 OR (side<>'range' AND range_min IS NULL AND range_max IS NULL AND range_odds IS NULL AND pricing_model IS NULL)
);

CREATE FUNCTION protect_prediction_terms() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'status'-'settled_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'settled_at') THEN
  RAISE EXCEPTION 'accepted prediction terms are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER prediction_terms_immutable BEFORE UPDATE ON bets FOR EACH ROW EXECUTE FUNCTION protect_prediction_terms();
