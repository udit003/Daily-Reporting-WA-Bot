/**
 * Date / timezone helpers.
 *
 * Report & query DAY semantics are FIXED to Asia/Kolkata (IST, UTC+5:30, no
 * DST) regardless of the server's local timezone or the reminder `REMINDER_TZ`.
 * We derive calendar dates via `Intl.DateTimeFormat` with an explicit
 * `timeZone`, never from server-local time.
 *
 * Dates are represented as `YYYY-MM-DD` strings, which map directly onto the
 * Postgres `DATE` columns (`reports.report_date`, `users.reminder_day`).
 */

export const IST_TZ = "Asia/Kolkata";

export type DateRange = { from: string; to: string };

/** Format an instant as a `YYYY-MM-DD` calendar date in the given timezone. */
export function dateStringInTz(date: Date, tz: string): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The current IST calendar day as `YYYY-MM-DD`. */
export function istToday(now: Date = new Date()): string {
  return dateStringInTz(now, IST_TZ);
}

// --- pure YYYY-MM-DD arithmetic (timezone-independent once we have a date) ---

function ymdToUTCms(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/** Add (or subtract) whole days to a `YYYY-MM-DD` string. */
export function addDays(ymd: string, days: number): string {
  return utcMsToYmd(ymdToUTCms(ymd) + days * DAY_MS);
}

/** Day of week for a `YYYY-MM-DD` string: 0=Sunday .. 6=Saturday. */
export function dayOfWeek(ymd: string): number {
  return new Date(ymdToUTCms(ymd)).getUTCDay();
}

/**
 * Convert a supported relative date phrase to an inclusive IST `{from, to}`
 * range. Supported: "today", "last 7 days", "this week" (Monday..today).
 * Anything unrecognized defaults to "last 7 days" (the query handler's default
 * window).
 */
export function istRange(phrase: string | undefined | null, now: Date = new Date()): DateRange {
  const today = istToday(now);
  const p = (phrase ?? "").trim().toLowerCase();

  if (p === "today") {
    return { from: today, to: today };
  }

  if (p === "this week") {
    // Monday .. today, inclusive.
    const dow = dayOfWeek(today); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    return { from: addDays(today, -daysSinceMonday), to: today };
  }

  // "last 7 days" and default: today plus the 6 prior IST days, inclusive.
  return { from: addDays(today, -6), to: today };
}

// --- reminder-window (wall-clock) helpers ---

export type TzNow = { date: string; hhmm: string };

/**
 * Current wall-clock in the given timezone as `{date: 'YYYY-MM-DD', hhmm: 'HH:MM'}`.
 * Used to evaluate the reminder window `[start, stop]`.
 */
export function nowInTz(tz: string, now: Date = new Date()): TzNow {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // some engines emit 24 at midnight
  return { date: dateStringInTz(now, tz), hhmm: `${hour}:${get("minute")}` };
}

/**
 * Compare two `HH:MM` strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 */
export function hhmmCompare(a: string, b: string): number {
  const av = hhmmToMinutes(a);
  const bv = hhmmToMinutes(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/** Convert `HH:MM` to minutes-since-midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True if `hhmm` is within the inclusive `[start, stop]` window. */
export function isWithinWindow(hhmm: string, start: string, stop: string): boolean {
  return hhmmCompare(hhmm, start) >= 0 && hhmmCompare(hhmm, stop) <= 0;
}
