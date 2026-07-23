/**
 * Structure a raw daily update (voice transcript OR text) into a validated
 * report object using the chat model. Same function serves both the voice and
 * text paths. The model is asked for strict JSON; the response is Zod-validated
 * with one repair retry, then a safe fallback.
 */

import OpenAI from "openai";
import { z } from "zod";
import { loadConfig } from "../config";
import { getOpenAI } from "./client";

/** Validated structured report. */
export const StructuredReportSchema = z.object({
  summary: z.string(),
  tasks_done: z.array(z.string()),
  blockers: z.array(z.string()),
  projects: z.array(z.string()),
  next_steps: z.array(z.string()),
});

export type StructuredReportData = z.infer<typeof StructuredReportSchema>;

/** Result of structuring: the parsed report plus a `_fallback` flag. */
export interface StructureResult extends StructuredReportData {
  _fallback?: boolean;
}

const MAX_FALLBACK_SUMMARY = 2000;

const SYSTEM_PROMPT = [
  "You extract a structured daily work report from a team member's update.",
  "The update may be in English, Hindi, or Hinglish; understand it regardless.",
  "Respond with a single JSON object and NOTHING else, with exactly these keys:",
  '  "summary": string — a concise 1-2 sentence summary of the update.',
  '  "tasks_done": string[] — concrete things completed today.',
  '  "blockers": string[] — issues, pending items, or things stuck/waiting.',
  '  "projects": string[] — raw project-name strings mentioned (verbatim as spoken).',
  '  "next_steps": string[] — planned follow-up actions.',
  "Use empty arrays when a category has no items. Do not invent projects.",
].join("\n");

/**
 * Normalize a validated report: coerce arrays, trim strings, drop
 * empty/whitespace-only project names.
 */
function normalize(data: StructuredReportData): StructuredReportData {
  const cleanArr = (a: string[]): string[] =>
    (Array.isArray(a) ? a : []).map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0);
  return {
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    tasks_done: cleanArr(data.tasks_done),
    blockers: cleanArr(data.blockers),
    projects: cleanArr(data.projects),
    next_steps: cleanArr(data.next_steps),
  };
}

function fallback(transcriptOrText: string): StructureResult {
  const summary = transcriptOrText.trim().slice(0, MAX_FALLBACK_SUMMARY);
  return {
    summary,
    tasks_done: [],
    blockers: [],
    projects: [],
    next_steps: [],
    _fallback: true,
  };
}

export async function structure(
  transcriptOrText: string,
  language?: string,
  client: OpenAI = getOpenAI(),
): Promise<StructureResult> {
  const cfg = loadConfig();
  const langHint = language && language !== "text-provided" ? ` The update language is ${language}.` : "";

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT + langHint },
    { role: "user", content: transcriptOrText },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await client.chat.completions.create({
        model: cfg.OPENAI_CHAT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
      });
      content = res.choices[0]?.message?.content ?? "";
    } catch {
      // Network / API error — go straight to fallback (already-committed
      // report semantics live in the caller; here we just degrade gracefully).
      return fallback(transcriptOrText);
    }

    const parsed = safeParseJson(content);
    const result = StructuredReportSchema.safeParse(parsed);
    if (result.success) {
      return normalize(result.data);
    }

    if (attempt === 0) {
      // Ask the model to repair, quoting the validation error.
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "That response was not valid. Fix it and return ONLY the JSON object with the required keys. Validation errors:\n" +
          result.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
      });
    }
  }

  return fallback(transcriptOrText);
}

/** Parse JSON, tolerating occasional fenced/garbage output; null on failure. */
export function safeParseJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to extract the first {...} block.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
