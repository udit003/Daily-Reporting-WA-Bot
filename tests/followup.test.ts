import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  createReportPipeline,
  PIPELINE_STATIC_ACK,
  type ReportDb,
  type ReportWhapi,
} from "../src/domain/reportPipeline";
import { FollowupError } from "../src/openai/followup";
import type { NewReport, Report, User } from "../src/db/queries";
import type { ParsedMessage } from "../src/whapi/types";
import type { ProjectsModule } from "../src/domain/projects";
import type { StructureResult } from "../src/openai/structure";

/**
 * Pipeline-level acknowledge/follow-up decisions (CHANGE B). The openai wrapper
 * itself is unit-tested in openaiWrappers.test.ts; here we assert the pipeline's
 * behavior: unresolved blocker → follow-up sent; clean → not sent; LLM failure →
 * basic static acknowledgement, no follow-up, report still stored.
 */

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

const FIXED_NOW = () => new Date("2026-07-23T06:00:00Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1, wa_id: "111@s.whatsapp.net", phone: "111", name: "Sana",
    team_id: null, is_manager: false, is_root: false, manager_id: null,
    onboarding_state: "done", pending_manager_phone: null,
    last_reminder_sent_at: null, reminder_count_today: 0, reminder_day: null,
    created_at: new Date(), ...overrides,
  };
}

function makeMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "msg-1", from: "111@s.whatsapp.net", from_me: false,
    chat_id: "111@s.whatsapp.net", type: "text", timestamp: 1,
    wa_id: "111@s.whatsapp.net", is_group: false, ...overrides,
  };
}

function structured(overrides: Partial<StructureResult> = {}): StructureResult {
  return { summary: "s", tasks_done: [], blockers: [], projects: [], next_steps: [], ...overrides };
}

function makeDb(seed: Report[] = []) {
  const rows = new Map<string, Report>();
  let nextId = 1;
  for (const r of seed) {
    rows.set(r.source_message_id, r);
    nextId = Math.max(nextId, r.id + 1);
  }
  const db: ReportDb & {
    insertReportWithProjects: ReturnType<typeof vi.fn>;
    getRecentReportsForUser: ReturnType<typeof vi.fn>;
    _rows: Map<string, Report>;
  } = {
    _rows: rows,
    insertReportWithProjects: vi.fn(async (report: NewReport) => {
      const existing = rows.get(report.source_message_id);
      if (existing) return { report: existing, inserted: false };
      const row: Report = {
        id: nextId++, user_id: report.user_id, report_date: report.report_date,
        raw_transcript: report.raw_transcript, structured_json: report.structured_json,
        source_kind: report.source_kind, language: report.language,
        source_message_id: report.source_message_id, created_at: new Date(),
      };
      rows.set(report.source_message_id, row);
      return { report: row, inserted: true };
    }),
    getRecentReportsForUser: vi.fn(async (userId: number, limit: number) =>
      [...rows.values()].filter((r) => r.user_id === userId).sort((a, b) => b.id - a.id).slice(0, limit),
    ),
  };
  return db;
}

function makeWhapi() {
  const sendText = vi.fn(async () => ({}));
  const downloadMedia = vi.fn(async () => ({ buffer: Buffer.from("a"), contentType: "audio/ogg" }));
  return { sendText, downloadMedia } as ReportWhapi & {
    sendText: ReturnType<typeof vi.fn>;
    downloadMedia: ReturnType<typeof vi.fn>;
  };
}

const NOOP_PROJECTS: ProjectsModule = {
  normalize: (n) => n.trim().toLowerCase(),
  matchOrCreate: async () => null,
  findByNorm: async () => null,
};

function seededReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 10, user_id: 1, report_date: "2026-07-22",
    raw_transcript: "yesterday", structured_json: structured({ blockers: ["approval pending"] }),
    source_kind: "text", language: "text-provided",
    source_message_id: "prev-1", created_at: new Date("2026-07-22T06:00:00Z"),
    ...overrides,
  };
}

describe("reportPipeline follow-up decisions (CHANGE B)", () => {
  it("recent reports with an unresolved blocker → follow-up non-null and SENT", async () => {
    const db = makeDb([seededReport()]);
    const whapi = makeWhapi();
    // The LLM sees the prior unresolved blocker and returns a nudge.
    const acknowledgeAndFollowup = vi.fn(async (_today: unknown, recent: unknown[]) => {
      // Assert the pipeline passed the prior structured report (excluding the new one).
      expect(recent.length).toBeGreaterThanOrEqual(1);
      return { acknowledgement: "Great progress!", followup: "Did the approval from yesterday come through?" };
    });
    const pipeline = createReportPipeline({
      db, whapi, projects: NOOP_PROJECTS, transcribe: vi.fn(),
      structure: vi.fn(async () => structured({ summary: "today's work" })),
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "today-1", text: "did more work" }));

    expect(whapi.sendText).toHaveBeenCalledTimes(2);
    expect(whapi.sendText.mock.calls[0][1]).toBe("Great progress!");
    expect(whapi.sendText.mock.calls[1][1]).toBe("Did the approval from yesterday come through?");
    // Recent reports excluded the just-inserted row.
    const recentArg = acknowledgeAndFollowup.mock.calls[0][1] as unknown[];
    expect(recentArg.length).toBe(1);
  });

  it("clean report → follow-up null and NOT sent (only the acknowledgement)", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const acknowledgeAndFollowup = vi.fn(async () => ({ acknowledgement: "All clear, thanks!", followup: null }));
    const pipeline = createReportPipeline({
      db, whapi, projects: NOOP_PROJECTS, transcribe: vi.fn(),
      structure: vi.fn(async () => structured()),
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "clean-1", text: "all done" }));

    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toBe("All clear, thanks!");
  });

  it("empty-string follow-up is treated as null (not sent)", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const acknowledgeAndFollowup = vi.fn(async () => ({ acknowledgement: "ok", followup: "   " }));
    const pipeline = createReportPipeline({
      db, whapi, projects: NOOP_PROJECTS, transcribe: vi.fn(),
      structure: vi.fn(async () => structured()),
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "ws-1", text: "done" }));

    expect(whapi.sendText).toHaveBeenCalledTimes(1);
  });

  it("follow-up LLM failure → basic static acknowledgement sent, no follow-up, report still stored", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const acknowledgeAndFollowup = vi.fn(async () => {
      throw new FollowupError("llm down");
    });
    const pipeline = createReportPipeline({
      db, whapi, projects: NOOP_PROJECTS, transcribe: vi.fn(),
      structure: vi.fn(async () => structured({ summary: "committed work" })),
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "fail-ack", text: "did work" }));

    // Report still stored despite ack failure.
    expect(db._rows.size).toBe(1);
    expect(db.insertReportWithProjects).toHaveBeenCalledTimes(1);
    // Basic static acknowledgement sent, and only that (no follow-up).
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toBe(PIPELINE_STATIC_ACK);
  });
});
