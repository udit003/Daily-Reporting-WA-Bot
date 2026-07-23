import { describe, it, expect, vi, beforeAll } from "vitest";
import { createQueryHandler, type QueryDb, type QueryWhapi } from "../src/domain/query";
import type { Report, ReportFilter, User } from "../src/db/queries";
import type { ProjectsModule } from "../src/domain/projects";
import type { Intent } from "../src/openai/query";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

// 2026-07-23 IST (fixed clock so date ranges are deterministic).
const FIXED_NOW = () => new Date("2026-07-23T06:00:00Z");

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    wa_id: "mgr@s.whatsapp.net",
    phone: "1",
    name: "Manager",
    team_id: null,
    is_manager: true,
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

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 1,
    user_id: 2,
    report_date: "2026-07-23",
    raw_transcript: "did stuff",
    structured_json: {
      summary: "Did site visits.",
      tasks_done: ["3 visits"],
      blockers: [],
      projects: ["Narang Vivenda"],
      next_steps: [],
    },
    source_kind: "text",
    language: "text-provided",
    source_message_id: "m1",
    created_at: new Date(),
    ...overrides,
  };
}

interface Members {
  [id: number]: string | null;
}

function makeDeps(opts: {
  subtree: number[];
  members?: Members;
  reports?: Report[];
  intent: Intent;
  project?: { id: number } | null;
  answer?: (q: string, ctx: unknown[]) => Promise<string>;
}) {
  const whapi: QueryWhapi & { sendText: ReturnType<typeof vi.fn> } = {
    sendText: vi.fn(async () => ({})),
  };

  const members = opts.members ?? {};
  const capturedFilters: { ids: number[]; filter: ReportFilter }[] = [];

  const db: QueryDb & {
    getSubtreeUserIds: ReturnType<typeof vi.fn>;
    getUsersByIds: ReturnType<typeof vi.fn>;
    getReportsForUsers: ReturnType<typeof vi.fn>;
    _filters: typeof capturedFilters;
  } = {
    _filters: capturedFilters,
    getSubtreeUserIds: vi.fn(async () => opts.subtree),
    getUsersByIds: vi.fn(async (ids: number[]) =>
      ids
        .filter((id) => id in members)
        .map((id) => ({ id, name: members[id] })),
    ),
    getReportsForUsers: vi.fn(async (ids: number[], filter: ReportFilter) => {
      capturedFilters.push({ ids, filter });
      return opts.reports ?? [];
    }),
  };

  const findByNorm = vi.fn(async () => opts.project ?? null);
  const projects: ProjectsModule = {
    normalize: (n) => n,
    matchOrCreate: vi.fn(async () => {
      throw new Error("query handler must never create projects");
    }),
    findByNorm,
  };

  const extractIntent = vi.fn(async () => opts.intent);
  const answer = vi.fn(opts.answer ?? (async () => "Here is the answer."));

  const handler = createQueryHandler({
    whapi,
    db,
    projects,
    extractIntent,
    answer,
    now: FIXED_NOW,
  });

  return { handler, whapi, db, projects, findByNorm, extractIntent, answer };
}

