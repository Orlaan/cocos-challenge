-- Additive table for Idempotency-Key. docker compose and the tests create it.
-- Not applied to the provided database unless its operator runs: psql "$DATABASE_URL" -f db/local-additions.sql
-- Without it, a request with Idempotency-Key gets 501 instead of an unsafe retry.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  userid       INT          NOT NULL REFERENCES users (id),
  key          VARCHAR(255) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  response     JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);
