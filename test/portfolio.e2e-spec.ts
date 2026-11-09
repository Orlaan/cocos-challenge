import { startApi, TestApi } from './harness';

describe('GET /users/:userId/portfolio', () => {
  let api: TestApi;
  beforeAll(async () => (api = await startApi()));
  afterAll(() => api.close());

  it('user 1: golden numbers from the seed (cash 753,000, NEW holds 125,500, total 889,756)', async () => {
    const res = await api.http().get('/users/1/portfolio').expect(200);
    expect(res.body).toMatchObject({
      userId: 1,
      totalValue: '889756.00',
      cash: { balance: '753000.00', reserved: '125500.00', available: '627500.00' },
    });
    const byTicker = Object.fromEntries(res.body.positions.map((p: any) => [p.ticker, p]));
    expect(Object.keys(byTicker).sort()).toEqual(['BMA', 'METR', 'PAMP']);
    expect(byTicker.PAMP).toMatchObject({ quantity: 40, marketValue: '37034.00', totalReturnPct: '-0.45', dailyReturnPct: '0.44' });
    expect(byTicker.METR).toMatchObject({ quantity: 500, marketValue: '114750.00', totalReturnPct: '-8.20', dailyReturnPct: '-1.08' });
  });

  it('user 1: the seed oversold BMA (−10); it is shown, valued, and has no total return', async () => {
    const res = await api.http().get('/users/1/portfolio').expect(200);
    const bma = res.body.positions.find((p: any) => p.ticker === 'BMA');
    expect(bma).toMatchObject({ quantity: -10, marketValue: '-15028.00', totalReturnPct: null, dailyReturnPct: '-1.15' });
  });

  it.each([2, 3, 4])('user %i: no orders → empty portfolio', async (userId) => {
    const res = await api.http().get(`/users/${userId}/portfolio`).expect(200);
    expect(res.body).toEqual({
      userId,
      totalValue: '0.00',
      unpricedInstrumentIds: [],
      cash: { balance: '0.00', reserved: '0.00', available: '0.00' },
      positions: [],
    });
  });

  it('a position with no market price → value null, left out of the total, and listed as unpriced', async () => {
    const other = await startApi();
    await other.db.query(`INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime) VALUES
      (66, 2, 1000, 1, 'CASH_IN', 'FILLED', 'MARKET', now()), (3, 2, 1, 100, 'BUY', 'FILLED', 'MARKET', now())`); // 3 = PGR
    const res = await other.http().get('/users/2/portfolio').expect(200);
    expect(res.body.totalValue).toBe('900.00'); // the cash; PGR cannot be valued
    expect(res.body.unpricedInstrumentIds).toEqual([3]);
    expect(res.body.positions).toEqual([expect.objectContaining({ ticker: 'PGR', quantity: 1, marketValue: null })]);
    await other.close();
  });

  it('a quote with no date never replaces the latest dated quote', async () => {
    const other = await startApi();
    await other.db.query(`INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES (47, NULL, 1, 1)`); // 47 = PAMP
    const res = await other.http().get('/users/1/portfolio').expect(200);
    expect(res.body.positions.find((p: any) => p.ticker === 'PAMP').marketValue).toBe('37034.00'); // 40 × 925.85
    await other.close();
  });

  it('a latest close of 0 is no price: the position is unpriced, not worth 0', async () => {
    const other = await startApi();
    await other.db.query(`INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES (54, '2099-01-01', 0, 0)`); // 54 = METR
    const res = await other.http().get('/users/1/portfolio').expect(200);
    expect(res.body.positions.find((p: any) => p.ticker === 'METR').marketValue).toBeNull();
    expect(res.body.unpricedInstrumentIds).toEqual([54]);
    await other.close();
  });

  it('unknown user → 404 USER_NOT_FOUND as problem+json', async () => {
    const res = await api.http().get('/users/999/portfolio').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'USER_NOT_FOUND' });
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])('userId "%s" → 400', async (id) => {
    await api.http().get(`/users/${id}/portfolio`).expect(400);
  });

});
