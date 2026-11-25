import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.ts';
import type { Queryable } from './db.ts';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
/** Arbitrary constant: serialises migrations when several instances start at once. */
const LOCK_ID = 727_001;

const migrationFiles = async () => (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

/** Apply every migration in /migrations that hasn't been recorded yet, in filename order. */
export async function migrate(connectionString = config.databaseUrl, log = console.log): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const file of await migrationFiles()) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

/** Migration files not yet applied (used by the readiness probe). */
export async function pendingMigrations(db: Queryable): Promise<string[]> {
  const { rows } = await db.query('SELECT name FROM schema_migrations').catch(() => ({ rows: [] as { name: string }[] }));
  const applied = new Set(rows.map((r: { name: string }) => r.name));
  return (await migrationFiles()).filter((f) => !applied.has(f));
}
