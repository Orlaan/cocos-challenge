import { DataSource, EntityManager } from 'typeorm';
import { Problem } from './problem';

/** Runs one parameterised statement and returns its rows (also for UPDATE … RETURNING). */
export type Sql = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

export function createDataSource(url: string): Promise<DataSource> {
  // SSL comes from the URL (`?sslmode=require` for Neon). The schema is never synchronised or migrated.
  return new DataSource({ type: 'postgres', url, synchronize: false, migrationsRun: false }).initialize();
}

function sqlFor(manager: EntityManager): Sql {
  return async (text, params) => (await manager.queryRunner!.query(text, params, true)).records;
}

/** One READ COMMITTED transaction with the default isolation. */
export function transaction<T>(ds: DataSource, work: (sql: Sql) => Promise<T>): Promise<T> {
  return ds.transaction((manager) => work(sqlFor(manager)));
}

/** One consistent snapshot for reads that combine several queries. */
export function snapshot<T>(ds: DataSource, work: (sql: Sql) => Promise<T>): Promise<T> {
  return ds.transaction('REPEATABLE READ', (manager) => work(sqlFor(manager)));
}

/**
 * Serialises all money decisions of one user: every order for that user waits here,
 * so "read available → decide → insert" can never interleave with another order.
 * The timeout is set first, so a stuck lock becomes a 503 after 3 s instead of a hung request.
 */
export function withUserLock<T>(ds: DataSource, userId: number, work: (sql: Sql) => Promise<T>): Promise<T> {
  return transaction(ds, async (sql) => {
    await sql(`SET LOCAL lock_timeout = '3s'`);
    const [user] = await sql('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user) throw new Problem(404, 'USER_NOT_FOUND');
    return work(sql);
  });
}
