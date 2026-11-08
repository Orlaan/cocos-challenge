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

  it('creating the table later enables the key without a restart', async () => {
    await api.db.query(`CREATE TABLE idempotency_keys (userid INT NOT NULL, key VARCHAR(255) NOT NULL,
      request_hash TEXT NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (userid, key))`);
    const body = { instrumentId: 34, side: 'BUY', type: 'MARKET', size: 1 };
    const first = await api.http().post('/users/1/orders').set('Idempotency-Key', 'later').send(body).expect(201);
    const again = await api.http().post('/users/1/orders').set('Idempotency-Key', 'later').send(body).expect(201);
    expect(again.body.id).toBe(first.body.id);
    await api.db.query('DROP TABLE idempotency_keys');
  });

  it('the test harness refuses any non-local database', () => {
    expect(() => assertLocalDb('postgres://u:p@example.com:5432/db')).toThrow(/non-local/);
    expect(() => assertLocalDb('postgres://u:p@localhost:5432/db')).not.toThrow();
  });
});
