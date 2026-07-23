import { describe, it, expect, beforeAll, vi } from "vitest";
import { structure } from "../src/openai/structure";
import {
  acknowledgeAndFollowup,
  safeAcknowledgeAndFollowup,
  FollowupError,
  STATIC_ACKNOWLEDGEMENT,
} from "../src/openai/followup";
import {
  extractIntent,
  classifyManagerText,
  answer,
  FALLBACK_INTENT,
} from "../src/openai/query";
import type OpenAI from "openai";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

/** Build a fake OpenAI client whose chat.completions.create returns queued contents. */
function fakeChatClient(contents: (string | Error)[]): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  let i = 0;
  const create = vi.fn(async () => {
    const c = contents[Math.min(i, contents.length - 1)];
    i++;
    if (c instanceof Error) throw c;
    return { choices: [{ message: { content: c } }] };
  });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

describe("structure()", () => {
  it("parses valid JSON into a normalized report", async () => {
    const { client } = fakeChatClient([
      JSON.stringify({
        summary: "Did site visits.",
        tasks_done: ["3 site visits", "2 bookings"],
        blockers: ["1 approval pending"],
        projects: ["Narang Vivenda"],
        next_steps: ["Follow up approval"],
      }),
    ]);
    const res = await structure("Aaj Narang Vivenda me 3 site visits", "hindi", client);
    expect(res._fallback).toBeUndefined();
    expect(res.summary).toBe("Did site visits.");
    expect(res.projects).toEqual(["Narang Vivenda"]);
  });

  it("drops empty/whitespace-only project names and trims", async () => {
    const { client } = fakeChatClient([
      JSON.stringify({
        summary: "  hi  ",
        tasks_done: ["  a ", "", "   "],
        blockers: [],
        projects: ["Narang Vivenda", "", "  ", " Windsor BKC "],
        next_steps: [],
      }),
    ]);
    const res = await structure("text", undefined, client);
    expect(res.summary).toBe("hi");
    expect(res.tasks_done).toEqual(["a"]);
    expect(res.projects).toEqual(["Narang Vivenda", "Windsor BKC"]);
  });

  it("malformed JSON triggers one repair, then valid on retry", async () => {
    const { client, create } = fakeChatClient([
      "not json at all",
      JSON.stringify({
        summary: "ok",
        tasks_done: [],
        blockers: [],
        projects: [],
        next_steps: [],
      }),
    ]);
    const res = await structure("text", undefined, client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(res._fallback).toBeUndefined();
    expect(res.summary).toBe("ok");
  });

  it("repeated malformed JSON returns the fallback object", async () => {
    const { client, create } = fakeChatClient(["garbage", "still garbage"]);
    const res = await structure("  original transcript here  ", undefined, client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(res._fallback).toBe(true);
    expect(res.summary).toBe("original transcript here");
    expect(res.projects).toEqual([]);
  });

  it("API error returns fallback immediately", async () => {
    const { client } = fakeChatClient([new Error("network down")]);
    const res = await structure("raw text", undefined, client);
    expect(res._fallback).toBe(true);
    expect(res.summary).toBe("raw text");
  });
});

describe("acknowledgeAndFollowup()", () => {
  it("returns ack + non-null followup when the model provides one", async () => {
    const { client } = fakeChatClient([
      JSON.stringify({ acknowledgement: "Nice work!", followup: "Any update on that pending approval?" }),
    ]);
    const res = await acknowledgeAndFollowup({ summary: "x" }, [{ summary: "y" }], client);
    expect(res.acknowledgement).toBe("Nice work!");
    expect(res.followup).toBe("Any update on that pending approval?");
  });

  it("normalizes empty-string followup to null", async () => {
    const { client } = fakeChatClient([
      JSON.stringify({ acknowledgement: "Got it", followup: "   " }),
    ]);
    const res = await acknowledgeAndFollowup({}, [], client);
    expect(res.followup).toBeNull();
  });

  it("throws FollowupError on repeated invalid JSON (after one repair)", async () => {
    const { client, create } = fakeChatClient(["bad", "worse"]);
    await expect(acknowledgeAndFollowup({}, [], client)).rejects.toBeInstanceOf(FollowupError);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws FollowupError on API failure", async () => {
    const { client } = fakeChatClient([new Error("boom")]);
    await expect(acknowledgeAndFollowup({}, [], client)).rejects.toBeInstanceOf(FollowupError);
  });

  it("safeAcknowledgeAndFollowup falls back to static ack + null followup on failure", async () => {
    const { client } = fakeChatClient([new Error("boom")]);
    const res = await safeAcknowledgeAndFollowup({}, [], client);
    expect(res.acknowledgement).toBe(STATIC_ACKNOWLEDGEMENT);
    expect(res.followup).toBeNull();
  });
});

describe("extractIntent()", () => {
  it("parses a valid intent and normalizes optional fields", async () => {
    const { client } = fakeChatClient([
      JSON.stringify({
        person_name: " Rohit ",
        project_name: "",
        date_phrase: "this week",
        kind: "person_status",
      }),
    ]);
    const res = await extractIntent("What did Rohit do this week?", client);
    expect(res.kind).toBe("person_status");
    expect(res.person_name).toBe("Rohit");
    expect(res.project_name).toBeUndefined();
    expect(res.date_phrase).toBe("this week");
  });

  it("repeated invalid output returns the minimal safe intent", async () => {
    const { client } = fakeChatClient(["nope", "nada"]);
    const res = await extractIntent("blah", client);
    expect(res).toEqual(FALLBACK_INTENT);
  });

  it("API error returns fallback intent", async () => {
    const { client } = fakeChatClient([new Error("down")]);
    expect(await extractIntent("q", client)).toEqual(FALLBACK_INTENT);
  });
});

describe("classifyManagerText()", () => {
  it("returns REPORT when the model says so", async () => {
    const { client } = fakeChatClient([JSON.stringify({ label: "REPORT" })]);
    expect(await classifyManagerText("Aaj maine sales review kiya", client)).toEqual({ label: "REPORT" });
  });

  it("returns QUERY for a question", async () => {
    const { client } = fakeChatClient([JSON.stringify({ label: "QUERY" })]);
    expect(await classifyManagerText("What did Sana do?", client)).toEqual({ label: "QUERY" });
  });

  it("falls back to QUERY on invalid label", async () => {
    const { client } = fakeChatClient([JSON.stringify({ label: "MAYBE" })]);
    expect(await classifyManagerText("ambiguous", client)).toEqual({ label: "QUERY" });
  });

  it("falls back to QUERY on API error", async () => {
    const { client } = fakeChatClient([new Error("boom")]);
    expect(await classifyManagerText("x", client)).toEqual({ label: "QUERY" });
  });
});

describe("answer()", () => {
  it("returns the model's grounded answer string", async () => {
    const { client, create } = fakeChatClient(["Rohit closed 2 bookings this week."]);
    const res = await answer("What did Rohit do?", [{ summary: "closed 2 bookings" }], client);
    expect(res).toBe("Rohit closed 2 bookings this week.");
    // system prompt should instruct grounding
    const messages = create.mock.calls[0][0].messages;
    expect(messages[0].role).toBe("system");
    expect(String(messages[0].content)).toMatch(/only|don't have/i);
  });
});
