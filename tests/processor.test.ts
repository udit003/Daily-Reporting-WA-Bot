import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getPool, closePool, cleanDb } from "./helpers/db";
import { createProcessor } from "../src/processor";
import { recordInbound } from "../src/db/queries";
import type { ParsedMessage } from "../src/whapi/types";

/**
 * Real-Postgres processor tests: ordered per-sender draining, process-once
 * semantics (duplicate ids collapsed by the UNIQUE constraint), and terminal
 * status marking.
 */

beforeAll(async () => {
  await cleanDb();
});
afterAll(async () => {
  await closePool();
});
beforeEach(async () => {
  await cleanDb();
});

function rawText(id: string, wa: string, body: string) {
  return { id, from: wa, chat_id: wa, type: "text", text: { body } };
}

describe("processor drain", () => {
  it("processes a sender's messages in batch_seq / received_at order, once each", async () => {
    const wa = "111@s.whatsapp.net";
    await recordInbound("a", wa, 0, rawText("a", wa, "first"));
    await recordInbound("b", wa, 1, rawText("b", wa, "second"));
    await recordInbound("c", wa, 2, rawText("c", wa, "third"));
    // Duplicate delivery of "b" collapses (ON CONFLICT DO NOTHING).
    const dup = await recordInbound("b", wa, 99, rawText("b", wa, "second-dup"));
    expect(dup).toBe(false);

    const seen: string[] = [];
    const route = vi.fn(async (msg: ParsedMessage) => {
      seen.push(msg.text ?? "");
    });
    const processor = createProcessor({ pool: getPool(), route });

    await processor.drain();

    expect(seen).toEqual(["first", "second", "third"]);
    // All rows marked done.
    const res = await getPool().query(
      `SELECT status FROM inbound_messages ORDER BY batch_seq`,
    );
    expect(res.rows.every((r) => r.status === "done")).toBe(true);
  });

  it("a second drain does not reprocess done rows", async () => {
    const wa = "111@s.whatsapp.net";
    await recordInbound("a", wa, 0, rawText("a", wa, "hello"));
    const route = vi.fn(async () => {});
    const processor = createProcessor({ pool: getPool(), route });

    await processor.drain();
    await processor.drain();

    expect(route).toHaveBeenCalledTimes(1);
  });

  it("marks a row 'failed' when route throws, and continues with others", async () => {
    const wa = "111@s.whatsapp.net";
    await recordInbound("a", wa, 0, rawText("a", wa, "boom"));
    await recordInbound("b", wa, 1, rawText("b", wa, "ok"));

    const route = vi.fn(async (msg: ParsedMessage) => {
      if (msg.text === "boom") throw new Error("handler failed");
    });
    const processor = createProcessor({ pool: getPool(), route });

    await processor.drain();

    const rows = await getPool().query(
      `SELECT whapi_message_id, status FROM inbound_messages ORDER BY batch_seq`,
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.whapi_message_id, r.status]));
    expect(byId["a"]).toBe("failed");
    expect(byId["b"]).toBe("done");
  });

  it("processes multiple senders", async () => {
    await recordInbound("a", "111@s.whatsapp.net", 0, rawText("a", "111@s.whatsapp.net", "x"));
    await recordInbound("b", "222@s.whatsapp.net", 0, rawText("b", "222@s.whatsapp.net", "y"));
    const senders = new Set<string>();
    const route = vi.fn(async (msg: ParsedMessage) => {
      senders.add(msg.wa_id);
    });
    const processor = createProcessor({ pool: getPool(), route });

    await processor.drain();

    expect(senders).toEqual(new Set(["111@s.whatsapp.net", "222@s.whatsapp.net"]));
  });
});
