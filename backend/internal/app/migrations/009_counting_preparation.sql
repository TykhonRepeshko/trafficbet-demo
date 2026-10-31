-- Immutable definitions and publication snapshots; never rewrite accepted terms.
CREATE TABLE counting_references (
 id BIGSERIAL PRIMARY KEY,
 stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
 source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint)=64),
 image_sha256 TEXT NOT NULL CHECK (length(image_sha256)=64),
 image_png BYTEA NOT NULL CHECK (octet_length(image_png) BETWEEN 1 AND 1048576),
 width INTEGER NOT NULL CHECK (width BETWEEN 32 AND 1920),
 height INTEGER NOT NULL CHECK (height BETWEEN 32 AND 1080),
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE counting_profiles (
 id BIGSERIAL PRIMARY KEY,
 stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK (version>0),
 reference_id BIGINT NOT NULL REFERENCES counting_references(id) ON DELETE RESTRICT,
 source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint)=64),
 definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object'),
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(stream_id,version), UNIQUE(id,stream_id)
);
CREATE TABLE counting_selections (
 stream_id BIGINT PRIMARY KEY REFERENCES streams(id) ON DELETE RESTRICT,
 profile_id BIGINT NOT NULL,
 approved_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 approval_note TEXT NOT NULL CHECK (length(approval_note) BETWEEN 20 AND 2000),
 approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(profile_id,stream_id) REFERENCES counting_profiles(id,stream_id)
);
CREATE TABLE round_counting_snapshots (
 market_id BIGINT PRIMARY KEY REFERENCES bet_markets(id) ON DELETE RESTRICT,
 profile_id BIGINT REFERENCES counting_profiles(id) ON DELETE RESTRICT,
 snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION immutable_counting_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Counting evidence and publication snapshots are immutable'; END;
$$;
CREATE TRIGGER counting_profiles_immutable BEFORE UPDATE OR DELETE ON counting_profiles FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();
CREATE TRIGGER counting_references_immutable BEFORE UPDATE OR DELETE ON counting_references FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();
CREATE TRIGGER round_snapshots_immutable BEFORE UPDATE OR DELETE ON round_counting_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();

CREATE FUNCTION snapshot_round_counting_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p counting_profiles%ROWTYPE; current_fingerprint TEXT;
BEGIN
 SELECT encode(sha256(convert_to(stream_type,'UTF8') || decode('00','hex') || convert_to(stream_url,'UTF8')),'hex')
 INTO current_fingerprint FROM streams WHERE id=NEW.stream_id;
 SELECT c.* INTO p FROM counting_profiles c JOIN counting_selections a ON a.profile_id=c.id
 WHERE a.stream_id=NEW.stream_id AND c.source_fingerprint=current_fingerprint;
 INSERT INTO round_counting_snapshots(market_id,profile_id,snapshot)
 VALUES(NEW.id,p.id, jsonb_build_object('mode',CASE WHEN p.id IS NULL THEN 'legacy_manual' ELSE 'versioned' END,
   'profileId',p.id,'version',p.version,'referenceId',p.reference_id,'sourceFingerprint',current_fingerprint,
   'definition',p.definition,'publishedTitle',NEW.title,'intervalConvention','[start,end)'));
 RETURN NEW;
END;
$$;
CREATE TRIGGER snapshot_round_counting AFTER INSERT ON bet_markets FOR EACH ROW EXECUTE FUNCTION snapshot_round_counting_rules();
-- Historical source/time provenance is unknown; do not invent a verified profile.
INSERT INTO round_counting_snapshots(market_id,snapshot)
 SELECT id,jsonb_build_object('mode','legacy_unverified','publishedTitle',title,'intervalConvention','legacy_manual') FROM bet_markets;

CREATE TABLE source_observations (
 id BIGSERIAL PRIMARY KEY,
 stream_id BIGINT NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
 source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint)=64),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 report JSONB NOT NULL CHECK (jsonb_typeof(report)='object' AND octet_length(report::text)<=65536)
);
CREATE INDEX source_observations_stream_time ON source_observations(stream_id,observed_at DESC,id DESC);
CREATE TABLE round_reviews (
 id BIGSERIAL PRIMARY KEY,
 market_id BIGINT NOT NULL REFERENCES bet_markets(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK (outcome IN ('needs_review','verified','invalid')),
 proposed_count INTEGER CHECK (proposed_count BETWEEN 0 AND 100000000),
 verification JSONB NOT NULL,
 evidence_note TEXT NOT NULL CHECK (length(evidence_note) BETWEEN 20 AND 2000),
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX round_reviews_market ON round_reviews(market_id,id DESC);
CREATE TRIGGER round_reviews_immutable BEFORE UPDATE OR DELETE ON round_reviews FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();
