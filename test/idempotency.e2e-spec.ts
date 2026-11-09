import request from 'supertest';
import { appOn, dropAfterCommit, holdUserRow, orderCount, startApi, TestApi, waitForLockWaiters } from './harness';

const GGAL = 34;
const YPFD = 50;
const order = { instrumentId: GGAL, side: 'BUY', type: 'MARKET', size: 1 };

describe('Idempotency-Key on POST /users/:userId/orders', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi('local')));
  afterEach(() => api.close()); // close() also checks the invariants

  const send = (body: object, key?: string, userId = 1) => {
    const req = api.http().post(`/users/${userId}/orders`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('5 parallel retries with one key → one order; the others replay the same response', async () => {
    const before = await orderCount(api.db);
    const holder = await holdUserRow(api.url);
    const pending = Promise.all(Array.from({ length: 5 }, () => send(order, 'retry-1')));
    await waitForLockWaiters(api.db, 5); // all 5 retries are in flight at once
    await holder.query('COMMIT');
    await holder.end();
    const results = await pending;
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

  it('the same money in another spelling is the same request ("10000" = "10000.00")', async () => {
    const byAmount = { instrumentId: GGAL, side: 'BUY', type: 'MARKET' };
    const first = await send({ ...byAmount, amount: '10000' }, 'spelling').expect(201);
    const again = await send({ ...byAmount, amount: '10000.00' }, 'spelling').expect(201);
    expect(again.body.id).toBe(first.body.id);
  });

  it('same key with another body → 422 IDEMPOTENCY_KEY_REUSED, nothing saved', async () => {
    await send(order, 'k').expect(201);
    const before = await orderCount(api.db);
    const res = await send({ ...order, size: 2 }, 'k').expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await orderCount(api.db)).toBe(before);
  });

  it('a retry gets its first answer even if the instrument changed since', async () => {
    const first = await send(order, 'k-changed').expect(201);
    await api.db.query(`UPDATE instruments SET type = 'MONEDA' WHERE id = $1`, [GGAL]); // now untradable
    const again = await send(order, 'k-changed').expect(201);
    expect(again.body).toEqual(first.body);
  });

  it('a reused key with an unknown instrument → 422, not 404', async () => {
    await send(order, 'k-unknown').expect(201);
    const res = await send({ ...order, instrumentId: 999999 }, 'k-unknown').expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keys are per user: the same key for another user is a new request', async () => {
    await send(order, 'shared').expect(201);
    const res = await send(order, 'shared', 2).expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a response lost after commit: the retry with the same key gets that order, not a second one', async () => {
    const before = await orderCount(api.db);
    const holder = await holdUserRow(api.url);
    const lost = send(order, 'lost').timeout(1000).catch((e) => e); // the client gives up while the order waits
    await waitForLockWaiters(api.db, 1);
    expect((await lost).code).toBe('ECONNABORTED');
    await holder.query('COMMIT'); // the server goes on and commits
    await holder.end();
    const deadline = Date.now() + 5000;
    while ((await orderCount(api.db)) === before) {
      if (Date.now() > deadline) throw new Error('the abandoned order never committed');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const retry = await send(order, 'lost').expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await orderCount(api.db)).toBe(before + 1);
  });

  it('the connection lost during COMMIT: 500, since the order may be saved; the retry with the same key gets it', async () => {
    const before = await orderCount(api.db);
    const proxy = await dropAfterCommit(api.url);
    const app = await appOn(proxy.url);
    try {
      const res = await request(app.getHttpServer()).post('/users/1/orders').set('Idempotency-Key', 'commit').send(order);
      expect(res.status).toBe(500); // not 503: a 503 says nothing was saved
    } finally {
      await app.close();
      proxy.close();
    }

    const deadline = Date.now() + 5000;
    while ((await orderCount(api.db)) === before) {
      if (Date.now() > deadline) throw new Error('the COMMIT never reached the database');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const retry = await send(order, 'commit').expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await orderCount(api.db)).toBe(before + 1);
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
