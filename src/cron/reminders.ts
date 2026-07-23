/**
 * Escalating reminder engine (Task 5).
 *
 * A minute cron sweeps for onboarded users who still owe a daily update and
 * nudges them on an escalating cadence read live from the runtime `settings`
 * table (CHANGE A). Nobody's schedule is cached at boot — every sweep re-reads
 * `getAllReminderSettings()` so a root's `set reminder ...` command takes
 * effect on the very next tick.
 *
 * Per sweep:
 *  - read `{start, intervalMin, stop}` via `getAllReminderSettings()`.
 *  - compute the wall-clock `now` in `config.REMINDER_TZ` (default
 *    Asia/Kolkata) for the `[start, stop]` window comparison, and `istToday()`
 *    (FIXED Asia/Kolkata) for the report-day boundary — so a report at 23:00
 *    IST counts for that IST day even when `REMINDER_TZ` differs.
 *  - `usersToRemind(istDate, nowTz, settings)` returns onboarded users with NO
 *    report today, inside the window, and DUE by cadence (never nudged today ⇒
 *    due once now ≥ start; else now − last_reminder_sent_at ≥ intervalMin).
 *    This applies to ALL onboarded users including managers and roots.
 *  - for each due user: `whapiClient.sendText(wa_id, message)` then
 *    `markReminderSent(user.id, istDate)`.
 *
 * `runReminderSweep(now?)` exposes the core sweep with an INJECTABLE clock
 * (default `new Date()`) so tests can drive time and demos can trigger it
 * manually. `startCron()` schedules it every minute and guards against
 * overlapping sweeps (a slow sweep skips the next tick rather than piling up).
 *
 * Every dependency is injected for testability; the engine never reads
 * `process.env` directly (it uses the injected `config`).
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { Config } from "../config";
import { loadConfig } from "../config";
import type { ReminderSettings, User } from "../db/queries";
import {
  getAllReminderSettings as dbGetAllReminderSettings,
  markReminderSent as dbMarkReminderSent,
  usersToRemind as dbUsersToRemind,
} from "../db/queries";
import { WhapiClient } from "../whapi/client";
import { istToday, nowInTz, type TzNow } from "../util/dates";
import { logger } from "../util/logger";

/** Friendly nudge sent to a user who still owes today's update. */
export const REMINDER_MESSAGE =
  "⏰ Reminder: please share your daily update for today (a quick text or voice note works). Type *help* for options.";

/** Whapi surface the engine needs. */
export interface ReminderWhapi {
  sendText(to: string, body: string): Promise<unknown>;
}

/** DB surface the engine needs. */
export interface ReminderDb {
  getAllReminderSettings(): Promise<ReminderSettings>;
  usersToRemind(
    istDate: string,
    nowTz: TzNow,
    settings: ReminderSettings,
  ): Promise<User[]>;
  markReminderSent(userId: number, istDate: string): Promise<void>;
}

export interface ReminderEngineDeps {
  db?: ReminderDb;
  whapiClient?: ReminderWhapi;
  config?: Config;
  /** Injectable clock; defaults to `new Date()`. */
  clock?: () => Date;
}

export interface ReminderEngine {
  /** The core sweep. Accepts an optional `now` to override the clock. */
  runReminderSweep(now?: Date): Promise<void>;
  /** Schedule the minute cron and return the task (Task 7 start/stops it). */
  startCron(): ScheduledTask;
}

export function createReminderEngine(deps: ReminderEngineDeps = {}): ReminderEngine {
  const db: ReminderDb =
    deps.db ?? {
      getAllReminderSettings: () => dbGetAllReminderSettings(),
      usersToRemind: (istDate, nowTz, settings) =>
        dbUsersToRemind(istDate, nowTz, settings),
      markReminderSent: (userId, istDate) => dbMarkReminderSent(userId, istDate),
    };
  const whapiClient: ReminderWhapi = deps.whapiClient ?? new WhapiClient();
  const config = deps.config ?? loadConfig();
  const clock = deps.clock ?? (() => new Date());

  // Guards against overlapping sweeps: if a previous sweep is still running
  // when the next minute tick fires, we skip it rather than run concurrently.
  let sweepInFlight = false;

  async function runReminderSweep(now: Date = clock()): Promise<void> {
    // Runtime values — read EVERY sweep so a live `set reminder ...` change is
    // honored on the next tick (never cached at boot).
    const settings = await db.getAllReminderSettings();

    // Window comparison uses the reminder timezone; the report-day boundary is
    // FIXED IST regardless of REMINDER_TZ.
    const nowTz = nowInTz(config.REMINDER_TZ, now);
    const istDate = istToday(now);

    const due = await db.usersToRemind(istDate, nowTz, settings);
    if (due.length === 0) return;

    for (const user of due) {
      try {
        await whapiClient.sendText(user.wa_id, REMINDER_MESSAGE);
        await db.markReminderSent(user.id, istDate);
      } catch (err) {
        // Don't let one failed send abort the whole sweep; the user stays due
        // (last_reminder_sent_at unchanged) and is retried next tick.
        logger.error("reminder send failed", {
          err,
          userId: user.id,
          waId: user.wa_id,
        });
      }
    }
  }

  function startCron(): ScheduledTask {
    return cron.schedule("* * * * *", async () => {
      if (sweepInFlight) {
        logger.warn("reminder sweep still running, skipping tick");
        return;
      }
      sweepInFlight = true;
      try {
        await runReminderSweep();
      } catch (err) {
        logger.error("reminder sweep failed", { err });
      } finally {
        sweepInFlight = false;
      }
    });
  }

  return { runReminderSweep, startCron };
}
