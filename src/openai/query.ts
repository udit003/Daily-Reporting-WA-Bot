/**
 * Manager Q&A OpenAI wrappers:
 *  - `extractIntent`       — parse a free-text question into a scoped intent.
 *  - `classifyManagerText` — disambiguate manager text as REPORT vs QUERY.
 *  - `answer`              — answer a question grounded ONLY in provided reports.
 *
 * All model outputs that must be structured are Zod-validated with one repair
 * retry and a safe fallback (never throw to the caller).
 */

import OpenAI from "openai";
import { z } from "zod";
import { loadConfig } from "../config";
import { getOpenAI } from "./client";
import { safeParseJson } from "./structure";

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

export const IntentSchema = z.object({
  person_name: z.string().optional(),
  project_name: z.string().optional(),
  date_phrase: z.string().optional(),
  kind: z.string(),
});

export type Intent = z.infer<typeof IntentSchema>;

/** Minimal safe intent returned on any failure. */
export const FALLBACK_INTENT: Intent = { kind: "general" };

const INTENT_SYSTEM_PROMPT = [
  "You extract a structured search intent from a manager's free-text question about their team.",
  "Return a single JSON object with these keys (omit optional keys when not present):",
  '  "person_name": string (optional) — a specific team member the question is about.',
  '  "project_name": string (optional) — a specific project mentioned.',
  '  "date_phrase": string (optional) — a relative date phrase verbatim ("today", "this week", "last 7 days").',
  '  "kind": string — a short label for the question type (e.g. "person_status", "project_status", "general").',
  "Do NOT invent concrete dates; only copy the relative phrase if present.",
  "Respond with the JSON object and nothing else.",
].join("\n");

export async function extractIntent(
  question: string,
  client: OpenAI = getOpenAI(),
): Promise<Intent> {
  const cfg = loadConfig();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: INTENT_SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await client.chat.completions.create({
        model: cfg.OPENAI_CLASSIFY_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
      });
      content = res.choices[0]?.message?.content ?? "";
    } catch {
      return { ...FALLBACK_INTENT };
    }

    const result = IntentSchema.safeParse(safeParseJson(content));
    if (result.success) return normalizeIntent(result.data);

    if (attempt === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "That response was not valid. Return ONLY the JSON object with a required string 'kind'. Errors:\n" +
          result.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
      });
    }
  }

  return { ...FALLBACK_INTENT };
}

function normalizeIntent(data: Intent): Intent {
  const clean = (s?: string): string | undefined => {
    if (typeof s !== "string") return undefined;
    const t = s.trim();
    return t.length > 0 ? t : undefined;
  };
  const out: Intent = { kind: data.kind.trim() || "general" };
  const person = clean(data.person_name);
  const project = clean(data.project_name);
  const date = clean(data.date_phrase);
  if (person) out.person_name = person;
  if (project) out.project_name = project;
  if (date) out.date_phrase = date;
  return out;
}

// ---------------------------------------------------------------------------
// REPORT / QUERY classification
// ---------------------------------------------------------------------------

