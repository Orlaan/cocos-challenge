import { Client } from 'pg';
import { assertLocalDb, orderCount, startApi, TestApi } from './harness';

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

  it('places orders; an Idempotency-Key header is ignored instead of failing', async () => {
    const before = await orderCount(api.db);
    const body = { instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 };
    await api.http().post('/users/1/orders').set('Idempotency-Key', 'k').send(body).expect(201);
    await api.http().post('/users/1/orders').set('Idempotency-Key', 'k').send(body).expect(201);
    expect(await orderCount(api.db)).toBe(before + 2);
  });

  it('the test harness refuses any non-local database', () => {
    expect(() => assertLocalDb('postgres://u:p@example.com:5432/db')).toThrow(/non-local/);
    expect(() => assertLocalDb('postgres://u:p@localhost:5432/db')).not.toThrow();
  });
});
