import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  createReportPipeline,
  type ReportDb,
  type ReportWhapi,
} from "../src/domain/reportPipeline";
import type { NewReport, Report, User } from "../src/db/queries";
import type { ParsedMessage } from "../src/whapi/types";
import type { ProjectsModule } from "../src/domain/projects";
import type { StructureResult } from "../src/openai/structure";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

const FIXED_NOW = () => new Date("2026-07-23T06:00:00Z"); // 2026-07-23 IST

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    wa_id: "111@s.whatsapp.net",
    phone: "111",
    name: "Sana",
    team_id: null,
    is_manager: false,
    is_root: false,
    manager_id: null,
    onboarding_state: "done",
    pending_manager_phone: null,
    last_reminder_sent_at: null,
    reminder_count_today: 0,
    reminder_day: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "msg-1",
    from: "111@s.whatsapp.net",
    from_me: false,
    chat_id: "111@s.whatsapp.net",
    type: "text",
    timestamp: 1,
    wa_id: "111@s.whatsapp.net",
    is_group: false,
    ...overrides,
  };
}

function structured(overrides: Partial<StructureResult> = {}): StructureResult {
  return {
    summary: "Did site visits.",
    tasks_done: ["3 site visits"],
    blockers: [],
    projects: ["Narang Vivenda"],
    next_steps: [],
    ...overrides,
  };
}

/** An in-memory report DB that stores rows keyed by source_message_id (dedup). */
function makeDb() {
  const rows = new Map<string, Report>();
  let nextId = 1;
  const links: { report_id: number; project_ids: number[] }[] = [];

  const db: ReportDb & {
    insertReportWithProjects: ReturnType<typeof vi.fn>;
    getRecentReportsForUser: ReturnType<typeof vi.fn>;
    _rows: Map<string, Report>;
    _links: typeof links;
  } = {
    _rows: rows,
    _links: links,
    insertReportWithProjects: vi.fn(async (report: NewReport, projectIds: number[]) => {
      const existing = rows.get(report.source_message_id);
      if (existing) return { report: existing, inserted: false };
      const row: Report = {
        id: nextId++,
        user_id: report.user_id,
        report_date: report.report_date,
        raw_transcript: report.raw_transcript,
        structured_json: report.structured_json,
        source_kind: report.source_kind,
        language: report.language,
        source_message_id: report.source_message_id,
        created_at: new Date(),
      };
      rows.set(report.source_message_id, row);
      links.push({ report_id: row.id, project_ids: projectIds });
      return { report: row, inserted: true };
    }),
    getRecentReportsForUser: vi.fn(async (userId: number, limit: number) => {
      return [...rows.values()]
        .filter((r) => r.user_id === userId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    }),
  };
  return db;
}

function makeWhapi(overrides: Partial<ReportWhapi> = {}) {
  const sendText = vi.fn(async () => ({}));
  const downloadMedia = vi.fn(async () => ({ buffer: Buffer.from("audio"), contentType: "audio/ogg" }));
  const whapi: ReportWhapi & {
    sendText: ReturnType<typeof vi.fn>;
    downloadMedia: ReturnType<typeof vi.fn>;
  } = { sendText, downloadMedia, ...overrides } as never;
  return whapi;
}

function makeProjects(): ProjectsModule & { matchOrCreate: ReturnType<typeof vi.fn> } {
  let nextId = 100;
  const seen = new Map<string, number>();
  const matchOrCreate = vi.fn(async (name: string) => {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    let id = seen.get(key);
    if (id == null) {
      id = nextId++;
      seen.set(key, id);
    }
    return { id, canonical_name: name, norm_name: key, aliases: [], created_at: new Date() };
  });
  return {
    normalize: (n: string) => n.trim().toLowerCase(),
    matchOrCreate,
    findByNorm: async () => null,
  } as never;
}

describe("reportPipeline: TEXT report", () => {
  it("stores a text report (no media/transcribe), links projects, always acks", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const projects = makeProjects();
    const transcribe = vi.fn();
    const structure = vi.fn(async () => structured());
    const acknowledgeAndFollowup = vi.fn(async () => ({ acknowledgement: "Nice work!", followup: null }));

    const pipeline = createReportPipeline({
      db, whapi, projects, transcribe, structure, acknowledgeAndFollowup,
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(
      makeUser(),
      makeMsg({ id: "t1", type: "text", text: "Aaj Narang Vivenda me 3 site visits kiye" }),
    );

    // Never touched media.
    expect(transcribe).not.toHaveBeenCalled();
    expect(whapi.downloadMedia).not.toHaveBeenCalled();

    // One report row with source_kind='text', language='text-provided'.
    expect(db.insertReportWithProjects).toHaveBeenCalledTimes(1);
    const [newReport, projectIds] = db.insertReportWithProjects.mock.calls[0];
    expect(newReport.source_kind).toBe("text");
    expect(newReport.language).toBe("text-provided");
    expect(newReport.report_date).toBe("2026-07-23");
    expect(newReport.raw_transcript).toBe("Aaj Narang Vivenda me 3 site visits kiye");
    // The internal _fallback flag is not persisted.
    expect("_fallback" in newReport.structured_json).toBe(false);

    // Project link created for the mentioned seeded project.
    expect(projects.matchOrCreate).toHaveBeenCalledWith("Narang Vivenda");
    expect(projectIds.length).toBe(1);

    // Acknowledgement always sent.
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toBe("Nice work!");
  });

  it("sends the follow-up as a second message when non-empty", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const structure = vi.fn(async () => structured({ projects: [] }));
    const acknowledgeAndFollowup = vi.fn(async () => ({
      acknowledgement: "Got it",
      followup: "Any update on that pending approval?",
    }));

    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe: vi.fn(), structure,
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "t2", text: "did stuff" }));

    expect(whapi.sendText).toHaveBeenCalledTimes(2);
    expect(whapi.sendText.mock.calls[0][1]).toBe("Got it");
    expect(whapi.sendText.mock.calls[1][1]).toBe("Any update on that pending approval?");
  });
});

