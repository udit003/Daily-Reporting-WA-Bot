/**
 * Role-based command menu (CHANGE F).
 *
 * `buildHelpMessage(user)` composes a command menu from the user's DERIVED role
 * flags. Used in two places:
 *   (a) sent automatically when onboarding reaches `done`;
 *   (b) returned when an onboarded user sends the `help`/`menu` keyword.
 *
 * The caller is responsible for sending the returned string.
 */

import type { User } from "../db/queries";

/** Basic section — shown to every onboarded user. */
export const HELP_BASIC =
  "📝 Send your daily update anytime as a text message or a voice note.";
export const HELP_MENU_HINT = "Type *help* to see this menu again.";

/** Manager section — shown to users with ≥1 descendant (derived is_manager). */
export const HELP_MANAGER =
  "❓ Ask about your team, e.g. 'What's happening with Narang Vivenda?' or 'What did <name> do this week?'";

/** Daily-status digest section (CHANGE G) — shown to managers/roots. */
export const HELP_STATUS =
  "📊 Daily status: type *status* to see who has/hasn't reported today and a project-wise summary.";

/** Root section — shown to top-level roots (is_root). */
export const HELP_ROOT =
  "⏰ Tune reminders: 'set reminder time 17:30', 'set reminder interval 15', 'set reminder stop 22:00'.";

/**
 * Compose the role-based command menu for `user` from its derived role flags.
 * Order: basic → manager (if is_manager) → root (if is_root) → menu hint.
 */
export function buildHelpMessage(user: Pick<User, "is_manager" | "is_root">): string {
  const lines: string[] = [HELP_BASIC];
  if (user.is_manager) {
    lines.push(HELP_MANAGER);
    lines.push(HELP_STATUS);
  }
  if (user.is_root) lines.push(HELP_ROOT);
  lines.push(HELP_MENU_HINT);
  return lines.join("\n\n");
}
