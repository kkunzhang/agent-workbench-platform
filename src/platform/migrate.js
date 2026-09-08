import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './database.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const migrationsDirectory = join(currentDirectory, '../../migrations');
const databaseUrl = process.env.DATABASE_URL || 'postgres://agent:agent_dev_password@127.0.0.1:5432/agent_platform';
const database = createDatabase(databaseUrl);

try {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await database.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationsDirectory, file), 'utf8');
    await database.query('BEGIN');
    try {
      await database.query(sql);
      await database.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await database.query('COMMIT');
      process.stdout.write(`已应用迁移：${file}\n`);
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await database.close();
}
