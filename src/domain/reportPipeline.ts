/**
 * Report pipeline (Task 4).
 *
 * Turns a daily update — text OR voice/audio — into exactly one stored report
 * with linked projects, then replies with an acknowledgement + an optional
 * contextual follow-up. Produces the concrete `report` handler the
 * router/processor dispatch to (`Handlers.report(user, msg)`).
 *
 * Flow:
 *  - voice/audio: `downloadMedia(mediaId)` → `transcribe({buffer,contentType})`
 *    → transcript + detected language; `source_kind` = msg media type
 *    ('voice' | 'audio').
 *  - text: use `msg.text` directly as the transcript; skip download+transcribe;
 *    `language` = 'text-provided'; `source_kind` = 'text'.
 *  - both converge: `structure(transcript, language?)` → for each non-empty
 *    project name `projects.matchOrCreate` → `insertReportWithProjects` in one
 *    tx with `ON CONFLICT(source_message_id) DO NOTHING` (dedup).
 *  - AFTER commit (CHANGE B): fetch the user's recent reports (EXCLUDING the
 *    just-inserted row) → `acknowledgeAndFollowup` → send the acknowledgement,
 *    and the follow-up only when non-empty. On follow-up LLM/Zod failure, send a
 *    basic static acknowledgement and skip the follow-up (the report is already
 *    committed).
 *
 * Failure behavior:
 *  - media download / transcription failure (voice only) → friendly "please
 *    resend" reply; NO partial report; the message is handled (returns normally
 *    so the processor marks it `done` — reprocessing the same failed media
 *    would not help).
 *  - empty/blank text body → ask for a non-empty update; nothing stored.
 *  - unexpected/transient failures (e.g. a DB error) propagate (throw) so the
 *    processor marks the row `failed` and a retry is safe (dedup on
 *    source_message_id).
 *
 * Every external dependency (Whapi client, OpenAI fns, projects, db queries,
 * config) is injected so the pipeline is unit-testable with mocks.
 */

import type { NewReport, Report, StructuredReport, User } from "../db/queries";
import {
  getRecentReportsForUser as dbGetRecentReportsForUser,
  insertReportWithProjects as dbInsertReportWithProjects,
} from "../db/queries";
import type { ParsedMessage } from "../whapi/types";
import { WhapiClient } from "../whapi/client";
import { transcribe as defaultTranscribe } from "../openai/transcribe";
import { structure as defaultStructure, type StructureResult } from "../openai/structure";
import { acknowledgeAndFollowup as defaultAcknowledgeAndFollowup } from "../openai/followup";
import { loadConfig } from "../config";
import { istToday } from "../util/dates";
import { logger } from "../util/logger";
import { createProjects, type ProjectsModule } from "./projects";

/** Static acknowledgement used when the follow-up LLM/Zod path fails. */
export const PIPELINE_STATIC_ACK = "✅ Got your update for today, thanks!";

const MEDIA_ERROR_REPLY =
  "Sorry, I couldn't fetch or read your voice note. Please try sending it again.";
const EMPTY_TEXT_REPLY =
  "Your update looks empty — please send your daily update as a text message or a voice note.";

/** Whapi surface the pipeline needs. */
export interface ReportWhapi {
  sendText(to: string, body: string): Promise<unknown>;
  downloadMedia(mediaId: string): Promise<{ buffer: Buffer; contentType: string }>;
}

/** DB surface the pipeline needs. */
export interface ReportDb {
  insertReportWithProjects(
    report: NewReport,
    projectIds: number[],
  ): Promise<{ report: Report; inserted: boolean }>;
  getRecentReportsForUser(userId: number, limit: number): Promise<Report[]>;
}

export type TranscribeFn = (input: {
  buffer: Buffer;
  contentType: string;
}) => Promise<{ text: string; language: string | null }>;

export type StructureFn = (
  transcriptOrText: string,
  language?: string,
) => Promise<StructureResult>;

export type AcknowledgeFn = (
  todayReport: unknown,
  recentReports: unknown[],
) => Promise<{ acknowledgement: string; followup: string | null }>;

export interface ReportPipelineDeps {
  whapi?: ReportWhapi;
  db?: ReportDb;
  projects?: ProjectsModule;
  transcribe?: TranscribeFn;
  structure?: StructureFn;
  acknowledgeAndFollowup?: AcknowledgeFn;
  /** Recent-reports window for the follow-up call; defaults to config. */
  recentReportsForFollowup?: number;
  /** Injectable clock for the IST report date; defaults to `new Date()`. */
  now?: () => Date;
}

export interface ReportPipeline {
  handleReport(user: User, msg: ParsedMessage): Promise<void>;
}

