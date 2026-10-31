-- Release video bytes without rewriting finalized capture/annotation history.
CREATE TABLE video_evidence_retirements (
 evidence_id BIGINT PRIMARY KEY REFERENCES video_evidence(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
 retired_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION finalized_evidence_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capture_status TEXT;
BEGIN
 SELECT status INTO capture_status FROM video_evidence WHERE id=NEW.evidence_id FOR UPDATE;
 IF capture_status IS NULL OR capture_status NOT IN ('ready','failed','interrupted') THEN
  RAISE EXCEPTION 'Only finalized video evidence can be retired';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_retirement_finalized BEFORE INSERT ON video_evidence_retirements FOR EACH ROW EXECUTE FUNCTION finalized_evidence_retirement();
CREATE TRIGGER evidence_retirement_immutable BEFORE UPDATE OR DELETE ON video_evidence_retirements FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
