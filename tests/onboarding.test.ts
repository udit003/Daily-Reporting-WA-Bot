import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  createOnboardingHandler,
  type OnboardingDb,
  type OnboardingWhapi,
} from "../src/domain/onboarding";
import type { User, SetManagerResult } from "../src/db/queries";
import type { ParsedMessage } from "../src/whapi/types";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    wa_id: "111@s.whatsapp.net",
    phone: "111",
    name: null,
    team_id: null,
    is_manager: false,
    is_root: false,
    manager_id: null,
    onboarding_state: "new",
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

/**
 * An in-memory DB mock backing the onboarding handler. State updates are
 * applied so getUserById returns the current (possibly derived) user.
 */
function makeDb(initial: User[] = []) {
  const users = new Map<number, User>();
  for (const u of initial) users.set(u.id, { ...u });
  let nextId = Math.max(0, ...initial.map((u) => u.id)) + 1;

  const db: OnboardingDb & {
    _users: Map<number, User>;
    insertUser: ReturnType<typeof vi.fn>;
    updateUserOnboarding: ReturnType<typeof vi.fn>;
    setUserManager: ReturnType<typeof vi.fn>;
    setRoot: ReturnType<typeof vi.fn>;
    reconcilePendingManagers: ReturnType<typeof vi.fn>;
    listOnboardedUsers: ReturnType<typeof vi.fn>;
    countOnboardedUsers: ReturnType<typeof vi.fn>;
    getUserById: ReturnType<typeof vi.fn>;
  } = {
    _users: users,
    insertUser: vi.fn(async (input) => {
      const u = makeUser({
        id: nextId++,
        wa_id: input.wa_id,
        phone: input.phone,
        name: input.name ?? null,
        onboarding_state: input.onboarding_state ?? "new",
      });
      users.set(u.id, u);
      return { ...u };
    }),
    updateUserOnboarding: vi.fn(async (userId, patch) => {
      const u = users.get(userId);
      if (!u) return null;
      Object.assign(u, patch);
      return { ...u };
    }),
    setUserManager: vi.fn(async (userId, managerId): Promise<SetManagerResult> => {
      if (userId === managerId) return { ok: false, reason: "self" };
      const u = users.get(userId);
      const mgr = users.get(managerId);
      if (u) u.manager_id = managerId;
      if (mgr) mgr.is_manager = true;
      return { ok: true };
    }),
    setRoot: vi.fn(async (userId) => {
      const u = users.get(userId);
      if (u) {
        u.is_root = true;
        u.manager_id = null;
      }
      return { ok: true };
    }),
    reconcilePendingManagers: vi.fn(async () => ({ linked: [], skippedForCycle: [] })),
    listOnboardedUsers: vi.fn(async (offset: number, limit: number) => {
      const done = [...users.values()].filter((u) => u.onboarding_state === "done");
      return done.slice(offset, offset + limit).map((u) => ({ ...u }));
    }),
    countOnboardedUsers: vi.fn(async () =>
      [...users.values()].filter((u) => u.onboarding_state === "done").length,
    ),
    getUserById: vi.fn(async (id: number) => {
      const u = users.get(id);
      return u ? { ...u } : null;
    }),
  };
  return db;
}

function makeWhapi() {
  const sendText = vi.fn(async () => ({}));
  const sendListPage = vi.fn(async () => ({}));
  const whapi: OnboardingWhapi = { sendText, sendListPage };
  return { whapi, sendText, sendListPage };
}

describe("onboarding: first contact + name step", () => {
  it("first contact from unknown sender creates row (ask_name) and greets", async () => {
    const db = makeDb();
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle(null, makeMsg({ text: "onboard" }));

    expect(db.insertUser).toHaveBeenCalledTimes(1);
    const created = db.insertUser.mock.calls[0][0];
    expect(created.wa_id).toBe("111@s.whatsapp.net");
    expect(created.phone).toBe("111");
    expect(created.onboarding_state).toBe("ask_name");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/name/i);
  });

  it("ask_name stores the name and presents the manager picker", async () => {
    const user = makeUser({ onboarding_state: "ask_name" });
    const db = makeDb([user]);
    const { whapi, sendListPage } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ text: "Gopal Narang" }));

    expect(db.updateUserOnboarding).toHaveBeenCalledWith(user.id, {
      name: "Gopal Narang",
      onboarding_state: "ask_manager",
    });
    expect(sendListPage).toHaveBeenCalledTimes(1);
    // The picker includes the special rows.
    const rows = sendListPage.mock.calls[0][3] as { id: string }[];
    expect(rows.some((r) => r.id === "mgr:none")).toBe(true);
    expect(rows.some((r) => r.id === "mgr:pending")).toBe(true);
  });
});

