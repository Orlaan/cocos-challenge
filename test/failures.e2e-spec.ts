import { Client } from 'pg';
import { POOL_SIZE, transaction } from '../src/db';
import { toProblem } from '../src/problem';
import { orderCount, startApi, TestApi } from './harness';

// Every failure the README lists has one outcome. Each test below would fail if its mapping broke,
// including a pg-pool upgrade that changed its timeout message.
describe('failure outcomes', () => {
  let api: TestApi;
  beforeAll(async () => (api = await startApi()));
  afterAll(() => api.close());

  it('a statement over 5 s → 503 BUSY (statement_timeout, SQLSTATE 57014)', async () => {
    const error = await transaction(api.ds, (sql) => sql('SELECT pg_sleep(6)')).catch((e) => e);
    expect(error.code).toBe('57014');
    expect(toProblem(error)).toMatchObject({ status: 503, code: 'BUSY' });
  }, 10000);

  it('no pooled connection within 3 s → an order gets 503 + Retry-After, nothing saved', async () => {
    const before = await orderCount(api.db);
    const held = Array.from({ length: POOL_SIZE }, () => api.ds.createQueryRunner());
    await Promise.all(held.map((runner) => runner.connect()));
    const res = await api.http().post('/users/1/orders').send({ instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 });
    await Promise.all(held.map((runner) => runner.release()));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('BUSY');
    expect(await orderCount(api.db)).toBe(before);
  }, 10000);

  it('any other database error → 500 INTERNAL_ERROR, with no internal detail', async () => {
    const error = await api.ds.query('SELECT * FROM no_such_table').catch((e) => e);
    expect(toProblem(error)).toEqual(expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR', detail: undefined }));
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
