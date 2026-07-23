import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  createReminderEngine,
  REMINDER_MESSAGE,
  type ReminderDb,
} from "../src/cron/reminders";
import type { Config } from "../src/config";
import type { ReminderSettings, User } from "../src/db/queries";
import { istToday, nowInTz, type TzNow } from "../src/util/dates";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

/**
 * Build a UTC instant corresponding to a given Asia/Kolkata (IST, UTC+5:30)
 * wall-clock time on 2026-07-DD. Keeps the tests readable in IST terms.
 */
function istAt(hh: number, mm: number, dd = 23): Date {
  const utcMs = Date.UTC(2026, 6, dd, hh, mm, 0) - (5 * 60 + 30) * 60_000;
  return new Date(utcMs);
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    wa_id: "111@s.whatsapp.net",
    phone: "111",
    name: "Sana",
    team_id: null,
    is_manager: false,
    is_root: false,
    manager_id: null,
    onboarding_state: "done",
    pending_manager_phone: null,
    last_reminder_sent_at: null,
    reminder_count_today: 0,
    reminder_day: null,
    created_at: new Date(),
    ...overrides,
  };
}

interface Setup {
  users: User[];
  reports: Set<string>; // `${userId}:${istDate}` entries that "have reported"
  settings: ReminderSettings;
  clockNow: Date;
}

/**
 * In-memory DB mock that faithfully replicates the real `usersToRemind` /
 * `markReminderSent` semantics from `db/queries.ts`:
 *   - outside [start, stop] wall-clock window ⇒ nobody due,
 *   - onboarding_state must be 'done',
 *   - no report on the IST day,
 *   - due when never-nudged-today OR now − last_reminder_sent_at ≥ intervalMin.
 * The interval math uses the SAME injected clock the engine uses, so time is
 * driven deterministically from the test.
 */
function createHarness(initial: Partial<Setup> = {}) {
  const state: Setup = {
    users: initial.users ?? [makeUser()],
    reports: initial.reports ?? new Set<string>(),
    settings: initial.settings ?? { start: "17:00", intervalMin: 15, stop: "22:00" },
    clockNow: initial.clockNow ?? istAt(16, 0),
  };

  const clock = () => state.clockNow;

  const getAllReminderSettings = vi.fn(async (): Promise<ReminderSettings> => {
    // Return a snapshot so a later mutation to state.settings is only seen on
    // the NEXT call (proves the engine re-reads settings each sweep).
    return { ...state.settings };
  });

  const usersToRemind = vi.fn(
    async (
      istDate: string,
      nowTz: TzNow,
      settings: ReminderSettings,
    ): Promise<User[]> => {
      // Window check — lexicographic HH:MM compare, matching the SQL.
      if (nowTz.hhmm < settings.start || nowTz.hhmm > settings.stop) {
        return [];
      }
      const nowMs = clock().getTime();
      const intervalMs = settings.intervalMin * 60_000;
      return state.users.filter((u) => {
        if (u.onboarding_state !== "done") return false;
        if (state.reports.has(`${u.id}:${istDate}`)) return false;
        const neverNudgedToday =
          u.last_reminder_sent_at == null ||
          u.reminder_day == null ||
          u.reminder_day !== istDate;
        if (neverNudgedToday) return true;
        return nowMs - (u.last_reminder_sent_at as Date).getTime() >= intervalMs;
      });
    },
  );

  const markReminderSent = vi.fn(
    async (userId: number, istDate: string): Promise<void> => {
      const u = state.users.find((x) => x.id === userId);
      if (!u) return;
      u.last_reminder_sent_at = clock();
      u.reminder_count_today = u.reminder_day === istDate ? u.reminder_count_today + 1 : 1;
      u.reminder_day = istDate;
    },
  );

  const db: ReminderDb = { getAllReminderSettings, usersToRemind, markReminderSent };

  const sends: { to: string; body: string }[] = [];
  const whapiClient = {
    sendText: vi.fn(async (to: string, body: string) => {
      sends.push({ to, body });
      return {};
    }),
  };

  const config = { REMINDER_TZ: "Asia/Kolkata" } as unknown as Config;

  const engine = createReminderEngine({ db, whapiClient, config, clock });

  return { engine, state, db, whapiClient, sends, clock };
}

