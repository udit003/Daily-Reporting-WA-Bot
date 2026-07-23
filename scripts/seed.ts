/**
 * Idempotent seed for Narang Realty.
 *
 *  - Projects (canonical + normalized names) — used by the report pipeline.
 *  - Optional reference teams (metadata only; not part of onboarding).
 *  - Reminder `settings` defaults (from env) if absent.
 *  - Optional demo CEO root from SEED_CEO_PHONE / SEED_CEO_NAME.
 *
 * Safe to re-run: every write upserts on a unique key.
 */

import "dotenv/config";
import { createPool } from "../src/db/pool";
import { normalizeProjectName } from "../src/util/projectName";
import { normalizeName } from "../src/util/name";
import { normalizePhone } from "../src/util/phone";
import type { Pool } from "pg";

const PROJECTS = [
  "Narang Vivenda", // Malad West
  "Narang Privado", // Thane
  "Narang Valora", // Goregaon West
  "Narang Bangur Nagar", // Goregaon West
  "Asteria by Courtyard", // Thane
  "Windsor Grande Residences", // Andheri West
  "Windsor BKC",
];

const TEAMS = [
  "Sales",
  "Marketing",
  "CRM",
  "Projects & Construction",
  "Site Engineering",
  "Liaison & Approvals",
  "Finance & Accounts",
  "HR & Admin / IT",
];

// Pre-known top-level executives. When any of them onboards, the name they type
// is matched case/whitespace/punctuation-insensitively against these and they
// are auto-elevated to a top-level root (no manager picker). Add more here.
const CXOS = [
  "Gopal Narang",
  "Advait Narang",
  "Soham Narang",
];

async function seedProjects(pool: Pool): Promise<void> {
  for (const canonical of PROJECTS) {
    const norm = normalizeProjectName(canonical);
    await pool.query(
      `INSERT INTO projects (canonical_name, norm_name, aliases)
       VALUES ($1, $2, '{}')
       ON CONFLICT (norm_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name`,
      [canonical, norm],
    );
  }
  console.log(`seeded ${PROJECTS.length} projects`);
}

async function seedTeams(pool: Pool): Promise<void> {
  for (const name of TEAMS) {
    await pool.query(
      `INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name],
    );
  }
  console.log(`seeded ${TEAMS.length} reference teams`);
}

async function seedCxos(pool: Pool): Promise<void> {
  for (const name of CXOS) {
    const norm = normalizeName(name);
    await pool.query(
      `INSERT INTO cxos (name, norm_name) VALUES ($1, $2)
       ON CONFLICT (norm_name) DO UPDATE SET name = EXCLUDED.name`,
      [name, norm],
    );
  }
  console.log(`seeded ${CXOS.length} CXOs`);
}

async function seedSettings(pool: Pool): Promise<void> {
  const defaults: Array<[string, string]> = [
    ["reminder_start", process.env.REMINDER_START || "17:00"],
    ["reminder_interval_min", process.env.REMINDER_INTERVAL_MIN || "15"],
    ["reminder_stop", process.env.REMINDER_STOP || "22:00"],
  ];
  for (const [key, value] of defaults) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }
  console.log("seeded reminder settings (if absent)");
}

async function seedCeo(pool: Pool): Promise<void> {
  const rawPhone = process.env.SEED_CEO_PHONE;
  if (!rawPhone) {
    console.log("no SEED_CEO_PHONE — skipping demo CEO");
    return;
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    console.log(`SEED_CEO_PHONE invalid (${rawPhone}) — skipping demo CEO`);
    return;
  }
  const name = process.env.SEED_CEO_NAME || "Gopal Narang";
  const waId = `${phone}@s.whatsapp.net`;
  await pool.query(
    `INSERT INTO users (wa_id, phone, name, is_root, manager_id, onboarding_state)
     VALUES ($1, $2, $3, true, NULL, 'done')
     ON CONFLICT (wa_id) DO UPDATE
       SET name = EXCLUDED.name,
           is_root = true,
           manager_id = NULL,
           onboarding_state = 'done'`,
    [waId, phone, name],
  );
  console.log(`seeded demo CEO "${name}" (${waId})`);
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await seedProjects(pool);
    await seedTeams(pool);
    await seedCxos(pool);
    await seedSettings(pool);
    await seedCeo(pool);
    console.log("seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
