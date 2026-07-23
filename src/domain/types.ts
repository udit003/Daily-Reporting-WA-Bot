/**
 * Shared domain types + the injectable `Handlers` interface.
 *
 * The router and processor depend ONLY on this interface (MUST-FIX 12): they
 * must compile without importing the Task 4/5/6 concrete handlers. Onboarding is
 * owned by this task, so it is concrete, but it is still surfaced through the
 * `OnboardingHandler` interface so the router stays decoupled and unit-testable.
 *
 * The concrete `report` and `query` handlers are wired in at the composition
 * root (Task 7) and injected as `Handlers`.
 */

import type { User } from "../db/queries";
import type { ParsedMessage } from "../whapi/types";

// Re-export the canonical shared types so downstream tasks/tests can import them
// from the domain layer.
export type { User } from "../db/queries";
export type { ParsedMessage } from "../whapi/types";

/**
 * Drives the onboarding state machine for a sender. `user` is null on first
 * contact (no row exists yet); the handler is responsible for creating it.
 */
export interface OnboardingHandler {
  handle(user: User | null, msg: ParsedMessage): Promise<void>;
}

/**
 * The set of concrete handlers the router dispatches to. `onboarding` is
 * concrete in Task 3; `report`, `query`, and `statusDigest` are injected at
 * composition (Tasks 4/6 via Task 7).
 */
export interface Handlers {
  onboarding: OnboardingHandler;
  /** Handle a daily report (text or voice/audio) from a user. */
  report: (user: User, msg: ParsedMessage) => Promise<void>;
  /** Handle a manager's free-text question. `text` is the (keyword-stripped) query. */
  query: (user: User, text: string) => Promise<void>;
  /**
   * Produce the daily status digest for a manager/root (CHANGE G): the
   * reported/pending split across their subtree plus a project-wise summary of
   * today's reports. Concrete impl lives in Task 6 (`digest.ts`).
   */
  statusDigest: (user: User) => Promise<void>;
}
