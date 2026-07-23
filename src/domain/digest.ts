/**
 * Status digest handler (Task 6 / CHANGE G).
 *
 * Produces the concrete `statusDigest` handler the router dispatches to
 * (`Handlers.statusDigest(user)`). Only reached for managers (derived
 * `is_manager`) or roots — the router enforces this; a defensive guard here
 * makes it safe in isolation.
 *
 * The digest has two parts, concatenated and sent as one message:
 *
 *  PART 1 — reported/pending split (DETERMINISTIC, no LLM):
 *    `getSubtreeReportedStatus(ids, istToday())` → split the subtree into who
 *    has vs hasn't reported TODAY (fixed Asia/Kolkata day), rendered with
 *    names. Empty subtree → a graceful "no team members yet" message.
 *
 *  PART 2 — project-wise summary (LLM, with deterministic fallback):
 *    `getReportsForUsersWithProjects(ids, {from:istToday, to:istToday})` →
 *    today's reports WITH their linked project names → `summarizeDigest` →
 *    a concise digest grouped by project + an "Other updates" bucket. On LLM
 *    failure, fall back to an app-side deterministic grouping (bucket each
 *    report's summary under each linked project; unlinked → "Other updates").
 *    No reports today → "No reports submitted yet today."
 *
 * All dependencies are injected via factory params for testability.
 */

import type { ReportWithProjects, SubtreeReportedStatus, User } from "../db/queries";
import {
  getReportsForUsersWithProjects as dbGetReportsForUsersWithProjects,
  getSubtreeReportedStatus as dbGetSubtreeReportedStatus,
  getSubtreeUserIds as dbGetSubtreeUserIds,
} from "../db/queries";
import { WhapiClient } from "../whapi/client";
import { summarizeDigest as defaultSummarizeDigest, type DigestReport } from "../openai/query";
import { istToday } from "../util/dates";
import { logger } from "../util/logger";

const EMPTY_SUBTREE_REPLY = "You have no team members yet.";
const NO_REPORTS_TODAY = "No reports submitted yet today.";

/** Whapi surface the digest handler needs. */
export interface DigestWhapi {
  sendText(to: string, body: string): Promise<unknown>;
}

/** DB surface the digest handler needs (injectable for tests). */
export interface DigestDb {
  getSubtreeUserIds(managerId: number): Promise<number[]>;
  getSubtreeReportedStatus(userIds: number[], istDate: string): Promise<SubtreeReportedStatus[]>;
  getReportsForUsersWithProjects(
    userIds: number[],
    filter: { from: string; to: string },
  ): Promise<ReportWithProjects[]>;
}

export type SummarizeDigestFn = (reports: DigestReport[]) => Promise<string>;

export interface DigestDeps {
  whapi?: DigestWhapi;
  db?: DigestDb;
  summarizeDigest?: SummarizeDigestFn;
  /** Injectable clock for the IST "today" boundary; defaults to `new Date()`. */
  now?: () => Date;
}

export interface DigestHandler {
  handleStatusDigest(user: User): Promise<void>;
}

const defaultDb: DigestDb = {
  getSubtreeUserIds: (id) => dbGetSubtreeUserIds(id),
  getSubtreeReportedStatus: (ids, date) => dbGetSubtreeReportedStatus(ids, date),
  getReportsForUsersWithProjects: (ids, filter) =>
    dbGetReportsForUsersWithProjects(ids, filter),
};

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name.trim() : "Unknown";

/** Render PART 1: the deterministic reported/pending split. */
export function renderReportedSplit(status: SubtreeReportedStatus[]): string {
  const reported = status.filter((s) => s.reported).map((s) => displayName(s.name));
  const pending = status.filter((s) => !s.reported).map((s) => displayName(s.name));
  const reportedLine = `✅ Reported (${reported.length})${reported.length ? ": " + reported.join(", ") : ""}`;
  const pendingLine = `⏳ Pending (${pending.length})${pending.length ? ": " + pending.join(", ") : ""}`;
  return `${reportedLine}\n${pendingLine}`;
}

/**
 * Deterministic app-side fallback for PART 2: group each report's summary line
 * under each linked project; reports with no linked project go under
 * "Other updates".
 */
export function buildDeterministicDigest(reports: ReportWithProjects[]): string {
  const byProject = new Map<string, string[]>();
  const other: string[] = [];

  for (const r of reports) {
    const reporter = displayName(r.reporter_name);
    const summary = r.structured_json.summary?.trim() || r.raw_transcript.trim();
    const line = `${reporter}: ${summary}`;
    const linked = (r.project_names ?? []).filter((p) => p && p.trim().length > 0);
    if (linked.length === 0) {
      other.push(line);
      continue;
    }
    for (const project of linked) {
      const key = project.trim();
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(line);
    }
  }

  const parts: string[] = [];
  for (const project of Array.from(byProject.keys()).sort()) {
    const points = byProject.get(project)!;
    parts.push(`*${project}*\n${points.map((p) => `• ${p}`).join("\n")}`);
  }
  if (other.length > 0) {
    parts.push(`*Other updates*\n${other.map((p) => `• ${p}`).join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : NO_REPORTS_TODAY;
}

/** Map a report-with-projects row into the compact shape `summarizeDigest` expects. */
function toDigestReport(r: ReportWithProjects): DigestReport {
  return {
    reporterName: displayName(r.reporter_name),
    projects: (r.project_names ?? []).filter((p) => p && p.trim().length > 0),
    summary: r.structured_json.summary ?? "",
    tasks_done: r.structured_json.tasks_done ?? [],
    blockers: r.structured_json.blockers ?? [],
    next_steps: r.structured_json.next_steps ?? [],
  };
}

export function createDigestHandler(deps: DigestDeps = {}): DigestHandler {
  const whapi: DigestWhapi = deps.whapi ?? new WhapiClient();
  const db: DigestDb = deps.db ?? defaultDb;
  const summarizeDigest = deps.summarizeDigest ?? ((reports) => defaultSummarizeDigest(reports));
  const now = deps.now ?? (() => new Date());

  return {
    async handleStatusDigest(user: User): Promise<void> {
      // Defensive guard (router already enforces manager/root).
      if (!user.is_manager && !user.is_root) {
        await whapi.sendText(user.wa_id, EMPTY_SUBTREE_REPLY);
        return;
      }

      const today = istToday(now());
      const accessibleIds = await db.getSubtreeUserIds(user.id);

      if (accessibleIds.length === 0) {
        await whapi.sendText(
          user.wa_id,
          `${EMPTY_SUBTREE_REPLY}\n\n${NO_REPORTS_TODAY}`,
        );
        return;
      }

      // PART 1 — deterministic reported/pending split.
      const status = await db.getSubtreeReportedStatus(accessibleIds, today);
      const part1 = renderReportedSplit(status);

      // PART 2 — project-wise summary (LLM, deterministic fallback).
      const reports = await db.getReportsForUsersWithProjects(accessibleIds, {
        from: today,
        to: today,
      });

      let part2: string;
      if (reports.length === 0) {
        part2 = NO_REPORTS_TODAY;
      } else {
        try {
          const summary = await summarizeDigest(reports.map(toDigestReport));
          part2 = summary && summary.trim().length > 0
            ? summary.trim()
            : buildDeterministicDigest(reports);
        } catch (err) {
          logger.error("status digest summarize failed, using deterministic fallback", {
            err,
            userId: user.id,
          });
          part2 = buildDeterministicDigest(reports);
        }
      }

      await whapi.sendText(user.wa_id, `📊 Today's status\n\n${part1}\n\n${part2}`);
    },
  };
}
