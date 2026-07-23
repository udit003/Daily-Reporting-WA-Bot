/**
 * Onboarding state machine (CHANGE C + E + F).
 *
 * States: new → ask_name → ask_manager → [ask_pending_manager_phone] → done.
 *
 * Only name + manager are collected; the phone is captured automatically from
 * the WhatsApp JID and the user is never asked for it. `is_manager` is derived
 * (never asked). Multiple top-level roots are allowed (mgr:none is always
 * accepted — CHANGE E). On reaching `done`, pending-manager reconciliation runs
 * and the user is sent their role-based help menu (CHANGE F), computed AFTER
 * reconciliation so derived flags are current.
 *
 * Dependencies are injected so the handler is unit-testable with mocks.
 */

import type {
  NewUser,
  OnboardingUpdate,
  SetManagerResult,
  User,
} from "../db/queries";
import type { ParsedMessage } from "../whapi/types";
import type { OnboardingHandler } from "./types";
import { buildHelpMessage as defaultBuildHelpMessage } from "./help";
import { isValidPhone, normalizePhone, waIdToPhone } from "../util/phone";
import { normalizeName } from "../util/name";
import { logger } from "../util/logger";

/** DB surface the onboarding handler needs (injectable for tests). */
export interface OnboardingDb {
  insertUser(input: NewUser): Promise<User>;
  updateUserOnboarding(userId: number, patch: OnboardingUpdate): Promise<User | null>;
  setUserManager(userId: number, managerId: number): Promise<SetManagerResult>;
  setRoot(userId: number): Promise<{ ok: boolean }>;
  reconcilePendingManagers(phone: string): Promise<unknown>;
  listOnboardedUsers(offset: number, limit: number): Promise<User[]>;
  countOnboardedUsers(): Promise<number>;
  getUserById(id: number): Promise<User | null>;
  /**
   * Look up a pre-known CXO by NORMALIZED name (case/whitespace/punctuation
   * insensitive). Returns the canonical display name or null.
   */
  findCxoByNormName(normName: string): Promise<{ id: number; name: string } | null>;
}

/** Whapi surface the onboarding handler needs. */
export interface OnboardingWhapi {
  sendText(to: string, body: string): Promise<unknown>;
  sendListPage(
    to: string,
    body: string,
    buttonText: string,
    rows: { id: string; title: string; description?: string }[],
    offset: number,
    total: number,
  ): Promise<unknown>;
}

export interface OnboardingDeps {
  db: OnboardingDb;
  whapi: OnboardingWhapi;
  buildHelpMessage?: (user: Pick<User, "is_manager" | "is_root">) => string;
}

// A generous upper bound for the onboarded-user list; the picker paginates via
// sendListPage's 9-row windows so the full ordered set is fetched once per page.
const MAX_PICKER_USERS = 500;

const GREETING =
  "👋 Welcome! Let's get you set up. What's your name?";

function askManagerBody(): string {
  return "Great! Who's your manager? Pick from the list below.";
}

