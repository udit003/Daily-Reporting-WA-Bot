/**
 * Migration runner (MUST-FIX 10).
 *
 * 1. CREATE TABLE IF NOT EXISTS schema_migrations (bootstrap).
 * 2. Acquire a session-level pg_advisory_lock so only one migrator runs at a
 *    time across processes.
 * 3. Discover migrations/*.sql in filename order, skip already-applied files.
 * 4. Apply EACH un-applied file + its schema_migrations insert in ONE
 *    transaction (so a failed file leaves no partial "applied" record).
 * 5. Release the lock.
 *
 * Idempotent: a re-run applies nothing.
 */

import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "../src/db/pool";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const ADVISORY_LOCK_KEY = 918273645; // arbitrary constant shared by all migrators

async function main(): Promise<void> {
  const pool = createPool();
  const client = await pool.connect();
  try {
    // 1. Bootstrap the ledger table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 2. Serialize migrators.
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);

    try {
      const applied = new Set(
        (
          await client.query<{ filename: string }>(
            `SELECT filename FROM schema_migrations`,
          )
        ).rows.map((r) => r.filename),
      );

      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      let count = 0;
      for (const file of files) {
        if (applied.has(file)) {
          console.log(`skip   ${file} (already applied)`);
          continue;
        }
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        // 4. File + ledger insert in one transaction.
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (filename) VALUES ($1)`,
            [file],
          );
          await client.query("COMMIT");
          console.log(`apply  ${file}`);
          count++;
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(
            `migration ${file} failed: ${(err as Error).message}`,
          );
        }
      }
      console.log(
        count === 0
          ? "up to date — no migrations applied."
          : `applied ${count} migration(s).`,
      );
    } finally {
      // 5. Release the lock.
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
