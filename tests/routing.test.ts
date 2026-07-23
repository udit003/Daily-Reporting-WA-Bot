import { describe, it, expect, vi, beforeAll } from "vitest";
import { createRouter, type RouterDeps } from "../src/domain/router";
import type { User } from "../src/db/queries";
import type { ParsedMessage } from "../src/whapi/types";
import type { Handlers } from "../src/domain/types";
import type { SettingsModule } from "../src/domain/settings";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

// --- fixtures --------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    wa_id: "111@s.whatsapp.net",
    phone: "111",
    name: "Test User",
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
    id: "m1",
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

interface Harness {
  deps: RouterDeps;
  handlers: {
    onboarding: { handle: ReturnType<typeof vi.fn> };
    report: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    statusDigest: ReturnType<typeof vi.fn>;
  };
  sendText: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
  parseAdminCommand: ReturnType<typeof vi.fn>;
  getUserByWaId: ReturnType<typeof vi.fn>;
  getSubtreeUserIds: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  user?: User | null;
  subtree?: number[];
  classifyLabel?: "REPORT" | "QUERY";
  classifyThrows?: boolean;
  adminAck?: string | null;
}): Harness {
  const getUserByWaId = vi.fn(async () => opts.user ?? null);
  const getSubtreeUserIds = vi.fn(async () => opts.subtree ?? []);
  const sendText = vi.fn(async () => ({}));
  const classify = vi.fn(async () => {
    if (opts.classifyThrows) throw new Error("boom");
    return { label: opts.classifyLabel ?? "QUERY" };
  });
  const parseAdminCommand = vi.fn(async () => opts.adminAck ?? null);

  const handlers = {
    onboarding: { handle: vi.fn(async () => {}) },
    report: vi.fn(async () => {}),
    query: vi.fn(async () => {}),
    statusDigest: vi.fn(async () => {}),
  };

  const settings: SettingsModule = {
    getReminderSettings: vi.fn(async () => ({ start: "17:00", intervalMin: 15, stop: "22:00" })),
    parseAdminCommand,
  };

  const deps: RouterDeps = {
    db: { getUserByWaId, getSubtreeUserIds },
    whapi: { sendText },
    classify,
    settings,
    handlers: handlers as unknown as Handlers,
  };

  return { deps, handlers, sendText, classify, parseAdminCommand, getUserByWaId, getSubtreeUserIds };
}

// --- tests -----------------------------------------------------------------

describe("router: pre-onboarding / onboarding trigger (CHANGE D)", () => {
  it("ignores from_me messages", async () => {
    const h = harness({ user: makeUser() });
    await createRouter(h.deps).route(makeMsg({ from_me: true, text: "hi" }));
    expect(h.handlers.onboarding.handle).not.toHaveBeenCalled();
    expect(h.handlers.report).not.toHaveBeenCalled();
  });

  it("rejects group chats (no dispatch, no reply)", async () => {
    const h = harness({ user: makeUser() });
    await createRouter(h.deps).route(makeMsg({ is_group: true, text: "hi" }));
    expect(h.handlers.onboarding.handle).not.toHaveBeenCalled();
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("unknown sender → onboarding regardless of content", async () => {
    const h = harness({ user: null });
    await createRouter(h.deps).route(makeMsg({ text: "What did Sana do?" }));
    expect(h.handlers.onboarding.handle).toHaveBeenCalledTimes(1);
    expect(h.handlers.report).not.toHaveBeenCalled();
    expect(h.handlers.query).not.toHaveBeenCalled();
  });

  it("mid-onboarding sender (state != done) → onboarding", async () => {
    const h = harness({ user: makeUser({ onboarding_state: "ask_name" }) });
    await createRouter(h.deps).route(makeMsg({ text: "my name" }));
    expect(h.handlers.onboarding.handle).toHaveBeenCalledTimes(1);
  });

  it("`onboard` keyword from a done sender restarts onboarding", async () => {
    const h = harness({ user: makeUser({ onboarding_state: "done" }) });
    await createRouter(h.deps).route(makeMsg({ text: "  Onboard " }));
    expect(h.handlers.onboarding.handle).toHaveBeenCalledTimes(1);
  });
});

describe("router: help/menu keyword (CHANGE F) precedes report/query", () => {
  for (const kw of ["help", "menu", "  HELP ", "Menu"]) {
    it(`'${kw}' from an IC → buildHelpMessage sent, no report/query`, async () => {
      const h = harness({ user: makeUser({ is_manager: false }) });
      await createRouter(h.deps).route(makeMsg({ text: kw }));
      expect(h.sendText).toHaveBeenCalledTimes(1);
      expect(h.handlers.report).not.toHaveBeenCalled();
      expect(h.handlers.query).not.toHaveBeenCalled();
    });
  }

  it("help from a manager → help sent, classifier not consulted", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "help" }));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("help from a root → help sent", async () => {
    const h = harness({ user: makeUser({ is_root: true, is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "menu" }));
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.handlers.statusDigest).not.toHaveBeenCalled();
  });
});

