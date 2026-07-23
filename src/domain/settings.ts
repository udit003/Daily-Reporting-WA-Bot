/**
 * Runtime reminder settings (CHANGE A + E).
 *
 *  - `getReminderSettings()` reads the three reminder keys via db/queries.
 *  - `parseAdminCommand(text)` recognizes the three `set reminder ...` admin
 *    commands (case-insensitive), validates the value, upserts it, and returns
 *    an ack string — or null when `text` isn't an admin command.
 *
 * NOTE (CHANGE E): admin commands are allowed for ANY `is_root` user. This
 * module only parses/validates/applies; the ROOT gating lives in `router.ts`.
 *
 * A factory (`createSettingsModule`) makes the DB dependencies injectable for
 * unit tests; a default instance backed by the real queries is exported as
 * `settings`.
 */

import {
  getAllReminderSettings as realGetAllReminderSettings,
  upsertSetting as realUpsertSetting,
  type ReminderSettings,
} from "../db/queries";

export type { ReminderSettings } from "../db/queries";

export interface SettingsDeps {
  getAllReminderSettings: () => Promise<ReminderSettings>;
  upsertSetting: (key: string, value: string) => Promise<void>;
}

export interface SettingsModule {
  getReminderSettings(): Promise<ReminderSettings>;
  /** Returns an ack string if `text` is a valid admin command, else null. */
  parseAdminCommand(text: string): Promise<string | null>;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// `set reminder time HH:MM`
const TIME_RE = /^set\s+reminder\s+time\s+(\S+)\s*$/i;
// `set reminder stop HH:MM`
const STOP_RE = /^set\s+reminder\s+stop\s+(\S+)\s*$/i;
// `set reminder interval <min>`
const INTERVAL_RE = /^set\s+reminder\s+interval\s+(\S+)\s*$/i;

export function createSettingsModule(deps: SettingsDeps): SettingsModule {
  return {
    async getReminderSettings(): Promise<ReminderSettings> {
      return deps.getAllReminderSettings();
    },

    async parseAdminCommand(text: string): Promise<string | null> {
      const raw = (text ?? "").trim();
      if (!raw) return null;

      const time = TIME_RE.exec(raw);
      if (time) {
        const value = time[1];
        if (!HHMM_RE.test(value)) {
          return `Sorry, '${value}' isn't a valid time. Use 24-hour HH:MM, e.g. 'set reminder time 17:30'.`;
        }
        await deps.upsertSetting("reminder_start", value);
        return `✅ Reminder start time set to ${value}.`;
      }

      const stop = STOP_RE.exec(raw);
      if (stop) {
        const value = stop[1];
        if (!HHMM_RE.test(value)) {
          return `Sorry, '${value}' isn't a valid time. Use 24-hour HH:MM, e.g. 'set reminder stop 22:00'.`;
        }
        await deps.upsertSetting("reminder_stop", value);
        return `✅ Reminder stop time set to ${value}.`;
      }

      const interval = INTERVAL_RE.exec(raw);
      if (interval) {
        const value = interval[1];
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return `Sorry, '${value}' isn't a valid interval. Use a positive whole number of minutes, e.g. 'set reminder interval 15'.`;
        }
        await deps.upsertSetting("reminder_interval_min", String(n));
        return `✅ Reminder interval set to ${n} minute${n === 1 ? "" : "s"}.`;
      }

      return null;
    },
  };
}

/** Default settings module backed by the real DB queries. */
export const settings: SettingsModule = createSettingsModule({
  getAllReminderSettings: () => realGetAllReminderSettings(),
  upsertSetting: (key, value) => realUpsertSetting(key, value),
});
