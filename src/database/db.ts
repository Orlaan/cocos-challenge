import { DataSource, EntityManager } from 'typeorm';

/** Runs one parameterised statement and returns its rows (also for UPDATE … RETURNING). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each repository names its row type; any is only the default
export type Sql = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

export const POOL_SIZE = 10;

export function createDataSource(url: string): Promise<DataSource> {
  // SSL comes from the URL (`?sslmode=verify-full` for Neon). The schema is never synchronised or migrated.
  // A request that cannot get a pooled connection in 3 s fails fast (503) instead of queueing forever.
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    extra: { max: POOL_SIZE, connectionTimeoutMillis: 3000 },
  }).initialize();
}

function sqlFor(manager: EntityManager): Sql {
  return async (text, params) => (await manager.queryRunner!.query(text, params, true)).records;
}

/**
 * Every transaction is bounded: a lock wait over 3 s or a statement over 5 s fails (→ 503), never hangs.
 * A transaction left idle over 2 s (Node stalled between two queries) is ended by Postgres, so it cannot keep
 * a user's lock; 2 s is below the 3 s lock wait, so the order queued behind it still runs.
 * All three are transaction-local, so they work behind a transaction-mode pooler.
 * No query runs after COMMIT: src/common/problem.ts maps a released connection to 503 ("nothing saved") on that rule.
 */
export function transaction<T>(
  ds: DataSource,
  work: (sql: Sql) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
): Promise<T> {
  return ds.transaction(isolation, async (manager) => {
    const sql = sqlFor(manager);
    await sql(`SELECT set_config('lock_timeout', '3s', true), set_config('statement_timeout', '5s', true),
      set_config('idle_in_transaction_session_timeout', '2s', true)`);
    return work(sql);
  });
}
