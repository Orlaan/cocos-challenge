import { Client } from 'pg';
import * as ledger from '../src/ledger.repository';
import Decimal from '../src/money';
import { holdUserRow, startApi, TestApi, waitForLockWaiters } from './harness';

const GGAL = 34; // close 885.80
const METR = 54; // user 1 holds 500
const buy150k = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '150000' }; // 169 shares = 149,700.20

describe('concurrent orders for one user', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(() => api.close()); // close() also checks the invariants

  const send = (body: object) => api.http().post('/users/1/orders').send(body);
  const fire = (body: object) => send(body).then((r) => r); // supertest sends only on then(): this starts it now

  // To see the race fail: delete the `lockUser` call in src/orders/orders.service.ts and run `npx jest test/concurrency`: 5 FILLED.
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

  it('LIMIT and MARKET mixed, in parallel: reservations count, exactly as if sent one by one', async () => {
    const holder = await holdUserRow(api.url);
    const limit = { instrumentId: GGAL, side: 'BUY', type: 'LIMIT', size: 169, price: '885.80' }; // holds 149,700.20
    const pending = Promise.all([send(limit), send(buy150k), send(limit), send(buy150k), send(limit)]);
    await waitForLockWaiters(api.db, 5);
    await holder.query('COMMIT');
    await holder.end();

    const statuses = (await pending).map((r) => r.body.status);
    expect(statuses.filter((s) => s === 'REJECTED')).toHaveLength(1); // cash for 4 of 5
    const { cash } = (await api.http().get('/users/1/portfolio')).body;
    const limitsHeld = statuses.filter((s, i) => s === 'NEW' && i % 2 === 0).length;
    expect(cash.reserved).toBe(new Decimal('149700.20').times(limitsHeld).plus(125500).toFixed(2));
    expect(cash.available).toBe('28699.20'); // 627,500 − 4 × 149,700.20, filled or held
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

  it('LIMIT and MARKET SELLs mixed, in parallel: held shares count, exactly as if sent one by one', async () => {
    const holder = await holdUserRow(api.url);
    const limit = { instrumentId: METR, side: 'SELL', type: 'LIMIT', size: 120, price: '99999.00' }; // never fills: holds 120
    const market = { instrumentId: METR, side: 'SELL', type: 'MARKET', size: 120 };
    const pending = Promise.all([send(limit), send(market), send(limit), send(market), send(limit)]);
    await waitForLockWaiters(api.db, 5);
    await holder.query('COMMIT');
    await holder.end();

    const results = await pending;
    // 500 shares cover 4 × 120: the fifth is rejected only if the NEW SELLs' held shares count.
    expect(results.filter((r) => r.body.status === 'REJECTED').map((r) => r.body.reason)).toEqual(['INSUFFICIENT_SHARES']);
  });

  it('a cancel does not wait for the user lock, and the waiting order then sees the freed cash', async () => {
    const holder = await holdUserRow(api.url);
    // 733 GGAL = 649,291.40: more than the 627,500 available, less than 627,500 + the 90,000 order 7 holds.
    const pending = fire({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '650000' });
    await waitForLockWaiters(api.db, 1);
    await api.http().post('/users/1/orders/7/cancel').expect(200); // not blocked by the held lock
    await holder.query('COMMIT');
    await holder.end();

    expect((await pending).body.status).toBe('FILLED');
  });

  it('a cancel that lands after a waiting order read its cash: the order rejects, it never spends the freed cash', async () => {
    let readCash!: () => void;
    let resume!: () => void;
    const hasRead = new Promise<void>((r) => (readCash = r));
    const cancelled = new Promise<void>((r) => (resume = r));
    const real = ledger.cash;
    // Replacing a module export works because ts-jest compiles to CommonJS (orders.service.ts calls ledger_repository_1.cash).
    jest.spyOn(ledger, 'cash').mockImplementationOnce(async (...args) => {
      const seen = await real(...args); // 627,500 available: order 7 still holds 90,000
      readCash();
      await cancelled;
      return seen;
    });
    const big = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '650000' }; // needs the 90,000 too
    const pending = fire(big);
    await hasRead;
    await api.http().post('/users/1/orders/7/cancel').expect(200);
    resume();

    expect((await pending).body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect((await send(big)).body.status).toBe('FILLED'); // sent again, it sees the freed cash
  });

  it('two parallel cancels of one NEW order → one 200, one 409, its cash freed once', async () => {
    const holder = new Client({ connectionString: api.url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE id = 5 FOR UPDATE'); // seed order 5: NEW LIMIT BUY, holds 35,500
    const cancel = () => api.http().post('/users/1/orders/5/cancel');
    const pending = Promise.all([cancel(), cancel()]);
    await waitForLockWaiters(api.db, 2); // both UPDATEs wait on the order row
    await holder.query('COMMIT');
    await holder.end();

    // The second UPDATE re-checks `status = 'NEW'` after the first commits, matches nothing: 409.
    const [won, lost] = (await pending).sort((a, b) => a.status - b.status);
    expect(won.body).toMatchObject({ id: 5, status: 'CANCELLED' });
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe('ORDER_NOT_CANCELLABLE');
    const events = await api.db.query('SELECT status FROM order_events WHERE orderid = 5 ORDER BY id');
    expect(events.rows).toEqual([{ status: 'NEW' }, { status: 'CANCELLED' }]);
    const { cash } = (await api.http().get('/users/1/portfolio')).body;
    expect(cash.available).toBe('663000.00'); // 627,500 + 35,500, once
  });

  describe('while another transaction holds the user row', () => {
    let holder: Client;
    beforeEach(async () => (holder = await holdUserRow(api.url)));
    afterEach(async () => {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    });

    it('a MARKET order that waited fills at the close published while it waited', async () => {
      const pending = fire({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 });
      await waitForLockWaiters(api.db, 1);
      await api.db.query(`INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES ($1, '2099-01-01', 900, 885.80)`, [
        GGAL,
      ]);
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
      const started = Date.now();
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 });
      expect(Date.now() - started).toBeLessThan(4500); // lock_timeout (3 s), not statement_timeout (5 s)
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
