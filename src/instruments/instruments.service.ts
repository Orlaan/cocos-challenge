import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { transaction } from '../database/db';

@Injectable()
export class InstrumentsService {
  constructor(private readonly ds: DataSource) {}

  /** Partial, case-insensitive match on ticker or name. ARS (MONEDA) is cash, not a tradable asset. */
  search(q: string) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // A transaction only to get the same timeouts as everything else (SET LOCAL is pooler-safe).
    return transaction(this.ds, (sql) => sql(
      `SELECT id, ticker, name, type
       FROM instruments
       WHERE type <> 'MONEDA' AND (ticker ILIKE $1 OR name ILIKE $1)
       ORDER BY upper(ticker) = upper($2) DESC, ticker
       LIMIT 20`,
      [pattern, q],
    ));
  }
}
