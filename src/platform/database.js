import { Pool } from 'pg';

export function createDatabase(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 1_500,
  });
  return {
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
    ping: async () => {
      await pool.query('SELECT 1');
      return true;
    },
  };
}