describe("reportPipeline: VOICE report", () => {
  it("downloads + transcribes, stores source_kind='voice' + detected language, links projects, acks", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const projects = makeProjects();
    const transcribe = vi.fn(async () => ({ text: "Windsor Grande Residences client meeting hua", language: "hindi" }));
    const structure = vi.fn(async () => structured({ projects: ["Windsor Grande Residences"] }));
    const acknowledgeAndFollowup = vi.fn(async () => ({ acknowledgement: "Thanks!", followup: null }));

    const pipeline = createReportPipeline({
      db, whapi, projects, transcribe, structure, acknowledgeAndFollowup,
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(
      makeUser(),
      makeMsg({ id: "v1", type: "voice", mediaId: "media-xyz", mediaType: "voice" }),
    );

    expect(whapi.downloadMedia).toHaveBeenCalledWith("media-xyz");
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0].contentType).toBe("audio/ogg");
    // structure got the transcript + detected language.
    expect(structure).toHaveBeenCalledWith("Windsor Grande Residences client meeting hua", "hindi");

    const [newReport, projectIds] = db.insertReportWithProjects.mock.calls[0];
    expect(newReport.source_kind).toBe("voice");
    expect(newReport.language).toBe("hindi");
    expect(newReport.raw_transcript).toBe("Windsor Grande Residences client meeting hua");
    expect(projectIds.length).toBe(1);

    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toBe("Thanks!");
  });

  it("uses source_kind='audio' for audio messages", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const transcribe = vi.fn(async () => ({ text: "some audio", language: "english" }));
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe,
      structure: vi.fn(async () => structured({ projects: [] })),
      acknowledgeAndFollowup: vi.fn(async () => ({ acknowledgement: "ok", followup: null })),
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "a1", type: "audio", mediaId: "m2", mediaType: "audio" }));

    expect(db.insertReportWithProjects.mock.calls[0][0].source_kind).toBe("audio");
  });
});

describe("reportPipeline: DEDUP on source_message_id", () => {
  it("processing the same message id twice → second is a no-op with no second acknowledgement", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const acknowledgeAndFollowup = vi.fn(async () => ({ acknowledgement: "Ack", followup: null }));
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe: vi.fn(),
      structure: vi.fn(async () => structured({ projects: [] })),
      acknowledgeAndFollowup, recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    const msg = makeMsg({ id: "dup-1", text: "my update" });
    await pipeline.handleReport(makeUser(), msg);
    await pipeline.handleReport(makeUser(), msg);

    // Only one physical row.
    expect(db._rows.size).toBe(1);
    // Ack sent only once (first time); dedup skips the second.
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(acknowledgeAndFollowup).toHaveBeenCalledTimes(1);
  });
});

describe("reportPipeline: FAILURE paths", () => {
  it("media download throws → user gets an error reply and NO report row", async () => {
    const db = makeDb();
    const whapi = makeWhapi({
      downloadMedia: vi.fn(async () => {
        throw new Error("404");
      }),
    });
    const transcribe = vi.fn();
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe,
      structure: vi.fn(), acknowledgeAndFollowup: vi.fn(),
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "v-fail", type: "voice", mediaId: "bad", mediaType: "voice" }));

    expect(transcribe).not.toHaveBeenCalled();
    expect(db.insertReportWithProjects).not.toHaveBeenCalled();
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/resend|try sending it again|couldn't/i);
  });

  it("transcription throws → error reply, no report row", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const transcribe = vi.fn(async () => {
      throw new Error("whisper down");
    });
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe,
      structure: vi.fn(), acknowledgeAndFollowup: vi.fn(),
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "v-fail2", type: "voice", mediaId: "m", mediaType: "voice" }));

    expect(db.insertReportWithProjects).not.toHaveBeenCalled();
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/couldn't|resend/i);
  });

  it("empty text body → asks for a non-empty update, no report row", async () => {
    const db = makeDb();
    const whapi = makeWhapi();
    const structure = vi.fn();
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe: vi.fn(),
      structure, acknowledgeAndFollowup: vi.fn(),
      recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await pipeline.handleReport(makeUser(), makeMsg({ id: "empty", type: "text", text: "   " }));

    expect(structure).not.toHaveBeenCalled();
    expect(db.insertReportWithProjects).not.toHaveBeenCalled();
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/empty|non-empty|daily update/i);
  });

  it("a DB insert error propagates (throws) so the processor can mark it failed", async () => {
    const db = makeDb();
    db.insertReportWithProjects.mockRejectedValueOnce(new Error("db down"));
    const whapi = makeWhapi();
    const pipeline = createReportPipeline({
      db, whapi, projects: makeProjects(), transcribe: vi.fn(),
      structure: vi.fn(async () => structured({ projects: [] })),
      acknowledgeAndFollowup: vi.fn(), recentReportsForFollowup: 5, now: FIXED_NOW,
    });

    await expect(
      pipeline.handleReport(makeUser(), makeMsg({ id: "boom", text: "update" })),
    ).rejects.toThrow(/db down/);
    // No acknowledgement sent since the insert failed.
    expect(whapi.sendText).not.toHaveBeenCalled();
  });
});
