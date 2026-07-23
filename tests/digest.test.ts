import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  createDigestHandler,
  buildDeterministicDigest,
  renderReportedSplit,
  type DigestDb,
  type DigestWhapi,
} from "../src/domain/digest";
import type { ReportWithProjects, SubtreeReportedStatus, User } from "../src/db/queries";
import type { DigestReport } from "../src/openai/query";

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
    wa_id: "mgr@s.whatsapp.net",
    phone: "1",
    name: "Advait",
    team_id: null,
    is_manager: true,
    is_root: true,
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

function makeRWP(overrides: Partial<ReportWithProjects> = {}): ReportWithProjects {
  return {
    id: 1,
    user_id: 2,
    report_date: "2026-07-23",
    raw_transcript: "did stuff",
    structured_json: {
      summary: "Closed 2 bookings.",
      tasks_done: ["2 bookings"],
      blockers: [],
      projects: ["Narang Vivenda"],
      next_steps: [],
    },
    source_kind: "text",
    language: "text-provided",
    source_message_id: "m1",
    created_at: new Date(),
    reporter_name: "Rohit",
    project_names: ["Narang Vivenda"],
    ...overrides,
  };
}

function makeDeps(opts: {
  subtree: number[];
  status?: SubtreeReportedStatus[];
  reports?: ReportWithProjects[];
  summarize?: (r: DigestReport[]) => Promise<string>;
}) {
  const whapi: DigestWhapi & { sendText: ReturnType<typeof vi.fn> } = {
    sendText: vi.fn(async () => ({})),
  };
  const capturedStatus: { ids: number[]; date: string }[] = [];
  const capturedReports: { ids: number[]; filter: { from: string; to: string } }[] = [];

  const db: DigestDb & {
    getSubtreeUserIds: ReturnType<typeof vi.fn>;
    getSubtreeReportedStatus: ReturnType<typeof vi.fn>;
    getReportsForUsersWithProjects: ReturnType<typeof vi.fn>;
    _status: typeof capturedStatus;
    _reports: typeof capturedReports;
  } = {
    _status: capturedStatus,
    _reports: capturedReports,
    getSubtreeUserIds: vi.fn(async () => opts.subtree),
    getSubtreeReportedStatus: vi.fn(async (ids: number[], date: string) => {
      capturedStatus.push({ ids, date });
      return opts.status ?? [];
    }),
    getReportsForUsersWithProjects: vi.fn(
      async (ids: number[], filter: { from: string; to: string }) => {
        capturedReports.push({ ids, filter });
        return opts.reports ?? [];
      },
    ),
  };

  const summarizeDigest = vi.fn(
    opts.summarize ?? (async () => "*Narang Vivenda*\n• Rohit: Closed 2 bookings."),
  );

  const handler = createDigestHandler({ whapi, db, summarizeDigest, now: FIXED_NOW });
  return { handler, whapi, db, summarizeDigest };
}

describe("renderReportedSplit (deterministic)", () => {
  it("splits reported vs pending with names and counts", () => {
    const out = renderReportedSplit([
      { id: 2, name: "Rohit", reported: true },
      { id: 3, name: "Sana", reported: false },
      { id: 4, name: "Meera", reported: true },
    ]);
    expect(out).toContain("✅ Reported (2): Rohit, Meera");
    expect(out).toContain("⏳ Pending (1): Sana");
  });
});

describe("buildDeterministicDigest (fallback grouping)", () => {
  it("groups by linked project and buckets unlinked under 'Other updates'", () => {
    const out = buildDeterministicDigest([
      makeRWP({ reporter_name: "Rohit", project_names: ["Narang Vivenda"] }),
      makeRWP({
        id: 2,
        user_id: 3,
        reporter_name: "Sana",
        project_names: [],
        structured_json: {
          summary: "Team offsite planning.",
          tasks_done: [],
          blockers: [],
          projects: [],
          next_steps: [],
        },
      }),
    ]);
    expect(out).toContain("*Narang Vivenda*");
    expect(out).toContain("Rohit: Closed 2 bookings.");
    expect(out).toContain("*Other updates*");
    expect(out).toContain("Sana: Team offsite planning.");
  });
});

