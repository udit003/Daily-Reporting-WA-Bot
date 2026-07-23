/**
 * Composition root (MUST-FIX 12) — the ONLY file that imports every concrete
 * domain handler and wires the whole service together.
 *
 * Responsibilities:
 *  1. Load + validate config (fail fast on missing required env).
 *  2. Create the shared pg pool and the shared Whapi client.
 *  3. Construct the concrete handlers via their factories (onboarding, report,
 *     query, statusDigest) and assemble the injectable `Handlers` object.
 *  4. Construct the router (db queries + whapi + OpenAI classify + settings +
 *     buildHelpMessage + Handlers) and the async processor (pool + router).
 *  5. Build the Fastify app and wire its webhook to record inbound + kick the
 *     processor.
 *  6. Start the minute reminder cron and keep its ScheduledTask handle.
 *  7. Listen on config.PORT (host 0.0.0.0) and install graceful shutdown.
 *
 * No other module imports the Task 4/5/6 concretes — they reach the router and
 * processor only through the `Handlers` interface defined in domain/types.ts.
 */

import type { ScheduledTask } from "node-cron";

import { loadConfig } from "./config";
import { getPool, closePool } from "./db/pool";
import * as queries from "./db/queries";
import { WhapiClient } from "./whapi/client";
import { classifyManagerText } from "./openai/query";
import { logger } from "./util/logger";

import { buildServer } from "./server";
import { createProcessor } from "./processor";
import { createRouter } from "./domain/router";
import { createOnboardingHandler } from "./domain/onboarding";
import { createReportPipeline } from "./domain/reportPipeline";
import { createQueryHandler } from "./domain/query";
import { createDigestHandler } from "./domain/digest";
import { settings } from "./domain/settings";
import { buildHelpMessage } from "./domain/help";
import { createReminderEngine } from "./cron/reminders";
import type { Handlers } from "./domain/types";

export interface App {
  /** Start listening + start the reminder cron. Resolves once listening. */
  start(): Promise<void>;
  /** Stop the cron, close the Fastify server and the pg pool. */
  stop(): Promise<void>;
}

/**
 * Wire every dependency and return an {@link App}. Building the app has no
 * network/DB side effects (the pool connects lazily and the cron only starts
 * in `start()`), so this is safe to import in a smoke test.
 */
export function buildApp(): App {
  const config = loadConfig(); // throws on missing/invalid required env.
  const pool = getPool();
  const whapi = new WhapiClient();

  // --- Concrete handlers (the only place these are constructed). ---
  const onboarding = createOnboardingHandler({
    db: {
      insertUser: (input) => queries.insertUser(input),
      updateUserOnboarding: (userId, patch) =>
        queries.updateUserOnboarding(userId, patch),
      setUserManager: (userId, managerId) =>
        queries.setUserManager(userId, managerId),
      setRoot: (userId) => queries.setRoot(userId),
      reconcilePendingManagers: (phone) =>
        queries.reconcilePendingManagers(phone),
      listOnboardedUsers: (offset, limit) =>
        queries.listOnboardedUsers(offset, limit),
      countOnboardedUsers: () => queries.countOnboardedUsers(),
      getUserById: (id) => queries.getUserById(id),
      findCxoByNormName: (normName) => queries.findCxoByNormName(normName),
    },
    whapi,
    buildHelpMessage,
  });

  const reportPipeline = createReportPipeline({ whapi });
  const queryHandler = createQueryHandler({ whapi });
  const digestHandler = createDigestHandler({ whapi });

  const handlers: Handlers = {
    onboarding,
    report: (user, msg) => reportPipeline.handleReport(user, msg),
    query: (user, text) => queryHandler.handleQuery(user, text),
    statusDigest: (user) => digestHandler.handleStatusDigest(user),
  };

  // --- Router (single source of truth for routing). ---
  const router = createRouter({
    db: {
      getUserByWaId: (waId) => queries.getUserByWaId(waId),
      getSubtreeUserIds: (managerId) => queries.getSubtreeUserIds(managerId),
    },
    whapi,
    classify: (text) => classifyManagerText(text),
    settings,
    handlers,
    buildHelpMessage,
  });

  // --- Async processor (per-sender advisory lock; ordered dispatch). ---
  const processor = createProcessor({ pool, route: router.route });

  // --- Fastify app: record inbound (fast-ack) + kick the processor. ---
  const app = buildServer({
    config,
    recordInbound: (msgId, waId, seq, raw) =>
      queries.recordInbound(msgId, waId, seq, raw),
    kickProcessor: () => processor.kick(),
  });

  // --- Escalating reminder engine (minute cron). ---
  const reminderEngine = createReminderEngine({ whapiClient: whapi, config });
  let cronTask: ScheduledTask | null = null;

  return {
    async start(): Promise<void> {
      await app.listen({ port: config.PORT, host: "0.0.0.0" });
      cronTask = reminderEngine.startCron();
      const base = `http://0.0.0.0:${config.PORT}`;
      logger.info("server listening", {
        url: base,
        health: `${base}/health`,
        // Local demo: log the full webhook path so it's easy to copy.
        webhook: `${base}/webhook/${config.WEBHOOK_SECRET}`,
      });
      logger.info("reminder cron started (every minute)");
    },

    async stop(): Promise<void> {
      if (cronTask) {
        try {
          cronTask.stop();
        } catch (err) {
          logger.error("failed to stop reminder cron", { err });
        }
        cronTask = null;
      }
      try {
        await app.close();
      } catch (err) {
        logger.error("failed to close Fastify server", { err });
      }
      try {
        await closePool();
      } catch (err) {
        logger.error("failed to close pg pool", { err });
      }
    },
  };
}

/** Bootstrap when run directly (`node dist/src/index.js` / `tsx src/index.ts`). */
async function main(): Promise<void> {
  const app = buildApp();
  await app.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only auto-start when executed as the entrypoint, so importing this module
// (e.g. in a smoke test) has no side effects.
if (require.main === module) {
  main().catch((err) => {
    logger.error("fatal startup error", { err });
    process.exit(1);
  });
}
