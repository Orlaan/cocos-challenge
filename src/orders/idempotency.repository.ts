import { createHash } from 'node:crypto';
import { Sql } from '../database/db';
import Decimal from '../money';
import { Problem } from '../common/problem';
import type { PlaceOrder } from './order.dto';

// Idempotency-Key support, stored in `idempotency_keys` (db/local-additions.sql).
// Both functions run inside the user lock, so two requests with the same key can never both insert.
// On a database without the table (the provided one), a request with the header gets 501:
// the API never pretends a retry is safe.

/** The stored response for a repeated key, or null for a new key. Same key with another body → 422. */
export async function replay<T>(sql: Sql, userId: number, key: string, order: PlaceOrder): Promise<T | null> {
  const [row] = await sql<{ requestHash: string; response: T }>(
    `SELECT request_hash AS "requestHash", response FROM idempotency_keys WHERE userid = $1 AND key = $2`,
    [userId, key],
  ).catch((error) => {
    // 42P01 = undefined table. The transaction rolls back: nothing is saved.
    if (error.code === '42P01') throw new Problem(501, 'IDEMPOTENCY_UNAVAILABLE', 'Idempotency-Key needs db/local-additions.sql on this database');
    throw error;
  });
  if (!row) return null;
  if (row.requestHash !== hash(order)) throw new Problem(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was used with another request body');
  return row.response;
}

export async function save(sql: Sql, userId: number, key: string, order: PlaceOrder, response: object) {
  await sql(`INSERT INTO idempotency_keys (userid, key, request_hash, response) VALUES ($1, $2, $3, $4)`, [
    userId,
    key,
    hash(order),
    response,
  ]);
}

// "10000" and "10000.00" are the same order, so money is hashed in one spelling.
const canonical = (x?: string) => (x === undefined ? null : new Decimal(x).toFixed(2));

function hash(o: PlaceOrder): string {
  const fields = [o.instrumentId, o.side, o.type, o.size ?? null, canonical(o.amount), canonical(o.price)];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
