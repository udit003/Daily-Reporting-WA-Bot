import { describe, it, expect, vi, beforeAll } from "vitest";
import { buildServer } from "../src/server";
import { parseMessage } from "../src/whapi/types";
import type { Config } from "../src/config";

beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

const SECRET = "s3cr3t";

function testConfig(): Config {
  return {
    PORT: 8080,
    WHAPI_TOKEN: "t",
    WHAPI_BASE_URL: "https://gate.whapi.cloud",
    OPENAI_API_KEY: "k",
    OPENAI_CHAT_MODEL: "gpt-4o",
    OPENAI_CLASSIFY_MODEL: "gpt-4o-mini",
    DATABASE_URL: "postgres://localhost/test",
    WEBHOOK_SECRET: SECRET,
    REMINDER_TZ: "Asia/Kolkata",
    REMINDER_START: "17:00",
    REMINDER_INTERVAL_MIN: 15,
    REMINDER_STOP: "22:00",
    RECENT_REPORTS_FOR_FOLLOWUP: 5,
    PROJECT_MATCH_THRESHOLD: 0.45,
    MAX_MEDIA_BYTES: 26_214_400,
    BOT_NUMBER: undefined,
    SEED_CEO_PHONE: undefined,
    SEED_CEO_NAME: "Gopal Narang",
  };
}

/** In-memory recordInbound that collapses on duplicate message id. */
function fakeRecorder() {
  const seen = new Set<string>();
  const inserts: { id: string; waId: string; seq: number; raw: unknown }[] = [];
  const recordInbound = vi.fn(
    async (id: string, waId: string, seq: number, raw: unknown) => {
      if (seen.has(id)) return false; // ON CONFLICT DO NOTHING
      seen.add(id);
      inserts.push({ id, waId, seq, raw });
      return true;
    },
  );
  return { recordInbound, inserts, seen };
}

function textMsg(id: string, wa: string, body: string) {
  return { id, from: wa, chat_id: wa, type: "text", text: { body } };
}

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const app = buildServer({ config: testConfig(), recordInbound: vi.fn(async () => true) });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("POST /webhook/:token secret path", () => {
  it("mismatched token → 404, nothing recorded", async () => {
    const { recordInbound } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    const res = await app.inject({
      method: "POST",
      url: "/webhook/wrong-secret",
      payload: { messages: [textMsg("m1", "111@s.whatsapp.net", "hi")] },
    });
    expect(res.statusCode).toBe(404);
    expect(recordInbound).not.toHaveBeenCalled();
    await app.close();
  });

  it("correct token → 200", async () => {
    const { recordInbound } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${SECRET}`,
      payload: { messages: [textMsg("m1", "111@s.whatsapp.net", "hi")] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /webhook idempotency + ordering", () => {
  it("duplicate webhook id inserts once", async () => {
    const { recordInbound, inserts } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    const payload = { messages: [textMsg("dup", "111@s.whatsapp.net", "hi")] };
    await app.inject({ method: "POST", url: `/webhook/${SECRET}`, payload });
    await app.inject({ method: "POST", url: `/webhook/${SECRET}`, payload });
    // recordInbound called twice, but only one actual insert (dedup).
    expect(recordInbound).toHaveBeenCalledTimes(2);
    expect(inserts).toHaveLength(1);
    await app.close();
  });

  it("batched messages[] recorded in array order via batch_seq", async () => {
    const { recordInbound, inserts } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    await app.inject({
      method: "POST",
      url: `/webhook/${SECRET}`,
      payload: {
        messages: [
          textMsg("a", "111@s.whatsapp.net", "first"),
          textMsg("b", "111@s.whatsapp.net", "second"),
          textMsg("c", "111@s.whatsapp.net", "third"),
        ],
      },
    });
    expect(inserts.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(inserts.map((i) => i.seq)).toEqual([0, 1, 2]);
    await app.close();
  });

  it("stores the ORIGINAL raw Whapi message so the processor can re-parse text", async () => {
    // Regression: the server must persist the raw wire message (text.body),
    // not the already-parsed form — otherwise the processor's parseMessage
    // pass drops the text and every post-greeting step sees empty input.
    const { recordInbound, inserts } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    await app.inject({
      method: "POST",
      url: `/webhook/${SECRET}`,
      payload: { messages: [textMsg("m1", "111@s.whatsapp.net", "Gopal Narang")] },
    });
    expect(inserts).toHaveLength(1);
    // The stored raw round-trips through parseMessage to recover the text.
    const reparsed = parseMessage(inserts[0].raw as any);
    expect(reparsed?.text).toBe("Gopal Narang");
    await app.close();
  });
});

describe("POST /webhook group rejection", () => {
  it("group chat message is not recorded", async () => {
    const { recordInbound, inserts } = fakeRecorder();
    const app = buildServer({ config: testConfig(), recordInbound });
    await app.inject({
      method: "POST",
      url: `/webhook/${SECRET}`,
      payload: {
        messages: [
          { id: "g1", from: "111@s.whatsapp.net", chat_id: "abc@g.us", type: "text", text: { body: "hi" } },
          textMsg("u1", "222@s.whatsapp.net", "hello"),
        ],
      },
    });
    expect(inserts.map((i) => i.id)).toEqual(["u1"]);
    await app.close();
  });
});

describe("POST /webhook fast-ack (200 before processing completes)", () => {
  it("returns 200 while the kicked processor is still working (non-blocking)", async () => {
    const { recordInbound } = fakeRecorder();
    let processingComplete = false;
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    // kickProcessor is fire-and-forget: it schedules async work that only
    // finishes once we release the gate — which we do AFTER asserting the ack.
    const kickProcessor = vi.fn(() => {
      void (async () => {
        await workGate;
        processingComplete = true;
      })();
    });
    const app = buildServer({ config: testConfig(), recordInbound, kickProcessor });

    const res = await app.inject({
      method: "POST",
      url: `/webhook/${SECRET}`,
      payload: { messages: [textMsg("m1", "111@s.whatsapp.net", "hi")] },
    });

    // Ack arrives BEFORE processing completes.
    expect(res.statusCode).toBe(200);
    expect(kickProcessor).toHaveBeenCalledTimes(1);
    expect(processingComplete).toBe(false);

    // Now let processing finish; it never affected the already-returned ack.
    releaseWork();
    await workGate;
    await app.close();
  });

  it("processing errors in the kicked processor never affect the 200 ack", async () => {
    const { recordInbound } = fakeRecorder();
    const kickProcessor = vi.fn(() => {
      // Fire-and-forget processor throwing synchronously must not surface to the
      // webhook (which has already scheduled its 200 response).
      throw new Error("processor boom");
    });
    const app = buildServer({ config: testConfig(), recordInbound, kickProcessor });
    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: "POST",
        url: `/webhook/${SECRET}`,
        payload: { messages: [textMsg("m1", "111@s.whatsapp.net", "hi")] },
      });
    } finally {
      // nothing
    }
    expect(res!.statusCode).toBe(200);
    await app.close();
  });
});