describe("digest handler — status digest", () => {
  it("scopes Part 1 + Part 2 to the subtree ids only", async () => {
    const { handler, db } = makeDeps({
      subtree: [2, 3],
      status: [
        { id: 2, name: "Rohit", reported: true },
        { id: 3, name: "Sana", reported: false },
      ],
      reports: [makeRWP()],
    });
    await handler.handleStatusDigest(makeUser());
    expect(db._status[0].ids).toEqual([2, 3]);
    expect(db._status[0].date).toBe("2026-07-23");
    expect(db._reports[0].ids).toEqual([2, 3]);
    expect(db._reports[0].filter).toEqual({ from: "2026-07-23", to: "2026-07-23" });
  });

  it("Part 1 reported/pending split is subtree-scoped (out-of-subtree user never appears)", async () => {
    const { handler, whapi } = makeDeps({
      subtree: [2, 3],
      status: [
        { id: 2, name: "Rohit", reported: true },
        { id: 3, name: "Sana", reported: false },
      ],
      reports: [makeRWP()],
    });
    await handler.handleStatusDigest(makeUser());
    const msg = whapi.sendText.mock.calls[0][1] as string;
    expect(msg).toContain("✅ Reported (1): Rohit");
    expect(msg).toContain("⏳ Pending (1): Sana");
    expect(msg).not.toContain("Gopal"); // a user outside the subtree
  });

  it("Part 2 uses the LLM summary when it succeeds", async () => {
    const { handler, whapi, summarizeDigest } = makeDeps({
      subtree: [2],
      status: [{ id: 2, name: "Rohit", reported: true }],
      reports: [makeRWP()],
      summarize: async () => "*Narang Vivenda*\n• Rohit closed 2 bookings.",
    });
    await handler.handleStatusDigest(makeUser());
    expect(summarizeDigest).toHaveBeenCalledTimes(1);
    const msg = whapi.sendText.mock.calls[0][1] as string;
    expect(msg).toContain("Rohit closed 2 bookings.");
  });

  it("Part 2 LLM failure → deterministic app-side grouped fallback still returned", async () => {
    const { handler, whapi } = makeDeps({
      subtree: [2, 3],
      status: [
        { id: 2, name: "Rohit", reported: true },
        { id: 3, name: "Sana", reported: true },
      ],
      reports: [
        makeRWP({ reporter_name: "Rohit", project_names: ["Narang Vivenda"] }),
        makeRWP({
          id: 2,
          user_id: 3,
          reporter_name: "Sana",
          project_names: [],
          structured_json: {
            summary: "General admin work.",
            tasks_done: [],
            blockers: [],
            projects: [],
            next_steps: [],
          },
        }),
      ],
      summarize: async () => {
        throw new Error("LLM down");
      },
    });
    await handler.handleStatusDigest(makeUser());
    const msg = whapi.sendText.mock.calls[0][1] as string;
    expect(msg).toContain("*Narang Vivenda*");
    expect(msg).toContain("*Other updates*");
    expect(msg).toContain("Sana: General admin work.");
  });

  it("empty subtree → graceful message", async () => {
    const { handler, whapi, db } = makeDeps({ subtree: [] });
    await handler.handleStatusDigest(makeUser());
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/no team members yet/i);
    expect(db.getSubtreeReportedStatus).not.toHaveBeenCalled();
  });

  it("no reports today → 'No reports submitted yet today.'", async () => {
    const { handler, whapi, summarizeDigest } = makeDeps({
      subtree: [2],
      status: [{ id: 2, name: "Rohit", reported: false }],
      reports: [],
    });
    await handler.handleStatusDigest(makeUser());
    const msg = whapi.sendText.mock.calls[0][1] as string;
    expect(msg).toContain("No reports submitted yet today.");
    expect(summarizeDigest).not.toHaveBeenCalled();
  });

  it("guards a plain IC defensively (router normally prevents this)", async () => {
    const { handler, whapi, db } = makeDeps({ subtree: [] });
    const ic = makeUser({ is_manager: false, is_root: false });
    await handler.handleStatusDigest(ic);
    expect(whapi.sendText.mock.calls[0][1]).toMatch(/no team members yet/i);
    expect(db.getSubtreeUserIds).not.toHaveBeenCalled();
  });
});