describe("router: status/digest keyword (CHANGE G)", () => {
  for (const kw of ["status", "digest", "today", "  Status ", "DIGEST"]) {
    it(`'${kw}' from a derived manager → statusDigest, before report/query`, async () => {
      const h = harness({ user: makeUser({ is_manager: true }) });
      await createRouter(h.deps).route(makeMsg({ text: kw }));
      expect(h.handlers.statusDigest).toHaveBeenCalledTimes(1);
      expect(h.handlers.report).not.toHaveBeenCalled();
      expect(h.handlers.query).not.toHaveBeenCalled();
      expect(h.classify).not.toHaveBeenCalled();
    });
  }

  it("'status' from a root (no descendants) → statusDigest", async () => {
    const h = harness({ user: makeUser({ is_root: true, is_manager: false }) });
    await createRouter(h.deps).route(makeMsg({ text: "status" }));
    expect(h.handlers.statusDigest).toHaveBeenCalledTimes(1);
  });

  it("'status' from a user with descendants but is_manager flag lagging → statusDigest (derived)", async () => {
    const h = harness({ user: makeUser({ is_manager: false }), subtree: [2, 3] });
    await createRouter(h.deps).route(makeMsg({ text: "status" }));
    expect(h.handlers.statusDigest).toHaveBeenCalledTimes(1);
  });

  it("'status' from a plain IC → NOT the digest command, falls through to report", async () => {
    const h = harness({ user: makeUser({ is_manager: false, is_root: false }), subtree: [] });
    await createRouter(h.deps).route(makeMsg({ text: "status" }));
    expect(h.handlers.statusDigest).not.toHaveBeenCalled();
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    expect(h.handlers.query).not.toHaveBeenCalled();
  });
});

describe("router: voice / audio always REPORT", () => {
  it("voice from an IC → report", async () => {
    const h = harness({ user: makeUser() });
    await createRouter(h.deps).route(
      makeMsg({ type: "voice", text: undefined, mediaId: "v1", mediaType: "voice" }),
    );
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
  });

  it("voice from a manager → report (not classified as query)", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(
      makeMsg({ type: "audio", text: undefined, mediaId: "a1", mediaType: "audio" }),
    );
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
  });
});

