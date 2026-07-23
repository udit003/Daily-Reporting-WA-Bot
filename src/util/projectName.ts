/**
 * Project-name normalization.
 *
 * Normalized names are the conflict-safe uniqueness key (`projects.norm_name`)
 * and the target of trigram fuzzy matching. This helper is shared by the seed
 * script, the (Task 4) report pipeline, and tests so normalization stays
 * consistent everywhere.
 *
 * Rules: lowercase; drop boilerplate marketing words that add no discriminating
 * value for Narang Realty projects ("narang", "by courtyard", "residences");
 * strip non-alphanumeric noise to single spaces; collapse whitespace.
 */
export function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bby courtyard\b/g, " ")
    .replace(/\bresidences?\b/g, " ")
    .replace(/\bnarang\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
