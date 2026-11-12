import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { orderCount, startApi, TestApi } from './harness';

// The database Cocos provides has only the 4 original tables, and hosted Postgres (Neon) needs SSL.
// This suite runs the app on exactly that shape: database.sql only, over an SSL connection.
describe('running on the provided database (original schema, SSL)', () => {
  let api: TestApi;
  beforeAll(async () => (api = await startApi('provided', '?sslmode=no-verify')));
  afterAll(() => api.close());

  it('connects over SSL', async () => {
    await api.http().get('/users/1/portfolio').expect(200);
    const admin = new Client({ connectionString: process.env.TEST_PG_ADMIN_URL });
    await admin.connect();
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_ssl JOIN pg_stat_activity USING (pid)
       WHERE ssl AND datname = $1`,
      [new URL(api.url).pathname.slice(1)],
    );
    await admin.end();
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('serves the golden portfolio without any added table', async () => {
    const res = await api.http().get('/users/1/portfolio').expect(200);
    expect(res.body.totalValue).toBe('889756.00');
    const { rows } = await api.db.query(`SELECT to_regclass('idempotency_keys') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('places orders', async () => {
    const res = await api.http().post('/users/1/orders').send({ instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('FILLED');
  });

  it('an Idempotency-Key it cannot honour → 501, nothing saved (never a silent duplicate)', async () => {
    const before = await orderCount(api.db);
    const body = { instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 };
    const res = await api.http().post('/users/1/orders').set('Idempotency-Key', 'k').send(body).expect(501);
    expect(res.body.code).toBe('IDEMPOTENCY_UNAVAILABLE');
    expect(await orderCount(api.db)).toBe(before);
  });

  it('applying db/local-additions.sql later (the deploy step) enables the key without a restart', async () => {
    await api.db.query(readFileSync('db/local-additions.sql', 'utf8'));
    const body = { instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 };
    const first = await api.http().post('/users/1/orders').set('Idempotency-Key', 'later').send(body).expect(201);
    const again = await api.http().post('/users/1/orders').set('Idempotency-Key', 'later').send(body).expect(201);
    expect(again.body.id).toBe(first.body.id);
  });

  it('db/local-additions.sql can run again: no error, no duplicate audit rows', async () => {
    const events = async () => Number((await api.db.query('SELECT count(*) FROM order_events')).rows[0].count);
    const before = await events();
    await api.db.query(readFileSync('db/local-additions.sql', 'utf8'));
    expect(await events()).toBe(before);
  });
});
