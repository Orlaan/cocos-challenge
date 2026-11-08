import { Client } from 'pg';
import { holdUserRow, startApi, TestApi, waitForLockWaiters } from './harness';

const GGAL = 34; // close 885.80
const METR = 54; // user 1 holds 500
const buy150k = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '150000' }; // 169 shares = 149,700.20

describe('concurrent orders for one user', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(() => api.close()); // close() also checks the invariants

  const send = (body: object) => api.http().post('/users/1/orders').send(body);

  // To see the race fail: delete `FOR UPDATE` in src/db.ts and run `npx jest test/concurrency`: 5 FILLED.
  // (The 5 still queue, on the INSERT's foreign-key check, but only after each has read the same available.)
  it('5 parallel BUYs with cash for 4 → exactly 4 FILLED, 1 REJECTED, available never below 0', async () => {
    const holder = await holdUserRow(api.url);
    const pending = Promise.all(Array.from({ length: 5 }, () => send(buy150k)));
    await waitForLockWaiters(api.db, 5); // all 5 are waiting on the same lock
    await holder.query('COMMIT');
    await holder.end();

    const statuses = (await pending).map((r) => r.body.status).sort();
    expect(statuses).toEqual(['FILLED', 'FILLED', 'FILLED', 'FILLED', 'REJECTED']);
    const portfolio = await api.http().get('/users/1/portfolio');
    expect(portfolio.body.cash.available).toBe('28699.20'); // 627,500 − 4 × 149,700.20
  });

  it('5 parallel SELLs with shares for 4 → exactly 4 FILLED, 1 REJECTED', async () => {
    const holder = await holdUserRow(api.url);
    const sell = { instrumentId: METR, side: 'SELL', type: 'MARKET', size: 120 }; // 4 × 120 ≤ 500 < 5 × 120
    const pending = Promise.all(Array.from({ length: 5 }, () => send(sell)));
    await waitForLockWaiters(api.db, 5);
    await holder.query('COMMIT');
    await holder.end();

    const results = await pending;
    expect(results.map((r) => r.body.status).sort()).toEqual(['FILLED', 'FILLED', 'FILLED', 'FILLED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')!.body.reason).toBe('INSUFFICIENT_SHARES');
  });

  it('a cancel does not wait for the user lock, and the waiting order then sees the freed cash', async () => {
    const holder = await holdUserRow(api.url);
    // 733 GGAL = 649,291.40: more than the 627,500 available, less than 627,500 + the 90,000 order 7 holds.
    const pending = send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '650000' }).then((r) => r); // supertest starts on then()
    await waitForLockWaiters(api.db, 1);
    await api.http().post('/users/1/orders/7/cancel').expect(200); // not blocked by the held lock
    await holder.query('COMMIT');
    await holder.end();

    expect((await pending).body.status).toBe('FILLED');
  });

  describe('while another transaction holds the user row', () => {
    let holder: Client;
    beforeEach(async () => (holder = await holdUserRow(api.url)));
    afterEach(async () => {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    });

    it('an order waits for the lock, then completes', async () => {
      const pending = send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 }).then((r) => r); // then() sends it
      await waitForLockWaiters(api.db, 1); // blocked on SELECT … FOR UPDATE

      await holder.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('FILLED');
    });

    it('a MARKET order that waited fills at the close published while it waited', async () => {
      const pending = send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 }).then((r) => r);
      await waitForLockWaiters(api.db, 1);
      await api.db.query(`INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES ($1, '2099-01-01', 900, 885.80)`, [GGAL]);
      await holder.query('COMMIT');
      expect((await pending).body).toMatchObject({ status: 'FILLED', price: '900.00' });
    });

    it('an order that waited is timed when it executed, after the wait; waiting orders keep lock order', async () => {
      const one = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 };
      const pending = Promise.all([send(one), send(one), send(one)]);
      await waitForLockWaiters(api.db, 3);
      const [{ released }] = (await holder.query(`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS released`)).rows;
      await holder.query('COMMIT');
      const ids = (await pending).map((r) => r.body.id);
      const { rows } = await api.db.query('SELECT id, datetime FROM orders WHERE id = ANY($1) ORDER BY datetime', [ids]);
      expect(rows.map((r) => r.id)).toEqual([...ids].sort((a, b) => a - b));
      for (const r of rows) expect(r.datetime.getTime()).toBeGreaterThan(released.getTime());
    });

    it('after 3 s of waiting → 503 BUSY with Retry-After, nothing saved', async () => {
      const before = (await api.db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body.code).toBe('BUSY');
      const after = (await api.db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      expect(after).toBe(before);
    }, 10000);

    it('another user is not blocked', async () => {
      const res = await api.http().get('/users/2/portfolio');
      expect(res.status).toBe(200);
      const order = await api.http().post('/users/2/orders').send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 });
      expect(order.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' }); // user 2 has no cash
    });
  });
});
