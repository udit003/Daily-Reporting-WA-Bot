/**
 * Message router (CHANGE D + F; single source of truth for routing).
 *
 * Follows the plan's routing ladder EXACTLY. Depends only on injected
 * dependencies (db queries, whapi client, an OpenAI classify fn, the settings
 * module, buildHelpMessage, and the `Handlers` interface) so it compiles
 * without importing Task 4/5/6 concretes (MUST-FIX 12) and is unit-testable
 * with mocks.
 */

import type { User } from "../db/queries";
import type { ParsedMessage } from "../whapi/types";
import type { Handlers } from "./types";
import type { SettingsModule } from "./settings";
import { buildHelpMessage as defaultBuildHelpMessage } from "./help";
import { logger } from "../util/logger";

/** DB surface the router needs. */
export interface RouterDb {
  getUserByWaId(waId: string): Promise<User | null>;
  getSubtreeUserIds(managerId: number): Promise<number[]>;
}

/** Whapi surface the router needs. */
export interface RouterWhapi {
  sendText(to: string, body: string): Promise<unknown>;
}

/** Classify manager text as REPORT vs QUERY (QUERY on error/low-confidence). */
export type ClassifyFn = (text: string) => Promise<{ label: "REPORT" | "QUERY" }>;

export interface RouterDeps {
  db: RouterDb;
  whapi: RouterWhapi;
  classify: ClassifyFn;
  settings: SettingsModule;
  handlers: Handlers;
  buildHelpMessage?: (user: Pick<User, "is_manager" | "is_root">) => string;
}

export interface Router {
  route(msg: ParsedMessage): Promise<void>;
}

const INTERROGATIVE_PREFIX_RE =
  /^(what|who|when|where|why|how|which|is|are|did|does|can|show|list)\b/i;

const REPLY_ID_PREFIXES = ["mgr_id:", "mgr:none", "mgr:pending", "nav:more:"];

function isOnboardingReplyId(id: string): boolean {
  return REPLY_ID_PREFIXES.some((p) => id === p || id.startsWith(p));
}

export function createRouter(deps: RouterDeps): Router {
  const buildHelp = deps.buildHelpMessage ?? defaultBuildHelpMessage;

  async function isManager(user: User): Promise<boolean> {
    if (user.is_manager) return true;
    // Derived fallback: has ≥1 descendant. (is_manager should already be set by
    // onboarding/reconciliation, but stay correct if the flag lags.)
    try {
      const descs = await deps.db.getSubtreeUserIds(user.id);
      return descs.length > 0;
    } catch (err) {
      logger.error("router isManager subtree lookup failed", { err, userId: user.id });
      return false;
    }
  }

  return {
    async route(msg: ParsedMessage): Promise<void> {
      // Ignore our own messages and reject group chats (no reply).
      if (msg.from_me) return;
      if (msg.is_group) return;

      const user = await deps.db.getUserByWaId(msg.wa_id);
      const text = (msg.text ?? "").trim();
      const lower = text.toLowerCase();

      // --- ONBOARDING TRIGGER (CHANGE D) ---
      // Unknown sender OR not yet done → onboarding, regardless of content.
      if (!user || user.onboarding_state !== "done") {
        await deps.handlers.onboarding.handle(user, msg);
        return;
      }

      // From here the user is onboarded (onboarding_state === 'done').

      // `onboard` keyword from a not-in-flow (done) sender restarts onboarding.
      if (lower === "onboard") {
        await deps.handlers.onboarding.handle(user, msg);
        return;
      }

      // Memoized derived-manager lookup (avoids duplicate subtree queries).
      let managerCache: boolean | undefined;
      const managerOrRoot = async (): Promise<boolean> => {
        if (user.is_root) return true;
        if (managerCache === undefined) managerCache = await isManager(user);
        return managerCache;
      };

      // --- HELP / MENU keyword (CHANGE F) — before report/query classification.
      if (lower === "help" || lower === "menu") {
        await deps.whapi.sendText(user.wa_id, buildHelp(user));
        return;
      }

      // --- STATUS / DIGEST keyword (CHANGE G) — managers/roots only, checked
      // after help/menu and BEFORE the admin/report/query ladder. For a plain
      // IC (no descendants, not root) these words are NOT a command — fall
      // through to normal report handling (text from a non-manager → report).
      if (lower === "status" || lower === "digest" || lower === "today") {
        if (await managerOrRoot()) {
          await deps.handlers.statusDigest(user);
          return;
        }
        // Plain IC: intentionally fall through — handled as a normal report below.
      }

      // Onboarding reply ids outside onboarding are stale/unknown → hint.
      if (msg.reply && isOnboardingReplyId(msg.reply.id)) {
        await deps.whapi.sendText(
          user.wa_id,
          "That option has expired. Send your daily update as a text or voice note, or type *help* for options.",
        );
        return;
      }

      // --- Voice / audio from anyone → REPORT. Always.
      if (msg.mediaType === "voice" || msg.mediaType === "audio" || msg.mediaId) {
        await deps.handlers.report(user, msg);
        return;
      }

      // Non-text, non-media, non-reply (e.g. unsupported type) → hint.
      if (!text) {
        await deps.whapi.sendText(
          user.wa_id,
          "Please send your daily update as a text message or a voice note, or type *help* for options.",
        );
        return;
      }

      const manager = await managerOrRoot();

      // --- Text from a non-manager → REPORT.
      if (!manager) {
        await deps.handlers.report(user, msg);
        return;
      }

      // --- Text from a manager → disambiguate (fixed order). ---

      // (a) Root admin command (any is_root user — CHANGE E).
      if (user.is_root) {
        const ack = await deps.settings.parseAdminCommand(text);
        if (ack !== null) {
          await deps.whapi.sendText(user.wa_id, ack);
          return;
        }
      }

      // (b) Keyword escape hatch (deterministic).
      const reportHatch = /^report:\s*/i;
      const queryHatch = /^(ask|query):\s*/i;
      if (reportHatch.test(text)) {
        const stripped = text.replace(reportHatch, "");
        await deps.handlers.report(user, { ...msg, text: stripped });
        return;
      }
      if (queryHatch.test(text)) {
        const stripped = text.replace(queryHatch, "");
        await deps.handlers.query(user, stripped);
        return;
      }

      // (c) Cheap heuristics: trailing `?` or interrogative prefix → QUERY.
      if (text.endsWith("?") || INTERROGATIVE_PREFIX_RE.test(text)) {
        await deps.handlers.query(user, text);
        return;
      }

      // (d) LLM classifier (QUERY on error via classify's own fallback).
      let label: "REPORT" | "QUERY" = "QUERY";
      try {
        const res = await deps.classify(text);
        label = res.label;
      } catch (err) {
        // (e) Fallback → QUERY.
        logger.error("router classify failed, defaulting to QUERY", {
          err,
          userId: user.id,
        });
        label = "QUERY";
      }

      if (label === "REPORT") {
        await deps.handlers.report(user, msg);
      } else {
        await deps.handlers.query(user, text);
      }
    },
  };
}
