import pg from 'pg';
import { migrate } from '../src/migrate.ts';

/** Reset the test database schema and apply all migrations once per run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://synrgy:synrgy@localhost:5432/synrgy_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(url, () => {});
}
