import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Sql } from '../db';
import { Problem } from '../problem';
import type { PlaceOrder } from './order.dto';

/**
 * Idempotency-Key support, stored in `idempotency_keys` (db/local-additions.sql).
 * Lookups run inside the user lock, so two requests with the same key can never both insert.
 * The table is an additive change (db/local-additions.sql). On a database without it (the provided one),
 * a request with the header gets 501: the API never pretends a retry is safe.
 */
@Injectable()
export class Idempotency {
  private tableExists = false; // once seen, it stays: the check runs only until the table appears

  constructor(private readonly ds: DataSource) {}

  async available(): Promise<boolean> {
    if (!this.tableExists) {
      const [row] = await this.ds.query(`SELECT to_regclass('idempotency_keys') IS NOT NULL AS exists`);
      this.tableExists = row.exists;
    }
    return this.tableExists;
  }

  /** The stored response for a repeated key, or null for a new key. Same key with another body → 422. */
  async replay<T>(sql: Sql, userId: number, key: string, order: PlaceOrder): Promise<T | null> {
    const [row] = await sql<{ requestHash: string; response: T }>(
      `SELECT request_hash AS "requestHash", response FROM idempotency_keys WHERE userid = $1 AND key = $2`,
      [userId, key],
    );
    if (!row) return null;
    if (row.requestHash !== hash(order)) throw new Problem(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was used with another request body');
    return row.response;
  }

  async save(sql: Sql, userId: number, key: string, order: PlaceOrder, response: object) {
    await sql(`INSERT INTO idempotency_keys (userid, key, request_hash, response) VALUES ($1, $2, $3, $4)`, [
      userId,
      key,
      hash(order),
      response,
    ]);
  }
}

function hash(o: PlaceOrder): string {
  const fields = [o.instrumentId, o.side, o.type, o.size ?? null, o.amount ?? null, o.price ?? null];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
