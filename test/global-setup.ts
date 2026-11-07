import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

// One Postgres for the whole run, with SSL on like a hosted database.
// Two template databases; every test file clones a fresh copy, so tests never see each other's orders.
//   provided: exactly db/database.sql (the schema Cocos gives us)
//   local:    database.sql + db/local-additions.sql (what docker compose runs)
export default async function globalSetup() {
  const container = await new PostgreSqlContainer('postgres:18')
    .withCommand([
      'postgres',
      '-c', 'ssl=on',
      '-c', 'ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem',
      '-c', 'ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key',
    ])
    .start();
  (globalThis as any).__PG__ = container;
  process.env.TEST_PG_ADMIN_URL = container.getConnectionUri();

  const seed = readFileSync('db/database.sql', 'utf8');
  const additions = readFileSync('db/local-additions.sql', 'utf8');
  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  for (const [name, sql] of [['provided', seed], ['local', seed + additions]]) {
    await admin.query(`CREATE DATABASE ${name}`);
    const db = new Client({ connectionString: container.getConnectionUri().replace(/\/[^/]+$/, `/${name}`) });
    await db.connect();
    await db.query(sql);
    await db.end();
  }
  await admin.end();
}
