import { assertInvariants, startApi, TestApi } from './harness';

// Seed orders of user 1: 5 = NEW LIMIT BUY LOMA (holds 35,500), 2 = FILLED, 6 = REJECTED, 3 = CANCELLED.
describe('POST /users/:userId/orders/:orderId/cancel', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(async () => {
    await assertInvariants(api.db);
    await api.close();
  });

  const cancel = (orderId: number, userId = 1) => api.http().post(`/users/${userId}/orders/${orderId}/cancel`);

  it('NEW → 200 CANCELLED, and its held cash is available again', async () => {
    const res = await cancel(5).expect(200);
    expect(res.body).toMatchObject({ id: 5, status: 'CANCELLED' });
    const portfolio = await api.http().get('/users/1/portfolio');
    expect(portfolio.body.cash).toMatchObject({ reserved: '90000.00', available: '663000.00' });
  });

  it('cancelling a NEW SELL frees its shares: all of them can be sold again', async () => {
    const PAMP = 47; // user 1 holds 40
    const sell = await api.http().post('/users/1/orders').send({ instrumentId: PAMP, side: 'SELL', type: 'LIMIT', size: 40, price: '2000.00' });
    expect(sell.body.status).toBe('NEW');
    await cancel(sell.body.id).expect(200);
    const pamp = (await api.http().get('/users/1/portfolio')).body.positions.find((p: any) => p.ticker === 'PAMP');
    expect(pamp).toMatchObject({ quantity: 40, reservedQuantity: 0, availableQuantity: 40 });
    const market = await api.http().post('/users/1/orders').send({ instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 40 });
    expect(market.body.status).toBe('FILLED');
  });

  it('cancelling twice → 409 the second time', async () => {
    await cancel(5).expect(200);
    const res = await cancel(5).expect(409);
    expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it.each([
    [2, 'FILLED'],
    [6, 'REJECTED'],
    [3, 'CANCELLED'],
  ])('order %i (%s) → 409, unchanged', async (orderId, status) => {
    await cancel(orderId).expect(409);
    const { rows } = await api.db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0].status).toBe(status);
  });

  it("another user's order → 404 ORDER_NOT_FOUND (no hint that it exists)", async () => {
    const res = await cancel(5, 2).expect(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('unknown order → 404 ORDER_NOT_FOUND', async () => {
    expect((await cancel(9999).expect(404)).body.code).toBe('ORDER_NOT_FOUND');
  });

  it('unknown user → 404 USER_NOT_FOUND', async () => {
    expect((await cancel(5, 999).expect(404)).body.code).toBe('USER_NOT_FOUND');
  });
});
