-- Additive table for Idempotency-Key. Created by docker compose and the tests only.
-- It is NOT applied to the provided database; without it the API ignores the header.
CREATE TABLE idempotency_keys (
  userid       INT          NOT NULL REFERENCES users (id),
  key          VARCHAR(255) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  response     JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);
