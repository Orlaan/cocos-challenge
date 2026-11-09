import { Sql } from './db';

export interface Quote {
  close: string;
  previousClose: string | null;
}

/**
 * The latest close per instrument. An instrument with no market data, or whose latest close is not positive,
 * is missing from the map: it has no usable price (never an older one).
 */
export async function latestQuotes(sql: Sql, instrumentIds: number[]): Promise<Map<number, Quote>> {
  const rows = await sql<Quote & { instrumentId: number }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (instrumentid) instrumentid AS "instrumentId", close, previousclose AS "previousClose"
       FROM marketdata
       WHERE instrumentid = ANY($1)
       ORDER BY instrumentid, date DESC NULLS LAST, id DESC
     ) latest
     WHERE close > 0`,
    [instrumentIds],
  );
  return new Map(rows.map((r) => [r.instrumentId, r]));
}
