import Decimal from 'decimal.js';
import { Sql } from './db';

// Everything a user owns is derived from the `orders` log on each read; nothing is stored twice.
// FILLED orders move cash and shares. NEW (LIMIT) orders only hold them until they are cancelled.

export interface Cash {
  balance: Decimal;
  reserved: Decimal;
  available: Decimal;
}

export async function cash(sql: Sql, userId: number): Promise<Cash> {
  const [row] = await sql<{ balance: string; reserved: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'FILLED' THEN
         CASE WHEN side IN ('CASH_IN', 'SELL') THEN size * price ELSE -size * price END END), 0) AS balance,
       COALESCE(SUM(CASE WHEN status = 'NEW' AND side = 'BUY' THEN size * price END), 0) AS reserved
     FROM orders
     WHERE userid = $1`,
    [userId],
  );
  const balance = new Decimal(row.balance);
  const reserved = new Decimal(row.reserved);
  return { balance, reserved, available: balance.minus(reserved) };
}

/** Shares the user can still sell: filled holdings minus shares held by NEW SELL orders. */
export async function availableShares(sql: Sql, userId: number, instrumentId: number): Promise<number> {
  const [row] = await sql<{ shares: number }>(
    `SELECT COALESCE(SUM(CASE
       WHEN status = 'FILLED' AND side = 'BUY' THEN size
       WHEN status IN ('FILLED', 'NEW') AND side = 'SELL' THEN -size END), 0)::int AS shares
     FROM orders
     WHERE userid = $1 AND instrumentid = $2`,
    [userId, instrumentId],
  );
  return row.shares;
}

export interface Trade {
  instrumentId: number;
  ticker: string;
  name: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: string;
}

/** FILLED BUY/SELL orders in execution order, the input of the position fold. */
export function filledTrades(sql: Sql, userId: number): Promise<Trade[]> {
  return sql<Trade>(
    `SELECT o.instrumentid AS "instrumentId", i.ticker, i.name, o.side, o.size, o.price
     FROM orders o JOIN instruments i ON i.id = o.instrumentid
     WHERE o.userid = $1 AND o.status = 'FILLED' AND o.side IN ('BUY', 'SELL')
     ORDER BY o.datetime, o.id`,
    [userId],
  );
}

export interface Quote {
  close: string;
  previousClose: string | null;
}

/** Latest close per instrument. Instruments with no market data are missing from the map. */
export async function latestQuotes(sql: Sql, instrumentIds: number[]): Promise<Map<number, Quote>> {
  const rows = await sql<Quote & { instrumentId: number }>(
    `SELECT DISTINCT ON (instrumentid) instrumentid AS "instrumentId", close, previousclose AS "previousClose"
     FROM marketdata
     WHERE instrumentid = ANY($1) AND close IS NOT NULL
     ORDER BY instrumentid, date DESC, id DESC`,
    [instrumentIds],
  );
  return new Map(rows.map((r) => [r.instrumentId, r]));
}
