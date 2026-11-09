import { orderCount, startApi, TestApi } from './harness';

// Seed ids and latest closes used below.
const GGAL = 34; // 885.80
const PAMP = 47; // 925.85, user 1 holds 40
const BMA = 31; // user 1 holds −10 (seed anomaly)
const YPFD = 50; // 7837.50
const DOME = 12; // 20.50
const PGR = 3; // no market data
const ARS = 66; // MONEDA

describe('POST /users/:userId/orders', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(() => api.close()); // close() also checks the invariants

  const send = (body: object, userId = 1) => api.http().post(`/users/${userId}/orders`).send(body);
  const available = async () => (await api.http().get('/users/1/portfolio')).body.cash.available;

  describe('accepted orders', () => {
    it('MARKET BUY by size → 201 FILLED at the latest close, cash goes down', async () => {
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 10 }).expect(201);
      expect(res.body).toMatchObject({ instrumentId: GGAL, userId: 1, side: 'BUY', type: 'MARKET', size: 10, price: '885.80', status: 'FILLED' });
      expect(res.body.datetime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(await available()).toBe('618642.00'); // 627,500 − 8,858
    });

    it('MARKET BUY by amount → buys the most whole shares the amount covers', async () => {
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '10000' }).expect(201);
      expect(res.body).toMatchObject({ size: 11, price: '885.80', status: 'FILLED' }); // floor(10000 / 885.80)
    });

    it('LIMIT BUY → 201 NEW at the limit price, and its cost is held', async () => {
      const res = await send({ instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 100, price: '900' }).expect(201);
      expect(res.body).toMatchObject({ size: 100, price: '900.00', status: 'NEW' });
      expect(await available()).toBe('537500.00'); // 627,500 − 90,000
    });

    it('MARKET SELL of shares held → FILLED, cash goes up', async () => {
      const res = await send({ instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 40 }).expect(201);
      expect(res.body.status).toBe('FILLED');
      expect(await available()).toBe('664534.00'); // 627,500 + 40 × 925.85
    });

    it('LIMIT on an instrument with no market data → NEW (the limit price is enough)', async () => {
      const res = await send({ instrumentId: PGR, side: 'BUY', type: 'LIMIT', size: 1, price: '10' }).expect(201);
      expect(res.body.status).toBe('NEW');
    });
  });

  describe('business rejections are saved: 201 + REJECTED + reason', () => {
    it('BUY above available cash → INSUFFICIENT_FUNDS', async () => {
      const before = await orderCount(api.db);
      const res = await send({ instrumentId: YPFD, side: 'BUY', type: 'MARKET', size: 1000 }).expect(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS', size: 1000, price: '7837.50' });
      expect(await orderCount(api.db)).toBe(before + 1);
    });

    it('cash held by a NEW LIMIT BUY cannot be spent again', async () => {
      await send({ instrumentId: GGAL, side: 'BUY', type: 'LIMIT', size: 700, price: '885' }).expect(201); // holds 619,500
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 10 }).expect(201); // 8,858 > 8,000
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    });

    it('SELL more shares than held → INSUFFICIENT_SHARES', async () => {
      const res = await send({ instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 41 }).expect(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' });
    });

    it('shares held by a NEW LIMIT SELL cannot be sold again', async () => {
      await send({ instrumentId: PAMP, side: 'SELL', type: 'LIMIT', size: 40, price: '1000' }).expect(201);
      const res = await send({ instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 1 }).expect(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' });
    });

    it('SELL BMA, where the seed left user 1 at −10 → INSUFFICIENT_SHARES', async () => {
      const res = await send({ instrumentId: BMA, side: 'SELL', type: 'MARKET', size: 1 }).expect(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' });
    });

    it('MARKET on an instrument with no market data → NO_MARKET_PRICE', async () => {
      const res = await send({ instrumentId: PGR, side: 'BUY', type: 'MARKET', size: 1 }).expect(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', reason: 'NO_MARKET_PRICE', size: 1, price: null });
    });

    it('MARKET by amount with no market data → 400: no size can be computed, so it is not an order', async () => {
      const before = await orderCount(api.db);
      const res = await send({ instrumentId: PGR, side: 'BUY', type: 'MARKET', amount: '1000' }).expect(400);
      expect(res.body.code).toBe('AMOUNT_NEEDS_A_PRICE');
      expect(await orderCount(api.db)).toBe(before);
    });
  });

  describe('audit trail (order_events, db/local-additions.sql)', () => {
    const events = async (orderId: number) =>
      (await api.db.query('SELECT status, reason FROM order_events WHERE orderid = $1 ORDER BY id', [orderId])).rows;

    it('a REJECTED order keeps its reason in the database', async () => {
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 100000 }).expect(201);
      expect(await events(res.body.id)).toEqual([{ status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' }]);
    });

    it('a seed order cancelled now keeps its history too: NEW, then CANCELLED', async () => {
      await api.http().post('/users/1/orders/5/cancel').expect(200);
      expect(await events(5)).toEqual([{ status: 'NEW', reason: null }, { status: 'CANCELLED', reason: null }]);
    });

    it('a cancel keeps the earlier status: NEW, then CANCELLED', async () => {
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'LIMIT', size: 1, price: '800.00' }).expect(201);
      await api.http().post(`/users/1/orders/${res.body.id}/cancel`).expect(200);
      expect(await events(res.body.id)).toEqual([{ status: 'NEW', reason: null }, { status: 'CANCELLED', reason: null }]);
    });

    it('a saved order cannot be edited, only its status changes', async () => {
      const error = await api.db.query(`UPDATE orders SET price = price + 1 WHERE id = 1`).catch((e) => e);
      expect(error.message).toMatch(/only status can change/);
    });

    it('only a NEW order changes status: FILLED is final', async () => {
      const error = await api.db.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = 1`).catch((e) => e);
      expect(error.message).toMatch(/a FILLED order is final/);
    });

    it('a NEW order can only become FILLED or CANCELLED', async () => {
      const error = await api.db.query(`UPDATE orders SET status = 'REJECTED' WHERE id = 5`).catch((e) => e); // seed order 5 is NEW
      expect(error.message).toMatch(/can only be FILLED or CANCELLED/);
    });

    it('the history cannot be changed or removed', async () => {
      for (const change of ['UPDATE order_events SET status = status', 'DELETE FROM order_events']) {
        const error = await api.db.query(change).catch((e) => e);
        expect(error.message).toMatch(/append-only/);
      }
    });

    it('an UPDATE that leaves the status as it was adds no event', async () => {
      const before = await events(1);
      await api.db.query(`UPDATE orders SET status = status WHERE id = 1`);
      expect(await events(1)).toEqual(before);
    });
  });

  describe('invalid requests → 400, nothing saved', () => {
    const base = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 };
    it.each([
      ['missing side', { instrumentId: GGAL, type: 'MARKET', size: 1 }],
      ['side CASH_IN (transfers are not exposed)', { ...base, side: 'CASH_IN' }],
      ['side CASH_OUT', { ...base, side: 'CASH_OUT' }],
      ['unknown type', { ...base, type: 'STOP' }],
      ['size 0', { ...base, size: 0 }],
      ['fractional size', { ...base, size: 1.5 }],
      ['size as a string', { ...base, size: '10' }],
      ['size above the INT column', { ...base, size: 2_147_483_648 }],
      ['both size and amount', { ...base, amount: '1000' }],
      ['neither size nor amount', { instrumentId: GGAL, side: 'BUY', type: 'MARKET' }],
      ['LIMIT without price', { ...base, type: 'LIMIT' }],
      ['MARKET with price', { ...base, price: '900' }],
      ['price 0', { ...base, type: 'LIMIT', price: '0' }],
      ['price with 3 decimals', { ...base, type: 'LIMIT', price: '1.234' }],
      ['price as a JSON number (money travels as strings)', { ...base, type: 'LIMIT', price: 900 }],
      ['negative amount', { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: '-100' }],
      ['price above NUMERIC(10,2)', { ...base, type: 'LIMIT', price: '100000000' }],
      ['size null', { ...base, size: null }],
      ['amount null', { instrumentId: GGAL, side: 'BUY', type: 'MARKET', amount: null }],
      ['price null on a LIMIT', { ...base, type: 'LIMIT', price: null }],
      ['unknown field', { ...base, status: 'FILLED' }],
    ])('%s', async (_, body) => {
      const before = await orderCount(api.db);
      const res = await send(body).expect(400);
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(await orderCount(api.db)).toBe(before);
    });

    it('amount that computes a size above the INT column → AMOUNT_TOO_LARGE', async () => {
      const before = await orderCount(api.db);
      const res = await send({ instrumentId: DOME, side: 'BUY', type: 'MARKET', amount: '1000000000000' }).expect(400);
      expect(res.body.code).toBe('AMOUNT_TOO_LARGE');
      expect(await orderCount(api.db)).toBe(before);
    });

    it('amount below the price of one share → AMOUNT_BELOW_ONE_SHARE', async () => {
      const before = await orderCount(api.db);
      const res = await send({ instrumentId: YPFD, side: 'BUY', type: 'MARKET', amount: '100' }).expect(400);
      expect(res.body.code).toBe('AMOUNT_BELOW_ONE_SHARE');
      expect(await orderCount(api.db)).toBe(before);
    });

    it('BUY ARS (cash, type MONEDA) → INSTRUMENT_NOT_TRADABLE', async () => {
      const res = await send({ ...base, instrumentId: ARS }).expect(400);
      expect(res.body.code).toBe('INSTRUMENT_NOT_TRADABLE');
    });

    it('malformed JSON → 400', async () => {
      await api.http().post('/users/1/orders').set('content-type', 'application/json').send('{"side":').expect(400);
    });
  });

  describe('missing resources → 404, nothing saved', () => {
    it('unknown user', async () => {
      const res = await send({ instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 }, 999).expect(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('unknown instrument', async () => {
      const before = await orderCount(api.db);
      const res = await send({ instrumentId: 9999, side: 'BUY', type: 'MARKET', size: 1 }).expect(404);
      expect(res.body.code).toBe('INSTRUMENT_NOT_FOUND');
      expect(await orderCount(api.db)).toBe(before);
    });
  });
});
