/**
 * Acknowledge + optional contextual follow-up. After a report is stored, the
 * pipeline calls this with the just-submitted structured report and the user's
 * recent N structured reports. The model returns a warm one-line
 * acknowledgement and a follow-up nudge ONLY IF it adds value (e.g. an
 * unresolved blocker from a prior day, a still-pending task) — otherwise null.
 *
 * Failure contract: `acknowledgeAndFollowup` THROWS a typed
 * {@link FollowupError} on any failure (API error, invalid JSON after one
 * repair retry). The convenience helper {@link safeAcknowledgeAndFollowup}
 * catches that and returns the static fallback ({@link STATIC_ACKNOWLEDGEMENT},
 * `followup: null`) so callers can degrade without try/catch. The already-
 * committed report is never affected.
 */

import OpenAI from "openai";
import { z } from "zod";
import { loadConfig } from "../config";
import { getOpenAI } from "./client";
import { safeParseJson } from "./structure";

export const FollowupSchema = z.object({
  acknowledgement: z.string(),
  followup: z.string().nullable(),
});

export type FollowupResult = z.infer<typeof FollowupSchema>;

/** Static acknowledgement used whenever the LLM path fails. */
export const STATIC_ACKNOWLEDGEMENT = "Got it, thanks — logged your update for today.";

export class FollowupError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "FollowupError";
  }
}

const SYSTEM_PROMPT = [
  "You are a supportive team lead acknowledging a team member's daily work update.",
  "You are given the user's just-submitted structured report and their recent prior reports.",
  "Return a single JSON object with exactly these keys:",
  '  "acknowledgement": string — a warm, brief (one line) acknowledgement of today\'s update.',
  '  "followup": string | null — a short nudge ONLY IF it adds value',
  "     (e.g. a blocker mentioned on a prior day still looks unresolved, or a pending task).",
  "     If nothing meaningful to follow up on, return null. Do not force a follow-up.",
  "Respond with the JSON object and nothing else.",
].join("\n");

/**
 * Ask the model for an acknowledgement + optional follow-up. Throws
 * {@link FollowupError} on any failure (after one repair retry).
 */
export async function acknowledgeAndFollowup(
  todayReport: unknown,
  recentReports: unknown[],
  client: OpenAI = getOpenAI(),
): Promise<FollowupResult> {
  const cfg = loadConfig();
  const userContent = JSON.stringify({
    today: todayReport,
    recent: recentReports ?? [],
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await client.chat.completions.create({
        model: cfg.OPENAI_CHAT_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages,
      });
      content = res.choices[0]?.message?.content ?? "";
    } catch (err) {
      throw new FollowupError("acknowledgeAndFollowup API call failed", err);
    }

    const parsed = safeParseJson(content);
    const result = FollowupSchema.safeParse(parsed);
    if (result.success) {
      const ack = result.data.acknowledgement.trim();
      const followupRaw = result.data.followup;
      const followup =
        typeof followupRaw === "string" && followupRaw.trim().length > 0
          ? followupRaw.trim()
          : null;
      return { acknowledgement: ack.length > 0 ? ack : STATIC_ACKNOWLEDGEMENT, followup };
    }

    lastError = result.error;
    if (attempt === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "That response was not valid. Return ONLY the JSON object with keys acknowledgement (string) and followup (string or null). Validation errors:\n" +
          result.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
      });
    }
  }

  throw new FollowupError("acknowledgeAndFollowup returned invalid JSON after repair", lastError);
}

/**
 * Convenience wrapper: never throws. On any failure returns the static
 * acknowledgement with no follow-up.
 */
export async function safeAcknowledgeAndFollowup(
  todayReport: unknown,
  recentReports: unknown[],
  client?: OpenAI,
): Promise<FollowupResult> {
  try {
    return await acknowledgeAndFollowup(todayReport, recentReports, client);
  } catch {
    return { acknowledgement: STATIC_ACKNOWLEDGEMENT, followup: null };
  }
}
