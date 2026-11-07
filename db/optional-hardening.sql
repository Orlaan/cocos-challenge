-- Optional indexes for a larger dataset. Not applied anywhere by this repo.
-- On the 11-row seed Postgres still picks sequential scans; these pay off as `orders` grows.

-- cash(), availableShares(), filledTrades(): every money read filters orders by user (and status).
CREATE INDEX orders_user_status ON orders (userid, status);

-- latestQuotes(): DISTINCT ON (instrumentid) ... ORDER BY instrumentid, date DESC.
CREATE INDEX marketdata_instrument_date ON marketdata (instrumentid, date DESC);

-- search(): ILIKE '%term%' cannot use a b-tree; trigram GIN indexes serve it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX instruments_ticker_trgm ON instruments USING gin (ticker gin_trgm_ops);
CREATE INDEX instruments_name_trgm ON instruments USING gin (name gin_trgm_ops);