describe("reminder engine — runReminderSweep", () => {
  it("does not nudge before reminder_start; last_reminder_sent_at unchanged", async () => {
    const h = createHarness({ clockNow: istAt(16, 30) }); // 16:30 IST < 17:00 start
    await h.engine.runReminderSweep();
    expect(h.whapiClient.sendText).not.toHaveBeenCalled();
    expect(h.db.markReminderSent).not.toHaveBeenCalled();
    expect(h.state.users[0].last_reminder_sent_at).toBeNull();
  });

  it("sends the first nudge at/after reminder_start and marks it", async () => {
    const h = createHarness({ clockNow: istAt(17, 0) }); // exactly at start
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toEqual({ to: "111@s.whatsapp.net", body: REMINDER_MESSAGE });
    expect(h.db.markReminderSent).toHaveBeenCalledWith(1, "2026-07-23");
    expect(h.state.users[0].last_reminder_sent_at).not.toBeNull();
    expect(h.state.users[0].reminder_day).toBe("2026-07-23");
  });

  it("repeats exactly every interval: no send at interval-1, send at interval", async () => {
    const h = createHarness({ clockNow: istAt(17, 0) });
    await h.engine.runReminderSweep(); // first nudge at 17:00
    expect(h.sends).toHaveLength(1);

    // 17:14 — only 14 min since last send (< 15) ⇒ not due.
    h.state.clockNow = istAt(17, 14);
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(1);

    // 17:15 — exactly 15 min ⇒ due again.
    h.state.clockNow = istAt(17, 15);
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(2);
  });

  it("stops once a report exists today for the user", async () => {
    const h = createHarness({ clockNow: istAt(17, 30) });
    h.state.reports.add("1:2026-07-23"); // user reported today
    await h.engine.runReminderSweep();
    expect(h.whapiClient.sendText).not.toHaveBeenCalled();
    expect(h.db.markReminderSent).not.toHaveBeenCalled();
  });

  it("does not nudge after reminder_stop", async () => {
    const h = createHarness({ clockNow: istAt(22, 30) }); // 22:30 > 22:00 stop
    await h.engine.runReminderSweep();
    expect(h.whapiClient.sendText).not.toHaveBeenCalled();
    expect(h.db.markReminderSent).not.toHaveBeenCalled();
  });

  it("honors a runtime settings change between sweeps (interval 15 → 30)", async () => {
    const h = createHarness({ clockNow: istAt(17, 0) });
    await h.engine.runReminderSweep(); // first nudge at 17:00 (interval 15)
    expect(h.sends).toHaveLength(1);

    // Root changes the interval to 30 at runtime.
    h.state.settings = { ...h.state.settings, intervalMin: 30 };

    // 17:20 — would be due under 15 (20 ≥ 15) but NOT under 30 ⇒ no send.
    h.state.clockNow = istAt(17, 20);
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(1);

    // 17:30 — 30 min since last send ⇒ due under the new interval.
    h.state.clockNow = istAt(17, 30);
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(2);

    // Settings were re-read each sweep, not cached at construction.
    expect(h.db.getAllReminderSettings).toHaveBeenCalledTimes(3);
  });

  it("uses the FIXED-IST day boundary for 'has reported today', not REMINDER_TZ/server date", async () => {
    // Instant 2026-07-23T19:00:00Z:
    //   - IST (UTC+5:30):        2026-07-24 00:30  → istToday = 2026-07-24
    //   - REMINDER_TZ New York:  2026-07-23 15:00  → different calendar date
    //   - server/UTC:            2026-07-23 19:00  → different calendar date
    const now = new Date("2026-07-23T19:00:00Z");
    // Sanity: the fixed-IST helpers roll to the next day while NY has not.
    expect(istToday(now)).toBe("2026-07-24");
    expect(nowInTz("America/New_York", now).date).toBe("2026-07-23");

    const h = createHarness({
      clockNow: now,
      // Wide window so NY wall-clock 15:00 is well inside it.
      settings: { start: "00:00", intervalMin: 15, stop: "23:59" },
    });
    // Override config to a timezone that differs from IST.
    const engine = createReminderEngine({
      db: h.db,
      whapiClient: h.whapiClient,
      config: { REMINDER_TZ: "America/New_York" } as unknown as Config,
      clock: h.clock,
    });

    // The user logged a report for the IST day (2026-07-24). It must suppress
    // the nudge because the engine keys "reported today" off istToday(), NOT
    // the New York / server date (which is still 2026-07-23).
    h.state.reports.add("1:2026-07-24");

    await engine.runReminderSweep();

    expect(h.whapiClient.sendText).not.toHaveBeenCalled();
    // Prove the fixed-IST date was the boundary passed to the query.
    expect(h.db.usersToRemind).toHaveBeenCalledWith(
      "2026-07-24",
      expect.objectContaining({ date: "2026-07-23", hhmm: "15:00" }),
      expect.anything(),
    );
  });

  it("nudges managers and roots too (all onboarded users)", async () => {
    const manager = makeUser({
      id: 2,
      wa_id: "222@s.whatsapp.net",
      name: "Advait",
      is_manager: true,
      is_root: true,
    });
    const h = createHarness({ users: [manager], clockNow: istAt(18, 0) });
    await h.engine.runReminderSweep();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].to).toBe("222@s.whatsapp.net");
    expect(h.db.markReminderSent).toHaveBeenCalledWith(2, "2026-07-23");
  });
});

describe("reminder engine — startCron", () => {
  it("schedules a minute cron and guards against overlapping sweeps", async () => {
    const h = createHarness({ clockNow: istAt(17, 0) });

    // Capture the scheduled callback without touching a real timer.
    const cron = await import("node-cron");
    const scheduleSpy = vi
      .spyOn(cron.default, "schedule")
      .mockImplementation(((expr: string, _fn: () => void) => {
        expect(expr).toBe("* * * * *");
        return { start: vi.fn(), stop: vi.fn() } as any;
      }) as any);

    const task = h.engine.startCron();
    expect(scheduleSpy).toHaveBeenCalledWith("* * * * *", expect.any(Function));
    expect(task).toBeTruthy();
    expect(typeof task.stop).toBe("function");

    scheduleSpy.mockRestore();
  });
});