describe("router: non-manager text always REPORT", () => {
  it("plain text from an IC → report", async () => {
    const h = harness({ user: makeUser({ is_manager: false }), subtree: [] });
    await createRouter(h.deps).route(makeMsg({ text: "Aaj maine 3 site visits kiye" }));
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("even a question-shaped text from an IC → report (ICs don't query)", async () => {
    const h = harness({ user: makeUser({ is_manager: false }), subtree: [] });
    await createRouter(h.deps).route(makeMsg({ text: "What should I do next?" }));
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    expect(h.handlers.query).not.toHaveBeenCalled();
  });
});

describe("router: manager disambiguation ladder", () => {
  it("(a) any-root `set reminder ...` → admin applied + acked, no report/query", async () => {
    const h = harness({
      user: makeUser({ is_manager: true, is_root: true }),
      adminAck: "✅ Reminder start time set to 17:30.",
    });
    await createRouter(h.deps).route(makeMsg({ text: "set reminder time 17:30" }));
    expect(h.parseAdminCommand).toHaveBeenCalledWith("set reminder time 17:30");
    expect(h.sendText).toHaveBeenCalledWith("111@s.whatsapp.net", "✅ Reminder start time set to 17:30.");
    expect(h.handlers.report).not.toHaveBeenCalled();
    expect(h.handlers.query).not.toHaveBeenCalled();
  });

  it("(a) admin command from a non-root manager is NOT applied (parseAdminCommand not called)", async () => {
    const h = harness({
      user: makeUser({ is_manager: true, is_root: false }),
      classifyLabel: "QUERY",
    });
    await createRouter(h.deps).route(makeMsg({ text: "set reminder time 17:30" }));
    expect(h.parseAdminCommand).not.toHaveBeenCalled();
  });

  it("(b) `report:` keyword hatch → report with keyword stripped", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "report: Aaj sales review kiya" }));
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    const [, passedMsg] = h.handlers.report.mock.calls[0];
    expect((passedMsg as ParsedMessage).text).toBe("Aaj sales review kiya");
  });

  it("(b) `ask:` keyword hatch → query with keyword stripped", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "ask: what did Sana do" }));
    expect(h.handlers.query).toHaveBeenCalledWith(expect.anything(), "what did Sana do");
  });

  it("(b) `query:` keyword hatch → query with keyword stripped", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "query: status of Vivenda" }));
    expect(h.handlers.query).toHaveBeenCalledWith(expect.anything(), "status of Vivenda");
  });

  it("(c) trailing `?` → QUERY without calling classifier", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "Sana ka update kya hai?" }));
    expect(h.handlers.query).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("(c) interrogative prefix → QUERY without calling classifier", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(makeMsg({ text: "What is happening with Narang Vivenda" }));
    expect(h.handlers.query).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("(d) first-person status → REPORT via classifier stub", async () => {
    const h = harness({ user: makeUser({ is_manager: true }), classifyLabel: "REPORT" });
    await createRouter(h.deps).route(makeMsg({ text: "Aaj maine client se meeting ki" }));
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.handlers.report).toHaveBeenCalledTimes(1);
    expect(h.handlers.query).not.toHaveBeenCalled();
  });

  it("(d) classifier QUERY → query", async () => {
    const h = harness({ user: makeUser({ is_manager: true }), classifyLabel: "QUERY" });
    await createRouter(h.deps).route(makeMsg({ text: "team update on Vivenda area" }));
    expect(h.handlers.query).toHaveBeenCalledTimes(1);
  });

  it("(e) classifier error → QUERY fallback", async () => {
    const h = harness({ user: makeUser({ is_manager: true }), classifyThrows: true });
    await createRouter(h.deps).route(makeMsg({ text: "some ambiguous statement" }));
    expect(h.handlers.query).toHaveBeenCalledTimes(1);
    expect(h.handlers.report).not.toHaveBeenCalled();
  });
});

describe("router: stale/unknown reply id outside onboarding", () => {
  it("onboarding reply id from a done user → hint, no dispatch", async () => {
    const h = harness({ user: makeUser({ is_manager: true }) });
    await createRouter(h.deps).route(
      makeMsg({ text: undefined, type: "reply", reply: { id: "mgr_id:5", title: "X" } }),
    );
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][1]).toMatch(/expired/i);
    expect(h.handlers.report).not.toHaveBeenCalled();
    expect(h.handlers.query).not.toHaveBeenCalled();
  });

  it("mgr:none reply id from a done user → hint", async () => {
    const h = harness({ user: makeUser() });
    await createRouter(h.deps).route(
      makeMsg({ text: undefined, type: "reply", reply: { id: "mgr:none", title: "top" } }),
    );
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][1]).toMatch(/expired/i);
  });
});
