/**
 * Manager Q&A handler (Task 6).
 *
 * Produces the concrete `query` handler the router dispatches to
 * (`Handlers.query(user, text)`). Answers a manager's free-text question
 * grounded ONLY in the reports of people transitively below them in the org
 * tree (their subtree). Correctness rules:
 *
 *  - GUARD: only managers (derived `is_manager`) or roots reach data. The
 *    router already routes text→query only for managers, but a defensive guard
 *    here gives a plain IC (or a manager with an empty subtree) a gentle "no
 *    data to query" hint instead of leaking anything.
 *  - SCOPE: accessible ids = `getSubtreeUserIds(user.id)` (cycle-guarded CTE;
 *    a root sees its whole subtree). The subtree EXCLUDES the requester itself
 *    — a manager queries their reportees, not their own reports.
 *  - INTENT: `extractIntent(text)` (Zod-validated, safe fallback) →
 *    {person_name?, project_name?, date_phrase?, kind}.
 *  - PERSON filter: resolved DETERMINISTICALLY within the accessible ids
 *    (case-insensitive name match). Ambiguous (multiple matches) → ask to
 *    disambiguate; none found → "isn't in your team" (never leaks whether that
 *    person exists elsewhere).
 *  - PROJECT filter: `projects.findByNorm(project_name)` LOOKUP-ONLY (never
 *    creates). A named-but-unknown project yields no project id; the grounded
 *    answer then reports no data.
 *  - DATE range: `util/dates.istRange(date_phrase)` → concrete inclusive
 *    {from,to} in app code (default last 7 days). The LLM never invents dates.
 *  - ANSWER: fetch scoped reports, build a compact context, call `answer`
 *    (grounded-only), and `sendText` it. Empty scope / no reports → a friendly
 *    "no updates" reply. Answer LLM failure → retry-safe error reply.
 *
 * All dependencies are injected via factory params for testability.
 */

import type { Report, User } from "../db/queries";
import {
  getReportsForUsers as dbGetReportsForUsers,
  getSubtreeUserIds as dbGetSubtreeUserIds,
  getUsersByIds as dbGetUsersByIds,
  type ReportFilter,
} from "../db/queries";
import { WhapiClient } from "../whapi/client";
import { answer as defaultAnswer, extractIntent as defaultExtractIntent, type Intent } from "../openai/query";
import { istRange } from "../util/dates";
import { logger } from "../util/logger";
import { createProjects, type ProjectsModule } from "./projects";

const NO_SCOPE_REPLY =
  "You don't have any team members with reports to query yet.";
const NO_REPORTS_REPLY = "No updates found in that scope.";
const ANSWER_ERROR_REPLY =
  "Sorry, I couldn't answer that just now. Please try again in a moment.";

/** Whapi surface the query handler needs. */
export interface QueryWhapi {
  sendText(to: string, body: string): Promise<unknown>;
}

/** DB surface the query handler needs (injectable for tests). */
export interface QueryDb {
  getSubtreeUserIds(managerId: number): Promise<number[]>;
  getUsersByIds(ids: number[]): Promise<Pick<User, "id" | "name">[]>;
  getReportsForUsers(userIds: number[], filter: ReportFilter): Promise<Report[]>;
}

export type ExtractIntentFn = (question: string) => Promise<Intent>;
export type AnswerFn = (question: string, contextReports: unknown[]) => Promise<string>;

export interface QueryDeps {
  whapi?: QueryWhapi;
  db?: QueryDb;
  projects?: ProjectsModule;
  extractIntent?: ExtractIntentFn;
  answer?: AnswerFn;
  /** Injectable clock for IST date-range resolution; defaults to `new Date()`. */
  now?: () => Date;
}

export interface QueryHandler {
  handleQuery(user: User, text: string): Promise<void>;
}

const defaultDb: QueryDb = {
  getSubtreeUserIds: (id) => dbGetSubtreeUserIds(id),
  getUsersByIds: (ids) => dbGetUsersByIds(ids),
  getReportsForUsers: (ids, filter) => dbGetReportsForUsers(ids, filter),
};