describe("onboarding: manager selection", () => {
  it("mgr_id selection sets manager + derives manager is_manager, then completes with help menu", async () => {
    const mgr = makeUser({ id: 10, wa_id: "999@s.whatsapp.net", phone: "999", name: "Advait", onboarding_state: "done" });
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Rohit" });
    const db = makeDb([mgr, user]);
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "mgr_id:10", title: "Advait" } }));

    expect(db.setUserManager).toHaveBeenCalledWith(1, 10);
    expect(db._users.get(10)!.is_manager).toBe(true);
    // Completed → state done, reconcile called, help menu sent.
    expect(db._users.get(1)!.onboarding_state).toBe("done");
    expect(db.reconcilePendingManagers).toHaveBeenCalledWith("111");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/daily update/i);
  });

  it("cycle refusal path: setUserManager rejects → explains + re-presents picker, stays ask_manager", async () => {
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Rohit" });
    const db = makeDb([user]);
    db.setUserManager.mockResolvedValueOnce({ ok: false, reason: "descendant" });
    const { whapi, sendText, sendListPage } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "mgr_id:2", title: "Sana" } }));

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/reports to you/i);
    expect(sendListPage).toHaveBeenCalledTimes(1);
    expect(db._users.get(1)!.onboarding_state).toBe("ask_manager");
    expect(db.reconcilePendingManagers).not.toHaveBeenCalled();
  });

  it("nav:more:<offset> re-sends the picker at the next page", async () => {
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Rohit" });
    const db = makeDb([user]);
    const { whapi, sendListPage } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "nav:more:9", title: "More…" } }));

    expect(sendListPage).toHaveBeenCalledTimes(1);
    expect(sendListPage.mock.calls[0][4]).toBe(9); // offset
  });
});

describe("onboarding: mgr:none multi-root (CHANGE E)", () => {
  it("mgr:none sets root and is allowed EVEN WHEN another root already exists — no re-prompt", async () => {
    const existingRoot = makeUser({ id: 10, wa_id: "999@s.whatsapp.net", phone: "999", name: "Gopal", is_root: true, onboarding_state: "done" });
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Advait" });
    const db = makeDb([existingRoot, user]);
    const { whapi, sendText, sendListPage } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "mgr:none", title: "top" } }));

    expect(db.setRoot).toHaveBeenCalledWith(1);
    expect(db._users.get(1)!.is_root).toBe(true);
    expect(db._users.get(1)!.manager_id).toBeNull();
    // Both roots coexist.
    expect(db._users.get(10)!.is_root).toBe(true);
    // Completed with help menu; NO re-prompt of the picker after mgr:none.
    expect(db._users.get(1)!.onboarding_state).toBe("done");
    expect(sendText).toHaveBeenCalledTimes(1);
    // Only the manager picker was never re-sent as a "root exists" rejection.
    expect(sendListPage).not.toHaveBeenCalled();
    // Root gets the reminder-admin line in the menu.
    expect(sendText.mock.calls[0][1]).toMatch(/Tune reminders/i);
  });
});

describe("onboarding: mgr:pending phone capture + reconciliation", () => {
  it("mgr:pending → asks for phone (ask_pending_manager_phone)", async () => {
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Rohit" });
    const db = makeDb([user]);
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "mgr:pending", title: "not joined" } }));

    expect(db._users.get(1)!.onboarding_state).toBe("ask_pending_manager_phone");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/phone/i);
  });

  it("valid pending phone stores it, completes, and reconciles on this user's phone", async () => {
    const user = makeUser({ id: 1, onboarding_state: "ask_pending_manager_phone", name: "Rohit" });
    const db = makeDb([user]);
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ text: "+91 98200 12345" }));

    expect(db._users.get(1)!.pending_manager_phone).toBe("919820012345");
    expect(db._users.get(1)!.onboarding_state).toBe("done");
    expect(db.reconcilePendingManagers).toHaveBeenCalledWith("111");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/daily update/i);
  });

  it("invalid pending phone → re-prompt, stays in ask_pending_manager_phone", async () => {
    const user = makeUser({ id: 1, onboarding_state: "ask_pending_manager_phone", name: "Rohit" });
    const db = makeDb([user]);
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ text: "abc" }));

    expect(db._users.get(1)!.onboarding_state).toBe("ask_pending_manager_phone");
    expect(db.reconcilePendingManagers).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toMatch(/valid phone/i);
  });

  it("reconciliation derives is_manager on the later-joining manager (pending waiter linked)", async () => {
    // A waiter is pending on this user's phone; when this user finishes, they
    // become a manager. We simulate reconcile linking + deriving here.
    const user = makeUser({ id: 1, onboarding_state: "ask_manager", name: "Gopal" });
    const db = makeDb([user]);
    db.reconcilePendingManagers.mockImplementationOnce(async (phone: string) => {
      // Simulate: someone was waiting → this user becomes a manager.
      const u = db._users.get(1)!;
      u.is_manager = true;
      return { linked: [2], skippedForCycle: [] };
    });
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ type: "reply", reply: { id: "mgr:none", title: "top" } }));

    expect(db.reconcilePendingManagers).toHaveBeenCalledWith("111");
    // Menu computed AFTER reconciliation → includes the manager team-query line.
    expect(sendText.mock.calls[0][1]).toMatch(/Ask about your team/i);
  });
});

describe("onboarding: onboard keyword restart", () => {
  it("`onboard` from a done user resets to ask_name and greets", async () => {
    const user = makeUser({ id: 1, onboarding_state: "done", name: "Rohit" });
    const db = makeDb([user]);
    const { whapi, sendText } = makeWhapi();
    const h = createOnboardingHandler({ db, whapi });

    await h.handle({ ...user }, makeMsg({ text: "onboard" }));

    expect(db._users.get(1)!.onboarding_state).toBe("ask_name");
    expect(sendText.mock.calls[0][1]).toMatch(/name/i);
  });
});
