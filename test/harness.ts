import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, DATABASE_URL } from '../src/app.module';

/** Tests may only ever touch a local throwaway database. */
export function assertLocalDb(url: string) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing to run tests against non-local database host "${host}"`);
  }
}

function urlFor(database: string, query = '') {
  const url = new URL(process.env.TEST_PG_ADMIN_URL!);
  url.pathname = `/${database}`;
  url.search = query;
  return url.toString();
}

export interface TestApi {
  http: () => ReturnType<typeof request>;
  db: Client;
  ds: DataSource; // the app's own pool
  url: string;
  close: () => Promise<void>;
}

/** A fresh copy of the seed and the real app on top of it. */
export async function startApi(template: 'local' | 'provided' = 'local', urlQuery = ''): Promise<TestApi> {
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: process.env.TEST_PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  await admin.end();

  const url = urlFor(name, urlQuery);
  assertLocalDb(url);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE_URL)
    .useValue(url)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const db = new Client({ connectionString: urlFor(name) });
  await db.connect();
  return {
    http: () => request(app.getHttpServer()),
    db,
    ds: app.get(DataSource),
    url,
    close: async () => {
      await assertInvariants(db);
      await db.end();
      await app.close();
    },
  };
}

export async function orderCount(db: Client): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
}

/** Takes user 1's row lock from outside the API, so requests sent meanwhile all queue on it at once. */
export async function holdUserRow(url: string): Promise<Client> {
  const holder = new Client({ connectionString: url.split('?')[0] });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM users WHERE id = 1 FOR UPDATE');
  return holder;
}

/** Waits until `n` connections to this test database are blocked on a lock. */
export async function waitForLockWaiters(db: Client, n: number) {
  for (let tries = 0; tries < 100; tries++) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows[0].n >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Expected ${n} connections waiting on a lock`);
}

/**
 * Money invariants that must hold after every test: no user can spend cash they do not have,
 * and no user can sell shares they do not have. The seed's own BMA −10 (user 1) predates the API.
 */
export async function assertInvariants(db: Client) {
  const overspent = await db.query(`
    SELECT userid FROM (
      SELECT userid, SUM(CASE
        WHEN status = 'FILLED' AND side IN ('CASH_IN', 'SELL') THEN size * price
        WHEN status = 'FILLED' AND side IN ('CASH_OUT', 'BUY') THEN -size * price
        WHEN status = 'NEW' AND side = 'BUY' THEN -size * price
        ELSE 0 END) AS available
      FROM orders GROUP BY userid) t
    WHERE available < 0`);
  expect(overspent.rows).toEqual([]);

  const oversold = await db.query(`
    SELECT userid, instrumentid FROM orders
    WHERE side IN ('BUY', 'SELL')
    GROUP BY userid, instrumentid
    HAVING SUM(CASE
      WHEN status = 'FILLED' AND side = 'BUY' THEN size
      WHEN status IN ('FILLED', 'NEW') AND side = 'SELL' THEN -size
      ELSE 0 END) < CASE WHEN userid = 1 AND instrumentid = 31 THEN -10 ELSE 0 END`);
  expect(oversold.rows).toEqual([]);
}
