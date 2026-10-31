CREATE TABLE evaluation_intervals (
 id BIGSERIAL PRIMARY KEY,
 profile_id BIGINT NOT NULL REFERENCES counting_profiles(id) ON DELETE RESTRICT,
 clip_sha256 TEXT NOT NULL CHECK (clip_sha256 ~ '^[a-f0-9]{64}$'),
 dataset_split TEXT NOT NULL CHECK (dataset_split IN ('tuning','test')),
 annotation JSONB NOT NULL CHECK (jsonb_typeof(annotation)='object' AND octet_length(annotation::text)<=65536),
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_intervals_clip ON evaluation_intervals(clip_sha256);
CREATE TRIGGER evaluation_intervals_immutable BEFORE UPDATE OR DELETE ON evaluation_intervals FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();
CREATE TABLE evaluation_reviews (
 id BIGSERIAL PRIMARY KEY,
 interval_id BIGINT NOT NULL REFERENCES evaluation_intervals(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK (outcome IN ('accepted','disputed','unverifiable')),
 note TEXT NOT NULL CHECK (length(note) BETWEEN 20 AND 2000),
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER evaluation_reviews_immutable BEFORE UPDATE OR DELETE ON evaluation_reviews FOR EACH ROW EXECUTE FUNCTION immutable_counting_record();
