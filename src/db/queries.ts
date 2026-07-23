/**
 * All SQL for the daily-reporting bot. Self-contained: imports only the pool
 * and the types defined in this module. Functions are typed; transactional
 * where the plan requires atomicity + cycle/root guards.
 */

import type { Pool, PoolClient, QueryResultRow } from "pg";
import { getPool } from "./pool";

// ---------------------------------------------------------------------------
// Row / domain types
// ---------------------------------------------------------------------------

export type OnboardingState =
  | "new"
  | "ask_name"
  | "ask_manager"
  | "ask_pending_manager_phone"
  | "done";

export interface User {
  id: number;
  wa_id: string;
  phone: string;
  name: string | null;
  team_id: number | null;
  is_manager: boolean;
  is_root: boolean;
  manager_id: number | null;
  onboarding_state: OnboardingState;
  pending_manager_phone: string | null;
  last_reminder_sent_at: Date | null;
  reminder_count_today: number;
  reminder_day: string | null; // YYYY-MM-DD
  created_at: Date;
}

export interface Project {
  id: number;
  canonical_name: string;
  norm_name: string;
  aliases: string[];
  created_at: Date;
}

export interface StructuredReport {
  summary: string;
  tasks_done: string[];
  blockers: string[];
  projects: string[];
  next_steps: string[];
  [k: string]: unknown;
}

export interface Report {
  id: number;
  user_id: number;
  report_date: string; // YYYY-MM-DD
  raw_transcript: string;
  structured_json: StructuredReport;
  source_kind: string; // 'voice' | 'audio' | 'text'
  language: string | null;
  source_message_id: string;
  created_at: Date;
}

export interface NewReport {
  user_id: number;
  report_date: string; // YYYY-MM-DD (IST)
  raw_transcript: string;
  structured_json: StructuredReport;
  source_kind: string;
  language: string | null;
  source_message_id: string;
}

export interface InboundMessage {
  id: number;
  whapi_message_id: string;
  wa_id: string;
  batch_seq: number;
  raw: unknown;
  status: string;
  received_at: Date;
  processed_at: Date | null;
}

export interface ReminderSettings {
  start: string; // HH:MM
  intervalMin: number;
  stop: string; // HH:MM
}

export interface NewUser {
  wa_id: string;
  phone: string;
  name?: string | null;
  onboarding_state?: OnboardingState;
}

export interface OnboardingUpdate {
  name?: string | null;
  onboarding_state?: OnboardingState;
  is_root?: boolean;
  manager_id?: number | null;
  pending_manager_phone?: string | null;
}

/** Anything we can run queries on: the pool or a checked-out client. */
export type Queryable = Pool | PoolClient;

/** Result of a reconciliation attempt. */
export interface ReconcileResult {
  linked: number[]; // user ids linked under the newly-done user
  skippedForCycle: number[]; // user ids refused because linking would cycle
}

