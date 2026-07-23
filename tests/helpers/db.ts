import "dotenv/config";
import { getPool, closePool } from "../../src/db/pool";

/**
 * Shared helpers for the real-Postgres test suites. These run against the
 * sandbox `DATABASE_URL`. Each suite cleans the tables it touches so runs are
 * repeatable and independent.
 */

export { getPool, closePool };

/** Truncate the mutable tables and reset identities. Preserves migrations. */
export async function cleanDb(): Promise<void> {
  await getPool().query(
    `TRUNCATE report_projects, reports, projects, inbound_messages, users
     RESTART IDENTITY CASCADE`,
  );
}
