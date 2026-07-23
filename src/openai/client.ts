/**
 * OpenAI SDK singleton. Constructed lazily from `loadConfig().OPENAI_API_KEY`
 * (which already resolves the `OPENAI_API_KEY__*` alias). All OpenAI wrappers
 * import `getOpenAI()` so tests can inject a fake client where needed.
 */

import OpenAI from "openai";
import { loadConfig } from "../config";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (client) return client;
  const cfg = loadConfig();
  client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  return client;
}

/** Test-only: reset the cached client. */
export function __resetOpenAICache(): void {
  client = null;
}
