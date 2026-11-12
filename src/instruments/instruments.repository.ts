import { Sql } from '../database/db';

export interface Instrument {
  id: number;
  ticker: string;
  name: string;
  type: string;
}

/** Partial, case-insensitive match on ticker or name; exact ticker first. ARS (MONEDA) is cash, not a tradable asset. */
export function search(sql: Sql, q: string): Promise<Instrument[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql<Instrument>(
    `SELECT id, ticker, name, type
     FROM instruments
     WHERE type <> 'MONEDA' AND (ticker ILIKE $1 OR name ILIKE $1)
     ORDER BY upper(ticker) = upper($2) DESC, ticker
     LIMIT 20`,
    [pattern, q],
  );
}
