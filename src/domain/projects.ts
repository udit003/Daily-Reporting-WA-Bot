/**
 * Project auto-discovery (Task 4).
 *
 * Three operations, all keyed on the shared normalized project name
 * (`src/util/projectName.ts`, reused so normalization stays consistent across
 * the seed script, this pipeline, and the query handler):
 *
 *  - `normalize(name)`  — re-exported shared normalizer.
 *  - `matchOrCreate(name)` — pipeline path: normalize → exact match by
 *    `norm_name` → fuzzy match via pg_trgm `similarity >= PROJECT_MATCH_THRESHOLD`;
 *    on a match append the raw alias if new and return it, otherwise create the
 *    project with a conflict-safe upsert on `norm_name`.
 *  - `findByNorm(name)` — lookup-only (exact then similarity); NEVER writes.
 *    Used by the query handler (Task 6) so a question can never create a
 *    project.
 *
 * All DB access + the config threshold are injected so the module is
 * unit-testable with mocks.
 */

import { loadConfig } from "../config";
import {
  appendProjectAlias as dbAppendProjectAlias,
  findProjectByNorm as dbFindProjectByNorm,
  findProjectBySimilarity as dbFindProjectBySimilarity,
  matchOrCreateProject as dbMatchOrCreateProject,
  type Project,
} from "../db/queries";
import { normalizeProjectName } from "../util/projectName";

/** DB surface the projects module needs (injectable for tests). */
export interface ProjectsDb {
  findProjectByNorm(norm: string): Promise<Project | null>;
  findProjectBySimilarity(norm: string, threshold: number): Promise<Project | null>;
  appendProjectAlias(projectId: number, alias: string): Promise<Project | null>;
  matchOrCreateProject(canonical: string, norm: string): Promise<Project>;
}

export interface ProjectsDeps {
  db?: ProjectsDb;
  /** pg_trgm similarity cutoff; defaults to config `PROJECT_MATCH_THRESHOLD`. */
  threshold?: number;
}

export interface ProjectsModule {
  /** Shared normalizer: lowercase, strip boilerplate tokens, collapse spaces. */
  normalize(name: string): string;
  /**
   * Pipeline path: find an existing project (exact then fuzzy) or create one.
   * Appends the raw spoken alias to a matched project when it is new. Returns
   * null only for a blank/normalizes-to-empty name (callers already drop empty
   * project names, so this is defensive).
   */
  matchOrCreate(name: string): Promise<Project | null>;
  /** Lookup-only (exact then similarity); never creates. For the query handler. */
  findByNorm(name: string): Promise<Project | null>;
}

const defaultDb: ProjectsDb = {
  findProjectByNorm: (norm) => dbFindProjectByNorm(norm),
  findProjectBySimilarity: (norm, threshold) =>
    dbFindProjectBySimilarity(norm, threshold),
  appendProjectAlias: (id, alias) => dbAppendProjectAlias(id, alias),
  matchOrCreateProject: (canonical, norm) => dbMatchOrCreateProject(canonical, norm),
};

/** Re-exported shared normalizer (single source of truth). */
export function normalize(name: string): string {
  return normalizeProjectName(name);
}

export function createProjects(deps: ProjectsDeps = {}): ProjectsModule {
  const db = deps.db ?? defaultDb;
  const threshold = deps.threshold ?? loadConfig().PROJECT_MATCH_THRESHOLD;

  /** Best existing match for a normalized name: exact first, then fuzzy. */
  async function lookup(norm: string): Promise<Project | null> {
    const exact = await db.findProjectByNorm(norm);
    if (exact) return exact;
    return db.findProjectBySimilarity(norm, threshold);
  }

  return {
    normalize,

    async matchOrCreate(name: string): Promise<Project | null> {
      const raw = name.trim();
      const norm = normalize(name);
      if (!norm) return null;

      const match = await lookup(norm);
      if (match) {
        // Record the raw spoken variant as an alias when it adds something new.
        if (
          raw &&
          raw !== match.canonical_name &&
          !match.aliases.includes(raw)
        ) {
          const updated = await db.appendProjectAlias(match.id, raw);
          return updated ?? match;
        }
        return match;
      }

      // No match → create (conflict-safe upsert on norm_name).
      return db.matchOrCreateProject(raw || name, norm);
    },

    async findByNorm(name: string): Promise<Project | null> {
      const norm = normalize(name);
      if (!norm) return null;
      return lookup(norm);
    },
  };
}