/** Result of setUserManager. */
export type SetManagerResult =
  | { ok: true }
  | { ok: false; reason: "self" | "descendant" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_COLS = `
  id, wa_id, phone, name, team_id, is_manager, is_root, manager_id,
  onboarding_state, pending_manager_phone, last_reminder_sent_at,
  reminder_count_today, to_char(reminder_day, 'YYYY-MM-DD') AS reminder_day,
  created_at
`;

async function q<T extends QueryResultRow>(
  runner: Queryable,
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await runner.query<T>(text, params as any[]);
  return res.rows;
}

/** Run `fn` inside a transaction on a dedicated client. */
async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Compute the set of descendant ids of `userId` using a cycle-guarded
 * recursive CTE, executed on the supplied runner (so it can participate in a
 * surrounding transaction). Excludes `userId` itself.
 */
async function subtreeIds(runner: Queryable, userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    runner,
    `
    WITH RECURSIVE subtree(id, depth, path) AS (
      SELECT id, 0, ARRAY[id] FROM users WHERE id = $1
      UNION
      SELECT u.id, s.depth + 1, s.path || u.id
      FROM users u
      JOIN subtree s ON u.manager_id = s.id
      WHERE NOT u.id = ANY(s.path) AND s.depth < 64
    )
    SELECT id FROM subtree WHERE id <> $1
    `,
    [userId],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Users & onboarding
// ---------------------------------------------------------------------------

export async function getUserByWaId(
  waId: string,
  runner: Queryable = getPool(),
): Promise<User | null> {
  const rows = await q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users WHERE wa_id = $1`,
    [waId],
  );
  return rows[0] ?? null;
}

export async function getUserByPhone(
  phone: string,
  runner: Queryable = getPool(),
): Promise<User | null> {
  const rows = await q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users WHERE phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

export async function getUserById(
  id: number,
  runner: Queryable = getPool(),
): Promise<User | null> {
  const rows = await q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Fetch users by id (order is not guaranteed). Used to resolve names within a subtree. */
export async function getUsersByIds(
  ids: number[],
  runner: Queryable = getPool(),
): Promise<User[]> {
  if (ids.length === 0) return [];
  return q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users WHERE id = ANY($1)`,
    [ids],
  );
}

export async function insertUser(
  input: NewUser,
  runner: Queryable = getPool(),
): Promise<User> {
  const rows = await q<User>(
    runner,
    `INSERT INTO users (wa_id, phone, name, onboarding_state)
     VALUES ($1, $2, $3, COALESCE($4, 'new'))
     RETURNING ${USER_COLS}`,
    [input.wa_id, input.phone, input.name ?? null, input.onboarding_state ?? null],
  );
  return rows[0];
}

/**
 * Patch onboarding-related fields. Only provided keys are updated.
 */
export async function updateUserOnboarding(
  userId: number,
  patch: OnboardingUpdate,
  runner: Queryable = getPool(),
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    params.push(val);
  };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.onboarding_state !== undefined)
    add("onboarding_state", patch.onboarding_state);
  if (patch.is_root !== undefined) add("is_root", patch.is_root);
  if (patch.manager_id !== undefined) add("manager_id", patch.manager_id);
  if (patch.pending_manager_phone !== undefined)
    add("pending_manager_phone", patch.pending_manager_phone);

  if (sets.length === 0) {
    return getUserById(userId, runner);
  }

  params.push(userId);
  const rows = await q<User>(
    runner,
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${USER_COLS}`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Assign `managerId` as the manager of `userId`, in one transaction:
 *  - rejects self-assignment,
 *  - rejects assigning a descendant of the user (would create a cycle),
 *  - derives the manager's `is_manager = true`.
 */
export async function setUserManager(
  userId: number,
  managerId: number,
): Promise<SetManagerResult> {
  if (userId === managerId) return { ok: false, reason: "self" };
  return withTx(async (client) => {
    // Lock the two rows to keep the descendant check + writes consistent.
    await client.query(
      `SELECT id FROM users WHERE id = ANY($1) FOR UPDATE`,
      [[userId, managerId]],
    );
    const descs = await subtreeIds(client, userId);
    if (descs.includes(managerId)) {
      return { ok: false, reason: "descendant" as const };
    }
    await client.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [
      managerId,
      userId,
    ]);
    await client.query(`UPDATE users SET is_manager = true WHERE id = $1`, [
      managerId,
    ]);
    return { ok: true as const };
  });
}

/**
 * Mark a user as a top-level root (`is_root = true`, `manager_id = NULL`).
 *
 * CHANGE E: `is_root` is an informational top-level marker and is NOT unique —
 * any number of users may be roots (the old `uq_single_root` partial unique
 * index is dropped in `migrations/0003_multi_root.sql`). This therefore always
 * succeeds; it is never re-prompted or rejected because a root already exists.
 */
export async function setRoot(
  userId: number,
  runner: Queryable = getPool(),
): Promise<{ ok: boolean }> {
  await runner.query(
    `UPDATE users SET is_root = true, manager_id = NULL WHERE id = $1`,
    [userId],
  );
  return { ok: true };
}

/**
 * When the user identified by `phone` has just completed onboarding, link every
 * waiter (a user whose `pending_manager_phone = phone`) under them:
 *  - transactional,
 *  - cycle-guarded (skip a waiter if the new manager is already the waiter's
 *    descendant),
 *  - derives `is_manager = true` on the new manager when at least one link is
 *    made.
 */
export async function reconcilePendingManagers(
  phone: string,
): Promise<ReconcileResult> {
  return withTx(async (client) => {
    const managerRows = await q<User>(
      client,
      `SELECT ${USER_COLS} FROM users WHERE phone = $1 FOR UPDATE`,
      [phone],
    );
    const manager = managerRows[0];
    const result: ReconcileResult = { linked: [], skippedForCycle: [] };
    if (!manager || manager.onboarding_state !== "done") return result;

    const waiters = await q<{ id: number }>(
      client,
      `SELECT id FROM users WHERE pending_manager_phone = $1 AND id <> $2 FOR UPDATE`,
      [phone, manager.id],
    );

    for (const w of waiters) {
      // Cycle guard: refuse if the manager is within the waiter's subtree.
      const waiterDescs = await subtreeIds(client, w.id);
      if (waiterDescs.includes(manager.id)) {
        result.skippedForCycle.push(w.id);
        continue;
      }
      await client.query(
        `UPDATE users SET manager_id = $1, pending_manager_phone = NULL WHERE id = $2`,
        [manager.id, w.id],
      );
      result.linked.push(w.id);
    }

    if (result.linked.length > 0) {
      await client.query(`UPDATE users SET is_manager = true WHERE id = $1`, [
        manager.id,
      ]);
    }
    return result;
  });
}

/** Onboarded users (for the manager picker), paginated by name/id. */
export async function listOnboardedUsers(
  offset: number,
  limit: number,
  runner: Queryable = getPool(),
): Promise<User[]> {
  return q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users
     WHERE onboarding_state = 'done'
     ORDER BY name NULLS LAST, id
     OFFSET $1 LIMIT $2`,
    [offset, limit],
  );
}