export function createQueryHandler(deps: QueryDeps = {}): QueryHandler {
  const whapi: QueryWhapi = deps.whapi ?? new WhapiClient();
  const db: QueryDb = deps.db ?? defaultDb;
  const projects = deps.projects ?? createProjects();
  const extractIntent = deps.extractIntent ?? ((q) => defaultExtractIntent(q));
  const answer = deps.answer ?? ((q, ctx) => defaultAnswer(q, ctx));
  const now = deps.now ?? (() => new Date());

  return {
    async handleQuery(user: User, text: string): Promise<void> {
      // Defensive guard: only managers/roots may query. (Router already
      // enforces this; a plain IC somehow reaching here gets a gentle hint.)
      if (!user.is_manager && !user.is_root) {
        await whapi.sendText(user.wa_id, NO_SCOPE_REPLY);
        return;
      }

      // Scope: the requester's transitive reportees (excludes self).
      const accessibleIds = await db.getSubtreeUserIds(user.id);
      if (accessibleIds.length === 0) {
        await whapi.sendText(user.wa_id, NO_SCOPE_REPLY);
        return;
      }

      // Structured intent (safe fallback on any failure).
      const intent = await extractIntent(text);

      // Person filter — resolved DETERMINISTICALLY within the accessible ids.
      let personIds: number[] | null = null;
      if (intent.person_name) {
        const members = await db.getUsersByIds(accessibleIds);
        const wanted = intent.person_name.trim().toLowerCase();
        const matches = members.filter(
          (m) => (m.name ?? "").trim().toLowerCase() === wanted,
        );
        if (matches.length === 0) {
          // Do NOT leak whether the person exists elsewhere in the org.
          await whapi.sendText(
            user.wa_id,
            `I couldn't find "${intent.person_name}" in your team.`,
          );
          return;
        }
        if (matches.length > 1) {
          await whapi.sendText(
            user.wa_id,
            `There are multiple people named "${intent.person_name}" in your team. Could you be more specific?`,
          );
          return;
        }
        personIds = [matches[0].id];
      }

      // Project filter — LOOKUP-ONLY (never creates a project).
      let projectId: number | undefined;
      if (intent.project_name) {
        const project = await projects.findByNorm(intent.project_name);
        // If the named project doesn't exist, leave projectId undefined; the
        // grounded answer will simply report no matching data.
        if (project) projectId = project.id;
      }

      // Date range — converted to a concrete inclusive IST range in app code.
      // The LLM only ever supplies a relative phrase; it never invents dates.
      const { from, to } = istRange(intent.date_phrase, now());

      const targetIds = personIds ?? accessibleIds;
      const filter: ReportFilter = { from, to };
      if (projectId != null) filter.projectId = projectId;

      const reports = await db.getReportsForUsers(targetIds, filter);
      if (reports.length === 0) {
        await whapi.sendText(user.wa_id, NO_REPORTS_REPLY);
        return;
      }

      // Compact, grounded context: reporter name + date + structured fields +
      // linked project names (from the structured report's own projects list).
      const nameById = new Map<number, string | null>();
      const members = await db.getUsersByIds(accessibleIds);
      for (const m of members) nameById.set(m.id, m.name);

      const context = reports.map((r) => ({
        reporter: nameById.get(r.user_id) ?? "Unknown",
        date: r.report_date,
        summary: r.structured_json.summary,
        tasks_done: r.structured_json.tasks_done,
        blockers: r.structured_json.blockers,
        next_steps: r.structured_json.next_steps,
        projects: r.structured_json.projects,
      }));

      let reply: string;
      try {
        reply = await answer(text, context);
      } catch (err) {
        logger.error("query handler answer failed", { err, userId: user.id });
        await whapi.sendText(user.wa_id, ANSWER_ERROR_REPLY);
        return;
      }

      await whapi.sendText(
        user.wa_id,
        reply && reply.trim().length > 0 ? reply.trim() : NO_REPORTS_REPLY,
      );
    },
  };
}