export function createOnboardingHandler(deps: OnboardingDeps): OnboardingHandler {
  const buildHelp = deps.buildHelpMessage ?? defaultBuildHelpMessage;

  async function presentManagerPicker(user: User, offset: number): Promise<void> {
    const users = await deps.db.listOnboardedUsers(0, MAX_PICKER_USERS);
    const rows: { id: string; title: string; description?: string }[] = [
      {
        id: "mgr:none",
        title: "I'm at the top level",
        description: "I have no manager",
      },
      {
        id: "mgr:pending",
        title: "My manager hasn't joined yet",
      },
      ...users
        .filter((u) => u.id !== user.id)
        .map((u) => ({
          id: `mgr_id:${u.id}`,
          title: u.name ?? `User ${u.id}`,
        })),
    ];
    await deps.whapi.sendListPage(
      user.wa_id,
      askManagerBody(),
      "Select manager",
      rows,
      offset,
      rows.length,
    );
  }

  /** Reach the `done` state: persist, reconcile, then send the role-based menu. */
  async function finish(user: User): Promise<void> {
    await deps.db.updateUserOnboarding(user.id, { onboarding_state: "done" });
    try {
      await deps.db.reconcilePendingManagers(user.phone);
    } catch (err) {
      logger.error("onboarding reconcile failed", { err, userId: user.id });
    }
    // Recompute derived flags AFTER reconciliation so the menu is current.
    const fresh = (await deps.db.getUserById(user.id)) ?? user;
    await deps.whapi.sendText(fresh.wa_id, buildHelp(fresh));
  }

  return {
    async handle(user: User | null, msg: ParsedMessage): Promise<void> {
      const text = (msg.text ?? "").trim();
      const lower = text.toLowerCase();
      const isOnboardKeyword = lower === "onboard";

      // First contact: create the user row (phone auto-captured), greet, ask name.
      if (!user) {
        const phone = waIdToPhone(msg.wa_id) ?? normalizePhone(msg.wa_id);
        if (!phone) {
          await deps.whapi.sendText(
            msg.wa_id,
            "Sorry, I couldn't read your number. Please message me from a personal WhatsApp chat.",
          );
          return;
        }
        const created = await deps.db.insertUser({
          wa_id: msg.wa_id,
          phone,
          onboarding_state: "ask_name",
        });
        await deps.whapi.sendText(created.wa_id, GREETING);
        return;
      }

      // `onboard` keyword from an already-onboarded user restarts onboarding.
      if (isOnboardKeyword && user.onboarding_state === "done") {
        await deps.db.updateUserOnboarding(user.id, {
          onboarding_state: "ask_name",
        });
        await deps.whapi.sendText(user.wa_id, GREETING);
        return;
      }

      switch (user.onboarding_state) {
        case "new": {
          await deps.db.updateUserOnboarding(user.id, {
            onboarding_state: "ask_name",
          });
          await deps.whapi.sendText(user.wa_id, GREETING);
          return;
        }

        case "ask_name": {
          if (!text) {
            await deps.whapi.sendText(
              user.wa_id,
              "Please tell me your name to continue.",
            );
            return;
          }
          // A pre-known CXO (matched case/whitespace/punctuation-insensitively)
          // is auto-elevated to a top-level root and skips the manager picker.
          const cxo = await deps.db.findCxoByNormName(normalizeName(text));
          if (cxo) {
            await deps.db.updateUserOnboarding(user.id, {
              name: cxo.name,
              onboarding_state: "ask_manager",
            });
            await deps.db.setRoot(user.id);
            const rootUser = (await deps.db.getUserById(user.id)) ?? {
              ...user,
              name: cxo.name,
            };
            await finish(rootUser);
            return;
          }
          const updated =
            (await deps.db.updateUserOnboarding(user.id, {
              name: text,
              onboarding_state: "ask_manager",
            })) ?? { ...user, name: text, onboarding_state: "ask_manager" as const };
          await presentManagerPicker(updated, 0);
          return;
        }

        case "ask_manager": {
          const reply = msg.reply;
          if (!reply) {
            // Nudge the user to use the list.
            await presentManagerPicker(user, 0);
            return;
          }
          const id = reply.id;

          if (id.startsWith("nav:more:")) {
            const offset = Number(id.slice("nav:more:".length));
            await presentManagerPicker(
              user,
              Number.isFinite(offset) && offset > 0 ? offset : 0,
            );
            return;
          }

          if (id === "mgr:none") {
            // CHANGE E: always allowed; multiple co-equal roots are fine.
            await deps.db.setRoot(user.id);
            const rootUser = (await deps.db.getUserById(user.id)) ?? user;
            await finish(rootUser);
            return;
          }

          if (id === "mgr:pending") {
            await deps.db.updateUserOnboarding(user.id, {
              onboarding_state: "ask_pending_manager_phone",
            });
            await deps.whapi.sendText(
              user.wa_id,
              "No problem. What's your manager's phone number (with country code)? I'll link you up when they join.",
            );
            return;
          }

          if (id.startsWith("mgr_id:")) {
            const managerId = Number(id.slice("mgr_id:".length));
            if (!Number.isInteger(managerId)) {
              await presentManagerPicker(user, 0);
              return;
            }
            const res = await deps.db.setUserManager(user.id, managerId);
            if (res.ok) {
              await finish(user);
              return;
            }
            // Cycle / self refusal — explain and re-present the picker.
            const reason =
              res.reason === "self"
                ? "You can't pick yourself as your manager."
                : "That person reports to you, so they can't be your manager.";
            await deps.whapi.sendText(user.wa_id, `${reason} Please pick again.`);
            await presentManagerPicker(user, 0);
            return;
          }

          // Unknown id while in the manager step — re-present.
          await presentManagerPicker(user, 0);
          return;
        }

        case "ask_pending_manager_phone": {
          if (!text || !isValidPhone(text)) {
            await deps.whapi.sendText(
              user.wa_id,
              "That doesn't look like a valid phone number. Please send your manager's number with country code.",
            );
            return;
          }
          const phone = normalizePhone(text)!;
          await deps.db.updateUserOnboarding(user.id, {
            pending_manager_phone: phone,
          });
          await finish(user);
          return;
        }

        case "done":
        default:
          // Already onboarded and not an `onboard` restart — nothing to do.
          return;
      }
    },
  };
}
