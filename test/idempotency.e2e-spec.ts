import { assertInvariants, orderCount, startApi, TestApi } from './harness';

const GGAL = 34;
const YPFD = 50;
const order = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 };

describe('Idempotency-Key on POST /users/:userId/orders', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi('local')));
  afterEach(async () => {
    await assertInvariants(api.db);
    await api.close();
  });

  const send = (body: object, key?: string, userId = 1) => {
    const req = api.http().post(`/users/${userId}/orders`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('5 parallel retries with one key → one order; the others replay the same response', async () => {
    const before = await orderCount(api.db);
    const results = await Promise.all(Array.from({ length: 5 }, () => send(order, 'retry-1')));
    expect(await orderCount(api.db)).toBe(before + 1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
  });

  it('a replayed REJECTED order keeps its reason', async () => {
    const reject = { instrumentId: YPFD, side: 'BUY', type: 'MARKET', size: 1000 };
    const first = await send(reject, 'big-buy').expect(201);
    const again = await send(reject, 'big-buy').expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.body.reason).toBe('INSUFFICIENT_FUNDS');
  });

  it('same key with another body → 422 IDEMPOTENCY_KEY_REUSED, nothing saved', async () => {
    await send(order, 'k').expect(201);
    const before = await orderCount(api.db);
    const res = await send({ ...order, size: 2 }, 'k').expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await orderCount(api.db)).toBe(before);
  });

  it('keys are per user: the same key for another user is a new request', async () => {
    await send(order, 'shared').expect(201);
    const res = await send(order, 'shared', 2).expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('no key → every request is a new order', async () => {
    const before = await orderCount(api.db);
    await send(order).expect(201);
    await send(order).expect(201);
    expect(await orderCount(api.db)).toBe(before + 2);
  });

  it('a 400 stores no key, so the corrected retry is processed', async () => {
    await send({ ...order, size: 0 }, 'fix-me').expect(400);
    const res = await send(order, 'fix-me').expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('key longer than 255 characters → 400', async () => {
    await send(order, 'x'.repeat(256)).expect(400);
  });
});
