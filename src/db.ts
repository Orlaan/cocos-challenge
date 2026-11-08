import { DataSource, EntityManager } from 'typeorm';
import { Problem } from './problem';

/** Runs one parameterised statement and returns its rows (also for UPDATE … RETURNING). */
export type Sql = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

export const POOL_SIZE = 10;

export function createDataSource(url: string): Promise<DataSource> {
  // SSL comes from the URL (`?sslmode=require` for Neon). The schema is never synchronised or migrated.
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
 * SET LOCAL ends with the transaction, so it is safe behind a transaction-mode pooler (PgBouncer, Neon).
 */
function bounded<T>(ds: DataSource, isolation: 'READ COMMITTED' | 'REPEATABLE READ', work: (sql: Sql) => Promise<T>) {
  return ds.transaction(isolation, async (manager) => {
    const sql = sqlFor(manager);
    await sql(`SET LOCAL lock_timeout = '3s'`);
    await sql(`SET LOCAL statement_timeout = '5s'`);
    return work(sql);
  });
}

/** One transaction (READ COMMITTED). */
export function transaction<T>(ds: DataSource, work: (sql: Sql) => Promise<T>): Promise<T> {
  return bounded(ds, 'READ COMMITTED', work);
}

/** One consistent snapshot for reads that combine several queries. */
export function snapshot<T>(ds: DataSource, work: (sql: Sql) => Promise<T>): Promise<T> {
  return bounded(ds, 'REPEATABLE READ', work);
}

/**
 * Serialises all money decisions of one user: every order for that user waits here,
 * so "read available → decide → insert" can never interleave with another order.
 */
export function withUserLock<T>(ds: DataSource, userId: number, work: (sql: Sql) => Promise<T>): Promise<T> {
  return transaction(ds, async (sql) => {
    const [user] = await sql('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user) throw new Problem(404, 'USER_NOT_FOUND');
    return work(sql);
  });
}
