import Decimal from './money';
import { Sql } from './db';
import { Problem } from './problem';

// Everything a user owns is derived from the `orders` log on each read; nothing is stored twice.
// FILLED orders move cash and shares. NEW (LIMIT) orders only hold them until they are cancelled.
// Share counts are JS numbers: sums of INT sizes, exact up to 2^53. Cash is a Decimal.

/**
 * Serialises all money decisions of one user: every order for that user waits here, until its transaction ends,
 * so "read available → decide → insert" can never interleave with another order.
 * The rule this relies on: anything that can spend a user's cash or shares takes this lock first.
 * Cancel does not need it: it only frees cash or shares.
 */
export async function lockUser(sql: Sql, userId: number): Promise<void> {
  const [user] = await sql('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  if (!user) throw new Problem(404, 'USER_NOT_FOUND');
}

export interface Cash {
  balance: Decimal;
  reserved: Decimal;
  available: Decimal;
}

export async function cash(sql: Sql, userId: number): Promise<Cash> {
  const [row] = await sql<{ balance: string; reserved: string }>(
    `SELECT -- a transfer moves size pesos, as the brief says; a trade moves size × price
       COALESCE(SUM(CASE WHEN status = 'FILLED' THEN CASE side
         WHEN 'CASH_IN' THEN size WHEN 'CASH_OUT' THEN -size WHEN 'SELL' THEN size * price WHEN 'BUY' THEN -size * price END END), 0) AS balance,
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
  const [row] = await sql<{ shares: string }>(
    `SELECT COALESCE(SUM(CASE
       WHEN status = 'FILLED' AND side = 'BUY' THEN size
       WHEN status IN ('FILLED', 'NEW') AND side = 'SELL' THEN -size END), 0) AS shares
     FROM orders
     WHERE userid = $1 AND instrumentid = $2`,
    [userId, instrumentId],
  );
  return Number(row.shares);
}

/** Shares held by NEW SELL orders, per instrument. */
export async function heldShares(sql: Sql, userId: number): Promise<Map<number, number>> {
  const rows = await sql<{ instrumentId: number; shares: string }>(
    `SELECT instrumentid AS "instrumentId", SUM(size) AS shares
     FROM orders
     WHERE userid = $1 AND status = 'NEW' AND side = 'SELL'
     GROUP BY instrumentid`,
    [userId],
  );
  return new Map(rows.map((r) => [r.instrumentId, Number(r.shares)]));
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
     ORDER BY o.id`, // under the user lock, insert order is execution order
    [userId],
  );
}
