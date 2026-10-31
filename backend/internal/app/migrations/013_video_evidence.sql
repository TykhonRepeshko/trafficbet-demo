CREATE TABLE video_evidence (
 id BIGSERIAL PRIMARY KEY,
 stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
 profile_id BIGINT NOT NULL REFERENCES counting_profiles(id) ON DELETE RESTRICT,
 source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
 counting_rules JSONB NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('queued','capturing','processing','ready','failed','interrupted')),
 requested_seconds INTEGER NOT NULL CHECK (requested_seconds BETWEEN 30 AND 900),
 duration_ms BIGINT NOT NULL DEFAULT 0,
 clip_sha256 TEXT,
 byte_count BIGINT NOT NULL DEFAULT 0 CHECK (byte_count>=0),
 quality JSONB NOT NULL,
 error_code TEXT NOT NULL DEFAULT '',
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ,
 CHECK (clip_sha256 IS NULL OR clip_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX video_evidence_queue ON video_evidence(status,id);
ALTER TABLE evaluation_intervals ADD COLUMN evidence_id BIGINT REFERENCES video_evidence(id) ON DELETE RESTRICT;
ALTER TABLE round_reviews ADD COLUMN evidence_id BIGINT REFERENCES video_evidence(id) ON DELETE RESTRICT;
CREATE FUNCTION finalized_video_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('ready','failed','interrupted') THEN
  RAISE EXCEPTION 'Finalized video evidence is immutable';
 END IF;
 IF NEW.stream_id<>OLD.stream_id OR NEW.profile_id<>OLD.profile_id OR NEW.source_fingerprint<>OLD.source_fingerprint
 OR NEW.counting_rules<>OLD.counting_rules OR NEW.requested_seconds<>OLD.requested_seconds
 OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Evidence capture identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER video_evidence_immutable BEFORE UPDATE OR DELETE ON video_evidence FOR EACH ROW EXECUTE FUNCTION finalized_video_evidence_immutable();
