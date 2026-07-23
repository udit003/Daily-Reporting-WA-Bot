/**
 * Async inbox processor (MUST-FIX 1).
 *
 * Drains `inbound_messages` rows recorded by the webhook. Messages are grouped
 * by sender (`wa_id`); each sender's pending rows are processed serially and in
 * arrival order (`received_at`, `batch_seq`) under a Postgres advisory
 * transaction lock keyed on the sender (`pg_advisory_xact_lock(hashtext(wa_id))`)
 * so a sender's messages never interleave and are handled exactly once.
 * Duplicate Whapi deliveries are already collapsed by the UNIQUE constraint on
 * `whapi_message_id`.
 *
 * Dependencies (pool + a `route` dispatch fn) are injected for testability. The
 * `route` fn is normally `router.route` (which resolves the User and dispatches
 * via the injected Handlers).
 */

import type { Pool, PoolClient } from "pg";
import type { InboundMessage } from "./db/queries";
import { markInbound } from "./db/queries";
import { parseMessage, type WhapiIncomingMessage } from "./whapi/types";
import { logger } from "./util/logger";

/** Dispatch a normalized message. Normally `router.route`. */
export type RouteFn = (msg: import("./whapi/types").ParsedMessage) => Promise<void>;

export interface ProcessorDeps {
  pool: Pool;
  route: RouteFn;
}

export interface Processor {
  /** Drain all currently-pending messages, sender by sender, then resolve. */
  drain(): Promise<void>;
  /** Fire-and-forget kick used by the webhook; never rejects. */
  kick(): void;
}

export function createProcessor(deps: ProcessorDeps): Processor {
  let running = false;
  let rerun = false;

  /** Distinct senders that still have pending messages. */
  async function pendingSenders(): Promise<string[]> {
    const res = await deps.pool.query<{ wa_id: string }>(
      `SELECT DISTINCT wa_id FROM inbound_messages WHERE status = 'pending'
       ORDER BY wa_id`,
    );
    return res.rows.map((r) => r.wa_id);
  }

  /**
   * Process every pending row for one sender under the sender's advisory lock,
   * in arrival order. The lock is held for the whole transaction so a
   * concurrent drain for the same sender waits rather than interleaving.
   */
  async function processSender(waId: string): Promise<void> {
    const client: PoolClient = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize per sender. hashtext() maps the wa_id to the bigint the
      // advisory-lock API expects.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [waId]);

      const rows = await client.query<InboundMessage>(
        `SELECT id, whapi_message_id, wa_id, batch_seq, raw, status,
                received_at, processed_at
         FROM inbound_messages
         WHERE wa_id = $1 AND status = 'pending'
         ORDER BY received_at, batch_seq, id`,
        [waId],
      );

      for (const row of rows.rows) {
        await dispatchRow(row);
      }

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      logger.error("processor sender drain failed", { err, waId });
    } finally {
      client.release();
    }
  }

  /** Dispatch a single inbound row and mark its terminal status. */
  async function dispatchRow(row: InboundMessage): Promise<void> {
    const parsed = parseMessage(row.raw as WhapiIncomingMessage);
    if (!parsed) {
      // Unparseable payload — nothing to route; mark done so it isn't retried.
      await markInbound(row.id, "done");
      return;
    }
    try {
      await deps.route(parsed);
      await markInbound(row.id, "done");
    } catch (err) {
      logger.error("processor dispatch failed", {
        err,
        inboundId: row.id,
        msgId: row.whapi_message_id,
      });
      await markInbound(row.id, "failed");
    }
  }

  async function drain(): Promise<void> {
    const senders = await pendingSenders();
    for (const waId of senders) {
      await processSender(waId);
    }
  }

  /**
   * Fire-and-forget kick. Coalesces concurrent kicks: if a drain is already
   * running, a single re-run is scheduled after it finishes so messages that
   * arrived mid-drain are still picked up.
   */
  function kick(): void {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          rerun = false;
          await drain();
        } while (rerun);
      } catch (err) {
        logger.error("processor kick failed", { err });
      } finally {
        running = false;
      }
    })();
  }

  return { drain, kick };
}