describe("query handler — manager Q&A", () => {
  it("guards a non-manager IC with a gentle no-data hint (no leak, no DB)", async () => {
    const { handler, whapi, db } = makeDeps({ subtree: [], intent: { kind: "general" } });
    const ic = makeUser({ is_manager: false, is_root: false });
    await handler.handleQuery(ic, "what did the team do?");
    expect(whapi.sendText).toHaveBeenCalledTimes(1);
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/don't have any team members/i);
    expect(db.getSubtreeUserIds).not.toHaveBeenCalled();
  });

  it("scopes report fetch to ONLY the accessible subtree ids", async () => {
    const { handler, db } = makeDeps({
      subtree: [2, 3],
      members: { 2: "Rohit", 3: "Sana" },
      reports: [makeReport()],
      intent: { kind: "general", date_phrase: "today" },
    });
    await handler.handleQuery(makeUser(), "what's happening?");
    expect(db.getReportsForUsers).toHaveBeenCalledTimes(1);
    const { ids } = db._filters[0];
    expect(ids).toEqual([2, 3]); // never includes an out-of-subtree id
  });

  it("resolves a person within the subtree (case-insensitive) and scopes to them", async () => {
    const { handler, db } = makeDeps({
      subtree: [2, 3],
      members: { 2: "Rohit", 3: "Sana" },
      reports: [makeReport({ user_id: 3 })],
      intent: { kind: "person_status", person_name: "sana" },
    });
    await handler.handleQuery(makeUser(), "what did sana do?");
    expect(db._filters[0].ids).toEqual([3]);
  });

  it("ambiguous person (multiple matches) → disambiguation reply, no report fetch", async () => {
    const { handler, whapi, db } = makeDeps({
      subtree: [2, 3],
      members: { 2: "Sana", 3: "Sana" },
      intent: { kind: "person_status", person_name: "Sana" },
    });
    await handler.handleQuery(makeUser(), "what did sana do?");
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/multiple people/i);
    expect(db.getReportsForUsers).not.toHaveBeenCalled();
  });

  it("unknown person → 'not in your team' without leaking existence elsewhere", async () => {
    const { handler, whapi, db } = makeDeps({
      subtree: [2, 3],
      members: { 2: "Rohit", 3: "Sana" },
      intent: { kind: "person_status", person_name: "Gopal" },
    });
    await handler.handleQuery(makeUser(), "what did gopal do?");
    const msg = whapi.sendText.mock.calls[0][1] as string;
    expect(msg).toMatch(/couldn't find/i);
    expect(msg).toMatch(/your team/i);
    expect(msg).not.toMatch(/elsewhere|another|exists/i);
    expect(db.getReportsForUsers).not.toHaveBeenCalled();
  });

  it("project filter uses findByNorm LOOKUP-ONLY and never creates", async () => {
    const deps = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "project_status", project_name: "Narang Vivenda" },
      project: { id: 42 },
    });
    await deps.handler.handleQuery(makeUser(), "what's up with Narang Vivenda?");
    expect(deps.findByNorm).toHaveBeenCalledWith("Narang Vivenda");
    expect(deps.projects.matchOrCreate).not.toHaveBeenCalled();
    expect(deps.db._filters[0].filter.projectId).toBe(42);
  });

  it("unknown project → no projectId filter (answer will report no data)", async () => {
    const deps = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "project_status", project_name: "Nonexistent" },
      project: null,
    });
    await deps.handler.handleQuery(makeUser(), "what's up with Nonexistent?");
    expect(deps.db._filters[0].filter.projectId).toBeUndefined();
  });

  it("relative date phrase is converted to a concrete IST range in app code", async () => {
    // 'today' with the fixed clock → 2026-07-23 both ends.
    const deps = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "general", date_phrase: "today" },
    });
    await deps.handler.handleQuery(makeUser(), "today?");
    expect(deps.db._filters[0].filter).toMatchObject({ from: "2026-07-23", to: "2026-07-23" });
  });

  it("defaults to last 7 days when no date phrase is present", async () => {
    const deps = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "general" },
    });
    await deps.handler.handleQuery(makeUser(), "recent work");
    // 2026-07-23 minus 6 days = 2026-07-17.
    expect(deps.db._filters[0].filter).toMatchObject({ from: "2026-07-17", to: "2026-07-23" });
  });

  it("empty subtree → friendly no-scope reply", async () => {
    const { handler, whapi, db } = makeDeps({ subtree: [], intent: { kind: "general" } });
    await handler.handleQuery(makeUser(), "anything?");
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/team members/i);
    expect(db.getReportsForUsers).not.toHaveBeenCalled();
  });

  it("no reports in scope → friendly 'no updates found' reply", async () => {
    const { handler, whapi } = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [],
      intent: { kind: "general" },
    });
    await handler.handleQuery(makeUser(), "anything?");
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/no updates found/i);
  });

  it("answer LLM failure → retry-safe error reply", async () => {
    const { handler, whapi } = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "general" },
      answer: async () => {
        throw new Error("boom");
      },
    });
    await handler.handleQuery(makeUser(), "anything?");
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/try again/i);
  });

  it("builds a compact grounded context and sends the answer", async () => {
    const { handler, whapi, answer } = makeDeps({
      subtree: [2],
      members: { 2: "Rohit" },
      reports: [makeReport({ user_id: 2 })],
      intent: { kind: "general" },
      answer: async () => "Rohit did site visits.",
    });
    await handler.handleQuery(makeUser(), "what's up?");
    const ctx = answer.mock.calls[0][1] as any[];
    expect(ctx[0]).toMatchObject({ reporter: "Rohit", date: "2026-07-23" });
    expect(whapi.sendText.mock.calls[0][1]).toBe("Rohit did site visits.");
  });
});
