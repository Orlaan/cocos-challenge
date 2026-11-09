import { Client } from 'pg';
import { POOL_SIZE } from '../src/db';
import * as ledger from '../src/ledger';
import { orderCount, startApi, TestApi } from './harness';

// Every failure the README lists has one outcome. Each test below would fail if its mapping broke,
// including a pg-pool upgrade that changed its timeout message.
const order = { instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 };

describe('failure outcomes', () => {
  let api: TestApi;
  beforeAll(async () => (api = await startApi()));
  afterAll(() => api.close());

  it('no pooled connection within 3 s → an order gets 503 + Retry-After, nothing saved', async () => {
    const before = await orderCount(api.db);
    const held = Array.from({ length: POOL_SIZE }, () => api.ds.createQueryRunner());
    await Promise.all(held.map((runner) => runner.connect()));
    const res = await api.http().post('/users/1/orders').send(order);
    await Promise.all(held.map((runner) => runner.release()));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('BUSY');
    expect(await orderCount(api.db)).toBe(before);
  }, 10000);

  it('an order whose INSERT runs over 5 s → 503, nothing saved', async () => {
    const other = await startApi();
    await other.db.query(`CREATE FUNCTION slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$;
      CREATE TRIGGER slow BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION slow()`);
    const before = await orderCount(other.db);
    const res = await other.http().post('/users/1/orders').send(order);
    expect(res.status).toBe(503);
    expect(await orderCount(other.db)).toBe(before);
    await other.close();
  }, 15000);

  it('an order stalled in Node over 2 s → 503, nothing saved; the next order of that user does not wait for it', async () => {
    const before = await orderCount(api.db);
    let stalledAtQuote!: () => void;
    const holdsLock = new Promise<void>((resolve) => (stalledAtQuote = resolve));
    const real = ledger.latestQuotes;
    jest.spyOn(ledger, 'latestQuotes').mockImplementationOnce(async (...args) => {
      stalledAtQuote();
      await new Promise((resolve) => setTimeout(resolve, 4000)); // idle in transaction, holding the user lock
      return real(...args);
    });
    const stalled = api.http().post('/users/1/orders').send(order).then((r) => r);
    await holdsLock;
    const next = await api.http().post('/users/1/orders').send(order); // waits under 3 s, so no 503
    expect(next.status).toBe(201);
    expect((await stalled).status).toBe(503);
    expect(await orderCount(api.db)).toBe(before + 1);
  }, 10000);

  it('any other database error → 500 INTERNAL_ERROR with no internal detail, nothing saved', async () => {
    const other = await startApi();
    await other.db.query('ALTER TABLE instruments RENAME TO instruments_gone');
    const before = await orderCount(other.db);
    const res = await other.http().post('/users/1/orders').send(order);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR' });
    expect(await orderCount(other.db)).toBe(before);
    await other.close();
  });

  it('search is bounded too: a locked instruments table → 503 after 3 s, not a hung request', async () => {
    const holder = new Client({ connectionString: api.url.split('?')[0] });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE instruments IN ACCESS EXCLUSIVE MODE');
    const res = await api.http().get('/instruments?q=GGAL');
    await holder.query('ROLLBACK');
    await holder.end();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BUSY');
  }, 10000);
});
