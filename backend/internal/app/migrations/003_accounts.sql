-- Canonicalize existing email addresses without merging or deleting accounts.
-- If historical accounts collide, this transaction fails for an operator to
-- resolve explicitly; all existing records stay unchanged.
UPDATE users SET email=lower(btrim(email)) WHERE email<>lower(btrim(email));
CREATE UNIQUE INDEX users_email_canonical_unique ON users (lower(email));
ALTER TABLE users ADD CONSTRAINT users_email_canonical CHECK (email=lower(btrim(email)));

CREATE INDEX ledger_user_created ON credit_ledger (user_id,created_at DESC,id DESC);
