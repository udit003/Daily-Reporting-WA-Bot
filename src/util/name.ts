/**
 * Person-name normalization.
 *
 * Used to match a name a user types during onboarding against known CXO names
 * (see the `cxos` table + scripts/seed.ts) WITHOUT caring about case,
 * surrounding/inner whitespace, or punctuation. So "Gopal Narang",
 * "gopal  narang", "GOPAL NARANG" and "Gopal, Narang" all normalize equal.
 *
 * Rules: lowercase; replace any run of non-alphanumeric characters with a
 * single space; trim; collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
