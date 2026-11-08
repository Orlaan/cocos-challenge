-- Additive changes; database.sql is not touched. docker compose and the tests apply this file.
-- Not applied to the provided database unless its operator runs: psql "$DATABASE_URL" -f db/local-additions.sql

BEGIN;
-- No order is written while this runs, so the backfill and the trigger cannot miss one.
-- If a long transaction holds orders, give up after 5 s instead of blocking every order behind this.
SET LOCAL lock_timeout = '5s';
LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;

-- Idempotency-Key. Without this table, a request with the header gets 501 instead of an unsafe retry.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  userid       INT          NOT NULL REFERENCES users (id),
  key          VARCHAR(255) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  response     JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, key)
);
-- Keys are kept: one row per keyed order. At scale, a daily job can delete old ones (a deleted key works as new):
--   DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';

-- Audit trail: every status an order takes, with the reason of a rejection. A trigger writes it, so a
-- change made outside the API (ops running SQL) is recorded too. The API passes the reason in the
-- transaction-local setting app.order_reason. Without this, the reason is only in the response and the log.
CREATE TABLE IF NOT EXISTS order_events (
  id      SERIAL      PRIMARY KEY,
  orderid INT         NOT NULL REFERENCES orders (id),
  status  VARCHAR(20) NOT NULL, -- as wide as orders.status
  reason  VARCHAR(30),
  at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- The log starts with the status every existing order has now (the seed predates this file).
INSERT INTO order_events (orderid, status, at)
SELECT id, status, datetime AT TIME ZONE 'UTC' FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.orderid = o.id);

CREATE OR REPLACE FUNCTION record_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.instrumentid, NEW.userid, NEW.size, NEW.price, NEW.type, NEW.side, NEW.datetime)
      IS DISTINCT FROM (OLD.instrumentid, OLD.userid, OLD.size, OLD.price, OLD.type, OLD.side, OLD.datetime) THEN
    RAISE EXCEPTION 'orders are a legal record: only status can change (order %)', OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF; -- no change, no event
  INSERT INTO order_events (orderid, status, reason)
  VALUES (NEW.id, NEW.status, NULLIF(current_setting('app.order_reason', true), ''));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS order_events ON orders;
CREATE TRIGGER order_events AFTER INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION record_order_event();

COMMIT;
