import { Client } from 'pg';
import { assertInvariants, startApi, TestApi } from './harness';

const GGAL = 34; // close 885.80
const buy150k = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: 150000 }; // 169 shares = 149,700.20

describe('concurrent orders for one user', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(async () => {
    await assertInvariants(api.db);
    await api.close();
  });

  const send = (body: object) => api.http().post('/users/1/orders').send(body);

  it('5 parallel BUYs with cash for 4 → exactly 4 FILLED, 1 REJECTED, available never below 0', async () => {
    // Warm the pool first, so all 5 requests really run at the same time instead of queueing on connects.
    await Promise.all(Array.from({ length: 5 }, () => api.http().get('/users/1/portfolio')));

    const results = await Promise.all(Array.from({ length: 5 }, () => send(buy150k)));

    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['FILLED', 'FILLED', 'FILLED', 'FILLED', 'REJECTED']);
    const portfolio = await api.http().get('/users/1/portfolio');
    expect(portfolio.body.cash.available).toBe('28699.20'); // 627,500 − 4 × 149,700.20
  });

  describe('while another transaction holds the user row', () => {
    let holder: Client;
    beforeEach(async () => {
      holder = new Client({ connectionString: api.url.split('?')[0] });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id = 1 FOR UPDATE');
    });
    afterEach(async () => {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    });

    it('an order waits for the lock, then completes', async () => {
      let done = false;
      const pending = send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 }).then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 1000));
      expect(done).toBe(false); // blocked on SELECT … FOR UPDATE

      await holder.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('FILLED');
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
