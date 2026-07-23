import { Pool, type PoolConfig } from "pg";

/**
 * Shared pg connection pool.
 *
 * Supabase requires TLS. We pass `ssl: { rejectUnauthorized: false }` so the
 * connection succeeds regardless of whether the URL already carries
 * `sslmode=require`, without needing the Supabase CA bundle on disk.
 */

let pool: Pool | null = null;

export function createPool(connectionString?: string): Pool {
  const conn = connectionString ?? process.env.DATABASE_URL;
  if (!conn) {
    throw new Error("DATABASE_URL is not set");
  }
  const config: PoolConfig = {
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
  };
  return new Pool(config);
}

/** Lazily-initialized process-wide pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/** Close the shared pool (used on shutdown and in tests). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