export const ClassificationSchema = z.object({
  label: z.enum(["REPORT", "QUERY"]),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/** Safe fallback: treat ambiguous manager text as a QUERY. */
export const FALLBACK_CLASSIFICATION: Classification = { label: "QUERY" };

const CLASSIFY_SYSTEM_PROMPT = [
  "You classify a manager's WhatsApp message as either REPORT or QUERY.",
  'REPORT = a first-person status update about their own work ("I did", "aaj maine", "completed", "met client").',
  "QUERY = a question about someone/something else, asking for information.",
  'Return a single JSON object: {"label": "REPORT"} or {"label": "QUERY"}. Nothing else.',
].join("\n");

export async function classifyManagerText(
  text: string,
  client: OpenAI = getOpenAI(),
): Promise<Classification> {
  const cfg = loadConfig();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
    { role: "user", content: text },
  ];

  try {
    const res = await client.chat.completions.create({
      model: cfg.OPENAI_CLASSIFY_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    });
    const content = res.choices[0]?.message?.content ?? "";
    const result = ClassificationSchema.safeParse(safeParseJson(content));
    if (result.success) return result.data;
  } catch {
    // fall through to safe fallback
  }
  return { ...FALLBACK_CLASSIFICATION };
}

// ---------------------------------------------------------------------------
// Grounded answer
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM_PROMPT = [
  "You answer a manager's question about their team using ONLY the provided reports.",
  "If the information needed is not present in the reports, say you don't have that information.",
  "Do not invent facts. Be concise and specific, citing what people reported.",
].join("\n");

/**
 * Answer a question grounded only in `contextReports` (a compact array built by
 * the caller). Returns the answer string.
 */
export async function answer(
  question: string,
  contextReports: unknown[],
  client: OpenAI = getOpenAI(),
): Promise<string> {
  const cfg = loadConfig();
  const userContent = JSON.stringify({ question, reports: contextReports ?? [] });

  const res = await client.chat.completions.create({
    model: cfg.OPENAI_CHAT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: ANSWER_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Status digest summary (CHANGE G)
// ---------------------------------------------------------------------------

/** One report's compact shape fed to `summarizeDigest`. */
export interface DigestReport {
  reporterName: string;
  projects: string[];
  summary: string;
  tasks_done: string[];
  blockers: string[];
  next_steps: string[];
}

/** Structured digest the model MAY emit (validated + rendered to text). */
export const DigestSchema = z.object({
  sections: z.array(
    z.object({
      project: z.string(),
      points: z.array(z.string()),
    }),
  ),
  other: z.array(z.string()),
});

export type DigestData = z.infer<typeof DigestSchema>;

const DIGEST_SYSTEM_PROMPT = [
  "You produce a concise daily status digest for a manager from today's team reports.",
  "Group the update points BY PROJECT NAME. Put any points not tied to a specific project under a separate \"Other updates\" bucket.",
  "Ground the digest STRICTLY in the provided reports — never invent projects, people, or facts.",
  "Attribute points to the reporter where useful. Keep it tight and skimmable.",
  "Respond with a single JSON object and NOTHING else, with exactly these keys:",
  '  "sections": array of {"project": string, "points": string[]} — one entry per project.',
  '  "other": string[] — update points not linked to any project.',
  "Use an empty array when a category has no items.",
].join("\n");

/** Render a validated structured digest to a WhatsApp-friendly string. */
export function renderDigest(data: DigestData): string {
  const parts: string[] = [];
  for (const section of data.sections) {
    const project = section.project.trim();
    const points = section.points.map((p) => p.trim()).filter((p) => p.length > 0);
    if (!project || points.length === 0) continue;
    parts.push(`*${project}*\n${points.map((p) => `• ${p}`).join("\n")}`);
  }
  const other = data.other.map((p) => p.trim()).filter((p) => p.length > 0);
  if (other.length > 0) {
    parts.push(`*Other updates*\n${other.map((p) => `• ${p}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Summarize today's subtree reports into a concise project-grouped digest with
 * an "Other updates" bucket. Returns plain text. Throws on LLM/parse failure so
 * the caller can fall back to a deterministic app-side grouping.
 */
export async function summarizeDigest(
  reports: DigestReport[],
  client: OpenAI = getOpenAI(),
): Promise<string> {
  const cfg = loadConfig();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: DIGEST_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ reports }) },
  ];

  let content = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat.completions.create({
      model: cfg.OPENAI_CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages,
    });
    content = res.choices[0]?.message?.content ?? "";

    const result = DigestSchema.safeParse(safeParseJson(content));
    if (result.success) {
      const rendered = renderDigest(result.data);
      if (rendered.trim().length > 0) return rendered;
      // Empty render (nothing groupable) — let the caller fall back.
      throw new Error("digest render produced empty output");
    }

    if (attempt === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          "That response was not valid. Return ONLY the JSON object with 'sections' and 'other'. Errors:\n" +
          result.error.issues
            .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n"),
      });
    }
  }

  throw new Error("summarizeDigest: could not produce a valid digest");
}
