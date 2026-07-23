import "dotenv/config";
import { z } from "zod";

/**
 * Typed, validated environment loader.
 *
 * - Required vars throw on start-up if missing/empty.
 * - Optional vars fall back to the documented defaults (see `.env.example`).
 * - Report/query day semantics are FIXED to Asia/Kolkata elsewhere; the
 *   reminder schedule values here are only initial seeds for the `settings`
 *   table.
 */

const nonEmpty = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(1, `${name} is required`);

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),

  WHAPI_TOKEN: nonEmpty("WHAPI_TOKEN"),
  WHAPI_BASE_URL: z.string().url().default("https://gate.whapi.cloud"),

  OPENAI_API_KEY: nonEmpty("OPENAI_API_KEY"),
  OPENAI_CHAT_MODEL: z.string().min(1).default("gpt-4o"),
  OPENAI_CLASSIFY_MODEL: z.string().min(1).default("gpt-4o-mini"),

  DATABASE_URL: nonEmpty("DATABASE_URL"),

  WEBHOOK_SECRET: nonEmpty("WEBHOOK_SECRET"),

  REMINDER_TZ: z.string().min(1).default("Asia/Kolkata"),
  REMINDER_START: hhmm.default("17:00"),
  REMINDER_INTERVAL_MIN: z.coerce.number().int().positive().default(15),
  REMINDER_STOP: hhmm.default("22:00"),

  RECENT_REPORTS_FOR_FOLLOWUP: z.coerce.number().int().positive().default(5),

  PROJECT_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),

  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(26_214_400),

  BOT_NUMBER: z.string().optional(),

  SEED_CEO_PHONE: z.string().optional(),
  SEED_CEO_NAME: z.string().min(1).default("Gopal Narang"),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | null = null;

/**
 * Parse and validate `process.env`. Throws a readable error listing every
 * missing/invalid required variable. Result is cached after first success.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Test-only helper to reset the cached config so a fresh env can be parsed.
 */
export function __resetConfigCache(): void {
  cached = null;
}
