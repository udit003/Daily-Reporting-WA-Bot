/**
 * Fastify webhook server (fast-ack + durable idempotent inbox).
 *
 *  - `GET /health` → 200.
 *  - `POST /webhook/:token` → 404 on secret mismatch. For each element of
 *    `body.messages[]`: reject group chats, then `recordInbound(...)`
 *    (ON CONFLICT DO NOTHING) preserving array order via `batch_seq`. Returns
 *    200 IMMEDIATELY (fast-ack) and kicks the async processor (non-blocking) —
 *    full processing never blocks the response.
 *
 * Dependencies (config, the record fn, and a processor to kick) are injectable
 * so the app can be exercised via `app.inject` in tests without real network or
 * DB side effects.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type Config } from "./config";
import { parseWebhook, type WhapiWebhookBody } from "./whapi/types";
import { recordInbound as realRecordInbound } from "./db/queries";
import { logger } from "./util/logger";

export type RecordInboundFn = (
  msgId: string,
  waId: string,
  seq: number,
  raw: unknown,
) => Promise<boolean>;

export interface ServerDeps {
  config?: Config;
  recordInbound?: RecordInboundFn;
  /** Non-blocking kick of the async processor after fast-ack. */
  kickProcessor?: () => void;
}

export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const config = deps.config ?? loadConfig();
  const recordInbound = deps.recordInbound ?? realRecordInbound;
  const kickProcessor = deps.kickProcessor ?? (() => {});

  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post<{ Params: { token: string }; Body: WhapiWebhookBody }>(
    "/webhook/:token",
    async (request, reply) => {
      if (request.params.token !== config.WEBHOOK_SECRET) {
        return reply.code(404).send({ error: "not found" });
      }

      const messages = parseWebhook(request.body);
      let seq = 0;
      for (const msg of messages) {
        // Reject group chats (no reply, not recorded).
        if (msg.is_group) continue;
        try {
          await recordInbound(msg.id, msg.wa_id, seq, msg);
        } catch (err) {
          // Recording failure must not block the fast-ack; log and continue.
          logger.error("recordInbound failed", { err, msgId: msg.id });
        }
        seq += 1;
      }

      // Fast-ack: respond 200 immediately, then kick async processing.
      reply.code(200).send({ ok: true });
      // Kick AFTER scheduling the response so processing never blocks the ack.
      // Fire-and-forget: a synchronous throw here must never affect the ack.
      try {
        kickProcessor();
      } catch (err) {
        logger.error("kickProcessor threw", { err });
      }
      return reply;
    },
  );

  return app;
}