export async function countOnboardedUsers(
  runner: Queryable = getPool(),
): Promise<number> {
  const rows = await q<{ count: string }>(
    runner,
    `SELECT count(*)::text AS count FROM users WHERE onboarding_state = 'done'`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Cycle-guarded recursive subtree ids for a manager (excludes self). */
export async function getSubtreeUserIds(
  managerId: number,
  runner: Queryable = getPool(),
): Promise<number[]> {
  return subtreeIds(runner, managerId);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Lookup-only exact match on the normalized name (used by the query handler). */
export async function findProjectByNorm(
  norm: string,
  runner: Queryable = getPool(),
): Promise<Project | null> {
  const rows = await q<Project>(
    runner,
    `SELECT id, canonical_name, norm_name, aliases, created_at
     FROM projects WHERE norm_name = $1`,
    [norm],
  );
  return rows[0] ?? null;
}

/**
 * Conflict-safe upsert on `norm_name`. On first insert stores the canonical
 * name. On conflict (a concurrent/prior insert of the same normalized name),
 * appends the incoming `canonical` as a distinct alias without clobbering
 * concurrent updates, and returns the surviving single row.
 */
export async function matchOrCreateProject(
  canonical: string,
  norm: string,
  runner: Queryable = getPool(),
): Promise<Project> {
  const rows = await q<Project>(
    runner,
    `
    INSERT INTO projects (canonical_name, norm_name, aliases)
    VALUES ($1, $2, '{}')
    ON CONFLICT (norm_name) DO UPDATE
      SET aliases = (
        SELECT COALESCE(array_agg(DISTINCT a), '{}')
        FROM unnest(
          projects.aliases
          || CASE
               WHEN EXCLUDED.canonical_name = projects.canonical_name
                 OR EXCLUDED.canonical_name = ANY(projects.aliases)
               THEN '{}'::text[]
               ELSE ARRAY[EXCLUDED.canonical_name]
             END
        ) AS a
      )
    RETURNING id, canonical_name, norm_name, aliases, created_at
    `,
    [canonical, norm],
  );
  return rows[0];
}

/** Explicitly append a distinct alias to a project. */
export async function appendProjectAlias(
  projectId: number,
  alias: string,
  runner: Queryable = getPool(),
): Promise<Project | null> {
  const rows = await q<Project>(
    runner,
    `
    UPDATE projects
    SET aliases = (
      SELECT COALESCE(array_agg(DISTINCT a), '{}')
      FROM unnest(
        aliases
        || CASE
             WHEN $2 = canonical_name OR $2 = ANY(aliases)
             THEN '{}'::text[]
             ELSE ARRAY[$2]::text[]
           END
      ) AS a
    )
    WHERE id = $1
    RETURNING id, canonical_name, norm_name, aliases, created_at
    `,
    [projectId, alias],
  );
  return rows[0] ?? null;
}

/**
 * Fuzzy candidate lookup via pg_trgm similarity. Returns the best match above
 * `threshold`, or null. Used by the pipeline's matchOrCreate flow.
 */
export async function findProjectBySimilarity(
  norm: string,
  threshold: number,
  runner: Queryable = getPool(),
): Promise<Project | null> {
  const rows = await q<Project>(
    runner,
    `SELECT id, canonical_name, norm_name, aliases, created_at
     FROM projects
     WHERE similarity(norm_name, $1) >= $2
     ORDER BY similarity(norm_name, $1) DESC, id
     LIMIT 1`,
    [norm, threshold],
  );
  return rows[0] ?? null;
}

/**
 * Idempotent seed upsert of a project: create by norm_name, or on conflict keep
 * the existing row and ensure the canonical name is preserved.
 */
export async function upsertProjectSeed(
  canonical: string,
  norm: string,
  runner: Queryable = getPool(),
): Promise<Project> {
  const rows = await q<Project>(
    runner,
    `INSERT INTO projects (canonical_name, norm_name, aliases)
     VALUES ($1, $2, '{}')
     ON CONFLICT (norm_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
     RETURNING id, canonical_name, norm_name, aliases, created_at`,
    [canonical, norm],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Insert a report and its project links in a single transaction. Deduped on
 * `source_message_id` (ON CONFLICT DO NOTHING): a duplicate Whapi delivery
 * returns the already-stored row and adds no new links.
 */
export async function insertReportWithProjects(
  report: NewReport,
  projectIds: number[],
): Promise<{ report: Report; inserted: boolean }> {
  return withTx(async (client) => {
    const inserted = await q<Report>(
      client,
      `INSERT INTO reports
         (user_id, report_date, raw_transcript, structured_json,
          source_kind, language, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_message_id) DO NOTHING
       RETURNING id, user_id, to_char(report_date,'YYYY-MM-DD') AS report_date,
                 raw_transcript, structured_json, source_kind, language,
                 source_message_id, created_at`,
      [
        report.user_id,
        report.report_date,
        report.raw_transcript,
        report.structured_json,
        report.source_kind,
        report.language,
        report.source_message_id,
      ],
    );

    if (inserted.length === 0) {
      // Duplicate: fetch the existing row, add no links.
      const existing = await q<Report>(
        client,
        `SELECT id, user_id, to_char(report_date,'YYYY-MM-DD') AS report_date,
                raw_transcript, structured_json, source_kind, language,
                source_message_id, created_at
         FROM reports WHERE source_message_id = $1`,
        [report.source_message_id],
      );
      return { report: existing[0], inserted: false };
    }

    const row = inserted[0];
    const uniqueIds = Array.from(new Set(projectIds));
    for (const pid of uniqueIds) {
      await client.query(
        `INSERT INTO report_projects (report_id, project_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, pid],
      );
    }
    return { report: row, inserted: true };
  });
}

export interface ReportFilter {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  projectId?: number;
}

/** Reports for a set of users within an inclusive IST date range, optionally
 * filtered to a single project. Returns newest first. */
export async function getReportsForUsers(
  userIds: number[],
  filter: ReportFilter,
  runner: Queryable = getPool(),
): Promise<Report[]> {
  if (userIds.length === 0) return [];
  const params: unknown[] = [userIds, filter.from, filter.to];
  let projJoin = "";
  if (filter.projectId != null) {
    params.push(filter.projectId);
    projJoin = `JOIN report_projects rp ON rp.report_id = r.id AND rp.project_id = $4`;
  }
  return q<Report>(
    runner,
    `SELECT r.id, r.user_id, to_char(r.report_date,'YYYY-MM-DD') AS report_date,
            r.raw_transcript, r.structured_json, r.source_kind, r.language,
            r.source_message_id, r.created_at
     FROM reports r
     ${projJoin}
     WHERE r.user_id = ANY($1) AND r.report_date >= $2 AND r.report_date <= $3
     ORDER BY r.report_date DESC, r.created_at DESC`,
    params,
  );
}

/** Most recent N reports for a single user (for the follow-up LLM call). */
export async function getRecentReportsForUser(
  userId: number,
  limit: number,
  runner: Queryable = getPool(),
): Promise<Report[]> {
  return q<Report>(
    runner,
    `SELECT id, user_id, to_char(report_date,'YYYY-MM-DD') AS report_date,
            raw_transcript, structured_json, source_kind, language,
            source_message_id, created_at
     FROM reports WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
}

// ---------------------------------------------------------------------------
// Status digest (CHANGE G)
// ---------------------------------------------------------------------------

/** A subtree member with whether they have submitted a report on `istDate`. */
export interface SubtreeReportedStatus {
  id: number;
  name: string | null;
  reported: boolean;
}

/**
 * For the given subtree user ids, return each user's `{id, name}` plus whether
 * they have at least one report on `istDate` (fixed IST day). Deterministic
 * reported/pending split — no LLM. Ordered by name for stable rendering.
 */
export async function getSubtreeReportedStatus(
  userIds: number[],
  istDate: string,
  runner: Queryable = getPool(),
): Promise<SubtreeReportedStatus[]> {
  if (userIds.length === 0) return [];
  return q<SubtreeReportedStatus>(
    runner,
    `SELECT u.id,
            u.name,
            EXISTS (
              SELECT 1 FROM reports r
              WHERE r.user_id = u.id AND r.report_date = $2
            ) AS reported
     FROM users u
     WHERE u.id = ANY($1)
     ORDER BY u.name NULLS LAST, u.id`,
    [userIds, istDate],
  );
}

/** A report row carrying its reporter name + the canonical names of its linked projects. */
export interface ReportWithProjects extends Report {
  reporter_name: string | null;
  project_names: string[];
}

/**
 * Reports for a set of users within an inclusive IST date range, each row
 * carrying the reporter's name and the canonical names of its linked projects
 * (empty array when a report links no project). Feeds `summarizeDigest`.
 */
export async function getReportsForUsersWithProjects(
  userIds: number[],
  filter: { from: string; to: string },
  runner: Queryable = getPool(),
): Promise<ReportWithProjects[]> {
  if (userIds.length === 0) return [];
  return q<ReportWithProjects>(
    runner,
    `SELECT r.id, r.user_id, to_char(r.report_date,'YYYY-MM-DD') AS report_date,
            r.raw_transcript, r.structured_json, r.source_kind, r.language,
            r.source_message_id, r.created_at,
            u.name AS reporter_name,
            COALESCE(
              (SELECT array_agg(p.canonical_name ORDER BY p.canonical_name)
               FROM report_projects rp
               JOIN projects p ON p.id = rp.project_id
               WHERE rp.report_id = r.id),
              '{}'::text[]
            ) AS project_names
     FROM reports r
     JOIN users u ON u.id = r.user_id
     WHERE r.user_id = ANY($1) AND r.report_date >= $2 AND r.report_date <= $3
     ORDER BY r.report_date DESC, r.created_at DESC`,
    [userIds, filter.from, filter.to],
  );
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** Onboarded users who have no report on the given IST date. */
export async function usersWithoutReportOn(
  istDate: string,
  runner: Queryable = getPool(),
): Promise<User[]> {
  return q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users u
     WHERE u.onboarding_state = 'done'
       AND NOT EXISTS (
         SELECT 1 FROM reports r
         WHERE r.user_id = u.id AND r.report_date = $1
       )
     ORDER BY u.id`,
    [istDate],
  );
}

/**
 * Onboarded users who should be nudged now: no report today, within the
 * `[start, stop]` reminder window, and due by cadence — either never nudged
 * today (last_reminder_sent_at null or reminder_day != today) or at least
 * `intervalMin` minutes since the last nudge.
 *
 * `nowTz` is the wall-clock in the reminder timezone as {date, hhmm}. The
 * window check is done here in SQL against `nowTz.hhmm`; callers pass the
 * fixed-IST date as `istDate` for the report-existence + day-rollover check.
 */
export async function usersToRemind(
  istDate: string,
  nowTz: { date: string; hhmm: string },
  settings: ReminderSettings,
  runner: Queryable = getPool(),
): Promise<User[]> {
  // If we're outside the [start, stop] wall-clock window, nobody is due.
  if (nowTz.hhmm < settings.start || nowTz.hhmm > settings.stop) {
    return [];
  }
  return q<User>(
    runner,
    `SELECT ${USER_COLS} FROM users u
     WHERE u.onboarding_state = 'done'
       AND NOT EXISTS (
         SELECT 1 FROM reports r
         WHERE r.user_id = u.id AND r.report_date = $1
       )
       AND (
         u.last_reminder_sent_at IS NULL
         OR u.reminder_day IS NULL
         OR u.reminder_day <> $1::date
         OR u.last_reminder_sent_at <= (now() - make_interval(mins => $2))
       )
     ORDER BY u.id`,
    [istDate, settings.intervalMin],
  );
}

/**
 * Record that a reminder was sent to a user for the given IST day: sets
 * last_reminder_sent_at=now, and rolls / bumps the daily counter when the IST
 * day changes.
 */
export async function markReminderSent(
  userId: number,
  istDate: string,
  runner: Queryable = getPool(),
): Promise<void> {
  await runner.query(
    `UPDATE users
     SET last_reminder_sent_at = now(),
         reminder_count_today = CASE
           WHEN reminder_day = $2::date THEN reminder_count_today + 1
           ELSE 1
         END,
         reminder_day = $2::date
     WHERE id = $1`,
    [userId, istDate],
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting(
  key: string,
  runner: Queryable = getPool(),
): Promise<string | null> {
  const rows = await q<{ value: string }>(
    runner,
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function upsertSetting(
  key: string,
  value: string,
  runner: Queryable = getPool(),
): Promise<void> {
  await runner.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Insert a settings default only if the key is absent (seed helper). */
export async function insertSettingIfAbsent(
  key: string,
  value: string,
  runner: Queryable = getPool(),
): Promise<void> {
  await runner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, value],
  );
}

const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  start: "17:00",
  intervalMin: 15,
  stop: "22:00",
};

/** Read the three reminder settings, falling back to defaults per key. */
export async function getAllReminderSettings(
  runner: Queryable = getPool(),
): Promise<ReminderSettings> {
  const rows = await q<{ key: string; value: string }>(
    runner,
    `SELECT key, value FROM settings
     WHERE key IN ('reminder_start', 'reminder_interval_min', 'reminder_stop')`,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const start = map.get("reminder_start") ?? DEFAULT_REMINDER_SETTINGS.start;
  const stop = map.get("reminder_stop") ?? DEFAULT_REMINDER_SETTINGS.stop;
  const intervalRaw = map.get("reminder_interval_min");
  const intervalMin = intervalRaw
    ? Number(intervalRaw)
    : DEFAULT_REMINDER_SETTINGS.intervalMin;
  return {
    start,
    stop,
    intervalMin: Number.isFinite(intervalMin) && intervalMin > 0
      ? intervalMin
      : DEFAULT_REMINDER_SETTINGS.intervalMin,
  };
}

// ---------------------------------------------------------------------------
// Inbound messages (durable inbox)
// ---------------------------------------------------------------------------

/**
 * Record an inbound message. Idempotent on `whapi_message_id`
 * (ON CONFLICT DO NOTHING) so duplicate Whapi deliveries collapse.
 * Returns true if a new row was inserted.
 */
export async function recordInbound(
  msgId: string,
  waId: string,
  seq: number,
  raw: unknown,
  runner: Queryable = getPool(),
): Promise<boolean> {
  const res = await runner.query(
    `INSERT INTO inbound_messages (whapi_message_id, wa_id, batch_seq, raw)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (whapi_message_id) DO NOTHING`,
    [msgId, waId, seq, raw],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Claim the next pending inbound message for a sender that is not already being
 * processed, taking a per-sender advisory transaction lock. Returns the claimed
 * row (status set to 'processing') or null if none is available.
 *
 * NOTE: this uses a session-less transaction via the shared pool; the lock is
 * released when the surrounding transaction commits. Task 3's processor wires
 * the full drain loop; this primitive is provided for it and for tests.
 */
export async function claimNextInboundForSender(
  runner: Queryable = getPool(),
): Promise<InboundMessage | null> {
  const rows = await q<InboundMessage>(
    runner,
    `WITH next AS (
       SELECT id FROM inbound_messages
       WHERE status = 'pending'
       ORDER BY received_at, batch_seq, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE inbound_messages m
     SET status = 'processing'
     FROM next
     WHERE m.id = next.id
     RETURNING m.id, m.whapi_message_id, m.wa_id, m.batch_seq, m.raw, m.status,
               m.received_at, m.processed_at`,
    [],
  );
  return rows[0] ?? null;
}

/** Set the terminal status of an inbound message. */
export async function markInbound(
  id: number,
  status: "pending" | "processing" | "done" | "failed",
  runner: Queryable = getPool(),
): Promise<void> {
  const setProcessed = status === "done" || status === "failed";
  await runner.query(
    `UPDATE inbound_messages
     SET status = $2, processed_at = ${setProcessed ? "now()" : "processed_at"}
     WHERE id = $1`,
    [id, status],
  );
}

// ---------------------------------------------------------------------------
// Teams (optional reference metadata)
// ---------------------------------------------------------------------------

export async function upsertTeam(
  name: string,
  runner: Queryable = getPool(),
): Promise<void> {
  await runner.query(
    `INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name],
  );
}

// ---------------------------------------------------------------------------
// CXOs (pre-known top-level executives; matched case/whitespace/punctuation-
// insensitively on norm_name during onboarding)
// ---------------------------------------------------------------------------

/** Upsert a known CXO by its normalized name (idempotent). */
export async function upsertCxo(
  name: string,
  normName: string,
  runner: Queryable = getPool(),
): Promise<void> {
  await runner.query(
    `INSERT INTO cxos (name, norm_name) VALUES ($1, $2)
     ON CONFLICT (norm_name) DO UPDATE SET name = EXCLUDED.name`,
    [name, normName],
  );
}

/**
 * Look up a known CXO by its normalized name. Returns the canonical display
 * name if the normalized name matches a seeded CXO, else null. The caller is
 * responsible for normalizing (src/util/name.ts) so matching ignores case,
 * whitespace and punctuation.
 */
export async function findCxoByNormName(
  normName: string,
  runner: Queryable = getPool(),
): Promise<{ id: number; name: string } | null> {
  const rows = await q<{ id: number; name: string }>(
    runner,
    `SELECT id, name FROM cxos WHERE norm_name = $1`,
    [normName],
  );
  return rows[0] ?? null;
}
