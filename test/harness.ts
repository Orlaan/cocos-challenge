import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { createDataSource } from '../src/db';

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
  close: (checkInvariants?: boolean) => Promise<void>;
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
    .overrideProvider(DataSource)
    .useFactory({ factory: () => createDataSource(url) })
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
    close: async (checkInvariants = true) => {
      if (checkInvariants) await assertInvariants(db); // every test database is checked before it goes away
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
  await holder.query('SELECT id FROM users WHERE id = 1 FOR UPDATE'); // also blocks the INSERT's foreign-key check: the worst interleaving
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
 * Money invariants, replayed over every status each order has had, in the order it happened: no user ever
 * spent cash or sold shares they did not have, counting what NEW orders held at the time (a later deposit
 * or cancel cannot hide it). Without the audit log (the provided database) only current statuses exist.
 */
const SEED_BMA_OVERSELL = 11; // seed order 11 sold 30 BMA with 20 bought, before the API existed

export async function assertInvariants(db: Client) {
  const [{ audited }] = (await db.query(`SELECT to_regclass('order_events') IS NOT NULL AS audited`)).rows;
  const history = audited ? 'SELECT id, orderid, status FROM order_events' : 'SELECT id, id AS orderid, status FROM orders';
  const { rows } = await db.query(`
    WITH holds AS ( -- what an order moves or holds while it has this status
      SELECT h.id, h.orderid, o.userid, o.instrumentid,
        CASE WHEN h.status = 'FILLED' AND o.side IN ('CASH_IN', 'SELL') THEN o.size * o.price
             WHEN h.status = 'FILLED' AND o.side IN ('CASH_OUT', 'BUY') THEN -o.size * o.price
             WHEN h.status = 'NEW' AND o.side = 'BUY' THEN -o.size * o.price ELSE 0 END AS cash,
        CASE WHEN h.status = 'FILLED' AND o.side = 'BUY' THEN o.size
             WHEN h.status IN ('FILLED', 'NEW') AND o.side = 'SELL' THEN -o.size ELSE 0 END AS shares
      FROM (${history}) h JOIN orders o ON o.id = h.orderid),
    moves AS ( -- a status change moves the difference from the order's previous status
      SELECT *, cash - COALESCE(LAG(cash) OVER w, 0) AS dcash, shares - COALESCE(LAG(shares) OVER w, 0) AS dshares
      FROM holds WINDOW w AS (PARTITION BY orderid ORDER BY id)),
    running AS (
      SELECT *, SUM(dcash) OVER (PARTITION BY userid ORDER BY id) AS available,
                SUM(dshares) OVER (PARTITION BY userid, instrumentid ORDER BY id) AS owned
      FROM moves)
    SELECT orderid, userid, available, owned FROM running
    WHERE available < 0
       OR (dshares < 0 AND owned < 0 AND orderid <> ${SEED_BMA_OVERSELL})`);
  expect(rows).toEqual([]);
}