export function createReportPipeline(deps: ReportPipelineDeps = {}): ReportPipeline {
  const whapi: ReportWhapi = deps.whapi ?? new WhapiClient();
  const db: ReportDb = deps.db ?? {
    insertReportWithProjects: dbInsertReportWithProjects,
    getRecentReportsForUser: dbGetRecentReportsForUser,
  };
  const projects = deps.projects ?? createProjects();
  const transcribe = deps.transcribe ?? ((input) => defaultTranscribe(input));
  const structure = deps.structure ?? ((t, l) => defaultStructure(t, l));
  const acknowledgeAndFollowup =
    deps.acknowledgeAndFollowup ??
    ((today, recent) => defaultAcknowledgeAndFollowup(today, recent));
  const now = deps.now ?? (() => new Date());

  function recentLimit(): number {
    if (deps.recentReportsForFollowup != null) return deps.recentReportsForFollowup;
    return loadConfig().RECENT_REPORTS_FOR_FOLLOWUP;
  }

  /**
   * Resolve the transcript + language + source_kind for the message. Returns
   * null after having already replied to the user for an expected input error
   * (bad media, empty text) so the caller stops without storing anything.
   */
  async function resolveTranscript(
    user: User,
    msg: ParsedMessage,
  ): Promise<{ transcript: string; language: string | null; sourceKind: string } | null> {
    const isMedia = Boolean(msg.mediaId);
    if (isMedia) {
      const sourceKind = msg.mediaType === "audio" ? "audio" : "voice";
      let media: { buffer: Buffer; contentType: string };
      try {
        media = await whapi.downloadMedia(msg.mediaId as string);
      } catch (err) {
        logger.error("report pipeline media download failed", { err, userId: user.id, msgId: msg.id });
        await whapi.sendText(user.wa_id, MEDIA_ERROR_REPLY);
        return null;
      }
      let transcription: { text: string; language: string | null };
      try {
        transcription = await transcribe({ buffer: media.buffer, contentType: media.contentType });
      } catch (err) {
        logger.error("report pipeline transcription failed", { err, userId: user.id, msgId: msg.id });
        await whapi.sendText(user.wa_id, MEDIA_ERROR_REPLY);
        return null;
      }
      return {
        transcript: transcription.text ?? "",
        language: transcription.language,
        sourceKind,
      };
    }

    // Text path.
    const body = (msg.text ?? "").trim();
    if (!body) {
      await whapi.sendText(user.wa_id, EMPTY_TEXT_REPLY);
      return null;
    }
    return { transcript: body, language: "text-provided", sourceKind: "text" };
  }

  /** After a fresh insert, send the acknowledgement + optional follow-up. */
  async function acknowledge(user: User, inserted: Report): Promise<void> {
    const limit = recentLimit();
    // Fetch one extra so we still have `limit` after excluding the just-inserted row.
    let recent: Report[] = [];
    try {
      recent = await db.getRecentReportsForUser(user.id, limit + 1);
    } catch (err) {
      logger.error("report pipeline recent-reports fetch failed", { err, userId: user.id });
      recent = [];
    }
    const recentStructured = recent
      .filter((r) => r.id !== inserted.id)
      .slice(0, limit)
      .map((r) => r.structured_json);

    let ack = PIPELINE_STATIC_ACK;
    let followup: string | null = null;
    try {
      const result = await acknowledgeAndFollowup(inserted.structured_json, recentStructured);
      ack = result.acknowledgement && result.acknowledgement.trim().length > 0
        ? result.acknowledgement
        : PIPELINE_STATIC_ACK;
      followup = result.followup;
    } catch (err) {
      // LLM/Zod failure: report is already committed — degrade to a static ack.
      logger.error("report pipeline acknowledge/followup failed, using static ack", {
        err,
        userId: user.id,
      });
      ack = PIPELINE_STATIC_ACK;
      followup = null;
    }

    await whapi.sendText(user.wa_id, ack);
    if (typeof followup === "string" && followup.trim().length > 0) {
      await whapi.sendText(user.wa_id, followup.trim());
    }
  }

  return {
    async handleReport(user: User, msg: ParsedMessage): Promise<void> {
      const resolved = await resolveTranscript(user, msg);
      if (!resolved) return; // expected input error already handled + replied.

      const { transcript, language, sourceKind } = resolved;

      // Structure the update (Zod-validated; falls back internally on failure).
      const structured: StructureResult = await structure(
        transcript,
        language ?? undefined,
      );

      // Resolve project ids for each non-empty structured project name.
      const projectIds: number[] = [];
      for (const rawName of structured.projects) {
        if (!rawName || !rawName.trim()) continue;
        const project = await projects.matchOrCreate(rawName);
        if (project) projectIds.push(project.id);
      }

      // Strip the internal `_fallback` flag from what we persist.
      const { _fallback, ...structuredJson } = structured;
      void _fallback;

      const newReport: NewReport = {
        user_id: user.id,
        report_date: istToday(now()),
        raw_transcript: transcript,
        structured_json: structuredJson as StructuredReport,
        source_kind: sourceKind,
        language,
        source_message_id: msg.id,
      };

      // Single tx; dedup on source_message_id. Let DB errors propagate (throw →
      // processor marks the row `failed`; retry is safe via the dedup).
      const { report, inserted } = await db.insertReportWithProjects(newReport, projectIds);

      if (!inserted) {
        // Duplicate delivery of an already-processed message — do NOT send a
        // second acknowledgement.
        logger.info("report pipeline dedup: skipping duplicate", {
          userId: user.id,
          msgId: msg.id,
        });
        return;
      }

      await acknowledge(user, report);
    },
  };
}
