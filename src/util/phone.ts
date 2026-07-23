/**
 * Phone / WhatsApp-JID helpers.
 *
 * WhatsApp 1:1 JIDs look like `919812345678@s.whatsapp.net`. The phone is the
 * digits before the `@`. We normalize to a bare international digit string
 * (no `+`, no separators) which is what we store UNIQUE in `users.phone` and
 * use as the reconciliation key for pending managers.
 */

const USER_JID_SUFFIX = "@s.whatsapp.net";
const GROUP_JID_SUFFIX = "@g.us";

/**
 * Extract and normalize the phone from a WhatsApp JID (`<digits>@s.whatsapp.net`).
 * Returns null for group JIDs or anything that yields no digits.
 */
export function waIdToPhone(jid: string): string | null {
  if (!jid) return null;
  if (jid.endsWith(GROUP_JID_SUFFIX)) return null;
  const local = jid.includes("@") ? jid.split("@")[0] : jid;
  return normalizePhone(local);
}

/**
 * Normalize an arbitrary phone-ish string to digits only. Strips a leading
 * `+`, spaces, dashes, parentheses, and any `@...` JID suffix. Returns null if
 * no digits remain.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  const local = input.includes("@") ? input.split("@")[0] : input;
  const digits = local.replace(/\D+/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Validate a phone number: international digit string of a plausible length
 * (7–15 digits, per E.164 max of 15).
 */
export function isValidPhone(input: string): boolean {
  const digits = normalizePhone(input);
  return digits !== null && digits.length >= 7 && digits.length <= 15;
}

/** Build a canonical user JID from a normalized phone. */
export function phoneToWaId(phone: string): string {
  const digits = normalizePhone(phone);
  if (!digits) throw new Error(`invalid phone: ${input(phone)}`);
  return `${digits}${USER_JID_SUFFIX}`;
}

function input(v: string): string {
  return v.length > 40 ? v.slice(0, 40) + "…" : v;
}

/** True if a JID is a group chat (`@g.us`), which the bot ignores. */
export function isGroupJid(jid: string): boolean {
  return !!jid && jid.endsWith(GROUP_JID_SUFFIX);
}
