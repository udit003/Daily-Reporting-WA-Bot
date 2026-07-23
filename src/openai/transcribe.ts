/**
 * Whisper transcription wrapper. Takes a downloaded media buffer + its
 * content-type and returns `{ text, language }`. Language is auto-detected
 * (never forced) so Hindi / Hinglish / English all work. Unsupported
 * content-types are rejected before any API call.
 */

import OpenAI, { toFile } from "openai";
import { getOpenAI } from "./client";

export interface TranscribeInput {
  buffer: Buffer;
  contentType: string;
}

export interface TranscribeResult {
  text: string;
  language: string | null;
}

/** content-type → upload filename extension. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
};

/** Normalize a content-type header ("audio/ogg; codecs=opus") to its base. */
function baseContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

export function isSupportedAudioContentType(contentType: string): boolean {
  return baseContentType(contentType) in CONTENT_TYPE_EXT;
}

/** Derive an upload filename from the content-type; defaults to `.ogg`. */
export function filenameForContentType(contentType: string): string {
  const ext = CONTENT_TYPE_EXT[baseContentType(contentType)] ?? ".ogg";
  return `audio${ext}`;
}

export async function transcribe(
  input: TranscribeInput,
  client: OpenAI = getOpenAI(),
): Promise<TranscribeResult> {
  const base = baseContentType(input.contentType);
  if (!isSupportedAudioContentType(input.contentType)) {
    throw new Error(`Unsupported audio content-type: ${base}`);
  }

  const file = await toFile(input.buffer, filenameForContentType(input.contentType), {
    type: base,
  });

  const res = await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
  });

  // verbose_json returns { text, language, ... }; typings expose `text`.
  const text = typeof (res as { text?: unknown }).text === "string"
    ? (res as { text: string }).text
    : "";
  const language =
    typeof (res as { language?: unknown }).language === "string"
      ? (res as { language: string }).language
      : null;

  return { text, language };
}
