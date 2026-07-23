import { describe, it, expect, beforeAll, vi } from "vitest";
import { WhapiClient } from "../src/whapi/client";
import type { OutgoingListRow } from "../src/whapi/types";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

/** Fake fetch capturing the JSON body of a successful POST. */
function fakePostFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "{}",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch): WhapiClient {
  return new WhapiClient({ baseUrl: "https://gate.example.test", token: "tok", fetchImpl });
}

function rows(n: number): OutgoingListRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `mgr_id:${i}`, title: `User ${i}` }));
}

function getRows(body: unknown): OutgoingListRow[] {
  return (body as { action: { list: { sections: { rows: OutgoingListRow[] }[] } } }).action.list
    .sections[0].rows;
}

describe("sendListPage pagination", () => {
  it("9 rows total: no nav row, all 9 shown", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    await makeClient(fetchImpl).sendListPage("to@x", "Pick", "Choose", rows(9), 0, 9);
    const r = getRows(calls[0].body);
    expect(r).toHaveLength(9);
    expect(r.some((x) => x.id.startsWith("nav:more:"))).toBe(false);
    expect(r[8].id).toBe("mgr_id:8");
  });

  it("10 rows total: nav row appears, 9 data rows shown", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    await makeClient(fetchImpl).sendListPage("to@x", "Pick", "Choose", rows(10), 0, 10);
    const r = getRows(calls[0].body);
    expect(r).toHaveLength(10); // 9 data + 1 nav
    const dataRows = r.filter((x) => !x.id.startsWith("nav:more:"));
    expect(dataRows).toHaveLength(9);
    const nav = r[r.length - 1];
    expect(nav.id).toBe("nav:more:9");
    expect(nav.title).toBe("More…");
  });

  it(">10 rows: nav:more:<nextOffset> id is correct and stable across pages", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    const total = 25;
    const client = makeClient(fetchImpl);
    // page 1: offset 0
    await client.sendListPage("to@x", "Pick", "Choose", rows(total), 0, total);
    // page 2: offset 9
    await client.sendListPage("to@x", "Pick", "Choose", rows(total), 9, total);
    // page 3 (final): offset 18 -> 7 remaining, no nav row (18+9=27 >= 25)
    await client.sendListPage("to@x", "Pick", "Choose", rows(total), 18, total);

    const p1 = getRows(calls[0].body);
    expect(p1[p1.length - 1].id).toBe("nav:more:9");
    expect(p1.filter((x) => !x.id.startsWith("nav")).map((x) => x.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `mgr_id:${i}`),
    );

    const p2 = getRows(calls[1].body);
    expect(p2[p2.length - 1].id).toBe("nav:more:18");
    expect(p2.filter((x) => !x.id.startsWith("nav")).map((x) => x.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `mgr_id:${i + 9}`),
    );

    const p3 = getRows(calls[2].body);
    expect(p3.some((x) => x.id.startsWith("nav:more:"))).toBe(false);
    expect(p3.map((x) => x.id)).toEqual(Array.from({ length: 7 }, (_, i) => `mgr_id:${i + 18}`));
  });

  it("posts to /messages/interactive with type:list and body text", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    await makeClient(fetchImpl).sendListPage("to@x", "Choose one", "Managers", rows(3), 0, 3);
    expect(calls[0].url).toBe("https://gate.example.test/messages/interactive");
    const body = calls[0].body as { to: string; type: string; body: { text: string }; action: { list: { label: string } } };
    expect(body.to).toBe("to@x");
    expect(body.type).toBe("list");
    expect(body.body.text).toBe("Choose one");
    expect(body.action.list.label).toBe("Managers");
  });

  it("preserves row descriptions when present", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    const withDesc: OutgoingListRow[] = [{ id: "a", title: "A", description: "desc-a" }];
    await makeClient(fetchImpl).sendListPage("to@x", "b", "l", withDesc, 0, 1);
    expect(getRows(calls[0].body)[0]).toEqual({ id: "a", title: "A", description: "desc-a" });
  });
});

describe("sendButtons", () => {
  it("posts type:button with quick_reply buttons", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    await makeClient(fetchImpl).sendButtons("to@x", "Pick", [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" },
    ]);
    expect(calls[0].url).toBe("https://gate.example.test/messages/interactive");
    const body = calls[0].body as {
      type: string;
      body: { text: string };
      action: { buttons: { type: string; id: string; title: string }[] };
    };
    expect(body.type).toBe("button");
    expect(body.body.text).toBe("Pick");
    expect(body.action.buttons).toHaveLength(2);
    expect(body.action.buttons[0]).toEqual({ type: "quick_reply", id: "yes", title: "Yes" });
  });

  it("allows exactly 3 buttons", async () => {
    const { fetchImpl } = fakePostFetch();
    await expect(
      makeClient(fetchImpl).sendButtons("to@x", "b", [
        { id: "1", title: "1" },
        { id: "2", title: "2" },
        { id: "3", title: "3" },
      ]),
    ).resolves.toBeDefined();
  });

  it("throws when given 4 buttons", async () => {
    const { fetchImpl } = fakePostFetch();
    await expect(
      makeClient(fetchImpl).sendButtons("to@x", "b", [
        { id: "1", title: "1" },
        { id: "2", title: "2" },
        { id: "3", title: "3" },
        { id: "4", title: "4" },
      ]),
    ).rejects.toThrow(/at most 3/i);
  });
});

describe("sendText", () => {
  it("posts to /messages/text with {to, body}", async () => {
    const { fetchImpl, calls } = fakePostFetch();
    await makeClient(fetchImpl).sendText("to@x", "hello");
    expect(calls[0].url).toBe("https://gate.example.test/messages/text");
    expect(calls[0].body).toEqual({ to: "to@x", body: "hello" });
  });

  it("throws on non-2xx send with status + body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad token",
    })) as unknown as typeof fetch;
    await expect(makeClient(fetchImpl).sendText("to@x", "hi")).rejects.toThrow(/401/);
  });
});
