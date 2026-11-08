-- Additive changes; database.sql is not touched. docker compose and the tests apply this file.
-- Not applied to the provided database unless its operator runs: psql "$DATABASE_URL" -f db/local-additions.sql

-- Idempotency-Key. Without this table, a request with the header gets 501 instead of an unsafe retry.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  userid       INT          NOT NULL REFERENCES users (id),
  key          VARCHAR(255) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  response     JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);

-- Audit trail: every status an order takes, with the reason of a rejection. A trigger writes it, so a
-- change made outside the API (ops running SQL) is recorded too. The API passes the reason in the
-- transaction-local setting app.order_reason. Without this, the reason is only in the response and the log.
CREATE TABLE IF NOT EXISTS order_events (
  id      SERIAL      PRIMARY KEY,
  orderid INT         NOT NULL REFERENCES orders (id),
  status  VARCHAR(10) NOT NULL,
  reason  VARCHAR(30),
  at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- The log starts with the status every existing order has now (the seed predates this file).
INSERT INTO order_events (orderid, status, at)
SELECT id, status, datetime AT TIME ZONE 'UTC' FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.orderid = o.id);

CREATE OR REPLACE FUNCTION record_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO order_events (orderid, status, reason)
  VALUES (NEW.id, NEW.status, NULLIF(current_setting('app.order_reason', true), ''));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS order_events ON orders;
CREATE TRIGGER order_events AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION record_order_event();
