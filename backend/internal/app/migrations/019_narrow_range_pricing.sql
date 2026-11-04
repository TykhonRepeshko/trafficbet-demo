-- Preserve every accepted v1 prediction while permitting the new capped quote rule.
ALTER TABLE bets DROP CONSTRAINT bets_range_terms;
ALTER TABLE bets ADD CONSTRAINT bets_range_terms CHECK (
 (side='range' AND range_min IS NOT NULL AND range_max IS NOT NULL AND range_odds IS NOT NULL AND pricing_model IS NOT NULL
  AND range_min BETWEEN 0 AND 100000000 AND range_max BETWEEN range_min AND 100000000
  AND abs(range_odds*100-round(range_odds*100))<0.000001
  AND ((pricing_model='demo_geometric_v1' AND range_odds BETWEEN 1 AND 100)
    OR (pricing_model='demo_normal_v2' AND range_odds BETWEEN 1 AND 10)))
 OR (side<>'range' AND range_min IS NULL AND range_max IS NULL AND range_odds IS NULL AND pricing_model IS NULL)
);
