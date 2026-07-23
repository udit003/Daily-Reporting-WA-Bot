/**
 * Whapi webhook payload types + a parser that normalizes each incoming message
 * into a single flat shape the domain layer can dispatch on.
 *
 * Canonical identity: `wa_id = chat_id ?? from`. Group chats (`wa_id` ending in
 * `@g.us`) are rejected — the parser marks them so callers can skip with no
 * reply. Text/voice/audio/interactive-reply payloads are flattened into
 * `text`, `mediaId`/`mediaType`, and `reply` fields respectively.
 */

/** A reply.buttons_reply / reply.list_reply body from an interactive message. */
export interface WhapiReplyRef {
  id: string;
  title: string;
}

/** Raw incoming message object as delivered inside `body.messages[]`. */
export interface WhapiIncomingMessage {
  id: string;
  from?: string;
  from_me?: boolean;
  chat_id?: string;
  type?: string;
  timestamp?: number;
  text?: { body?: string };
  voice?: { id?: string };
  audio?: { id?: string };
  reply?: {
    type?: string;
    buttons_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  [k: string]: unknown;
}

/** Top-level webhook envelope Whapi POSTs to the webhook URL. */
export interface WhapiWebhookBody {
  messages?: WhapiIncomingMessage[];
  [k: string]: unknown;
}

/**
 * Normalized message the router/processor works with. Media/text/reply fields
 * are optional and populated based on `type`.
 */
export interface ParsedMessage {
  id: string;
  from: string;
  from_me: boolean;
  chat_id: string | null;
  type: string;
  timestamp: number | null;
  /** Canonical identity + outbound `to` = chat_id ?? from. */
  wa_id: string;
  /** true when wa_id ends in `@g.us` — caller must skip (no reply). */
  is_group: boolean;
  text?: string;
  mediaId?: string;
  mediaType?: string; // 'voice' | 'audio'
  reply?: WhapiReplyRef;
}

/**
 * Parse a Whapi webhook body into normalized messages. Messages missing an id
 * or a resolvable wa_id are dropped. Group-chat messages are returned with
 * `is_group: true` so callers can uniformly skip them.
 */
export function parseWebhook(body: WhapiWebhookBody | undefined | null): ParsedMessage[] {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return [];
  const out: ParsedMessage[] = [];
  for (const raw of messages) {
    const parsed = parseMessage(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse a single raw message; returns null if it lacks an id/wa_id. */
export function parseMessage(
  raw: WhapiIncomingMessage | undefined | null,
): ParsedMessage | null {
  if (!raw || typeof raw.id !== "string" || raw.id === "") return null;

  const chat_id = typeof raw.chat_id === "string" && raw.chat_id !== "" ? raw.chat_id : null;
  const from = typeof raw.from === "string" ? raw.from : "";
  const wa_id = chat_id ?? from;
  if (!wa_id) return null;

  const msg: ParsedMessage = {
    id: raw.id,
    from,
    from_me: raw.from_me === true,
    chat_id,
    type: typeof raw.type === "string" ? raw.type : "",
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : null,
    wa_id,
    is_group: wa_id.endsWith("@g.us"),
  };

  // Text
  const textBody = raw.text?.body;
  if (typeof textBody === "string" && textBody.length > 0) {
    msg.text = textBody;
  }

  // Voice / audio media
  const voiceId = raw.voice?.id;
  const audioId = raw.audio?.id;
  if (typeof voiceId === "string" && voiceId !== "") {
    msg.mediaId = voiceId;
    msg.mediaType = "voice";
  } else if (typeof audioId === "string" && audioId !== "") {
    msg.mediaId = audioId;
    msg.mediaType = "audio";
  }

  // Interactive reply (button / list)
  const buttonReply = raw.reply?.buttons_reply;
  const listReply = raw.reply?.list_reply;
  const chosen = buttonReply ?? listReply;
  if (chosen && typeof chosen.id === "string" && chosen.id !== "") {
    msg.reply = {
      id: normalizeReplyId(chosen.id),
      title: typeof chosen.title === "string" ? chosen.title : "",
    };
  }

  return msg;
}

/**
 * WhatsApp/Whapi wrap the row id we send in a list message with a versioned
 * prefix on the way back (e.g. we send `mgr_id:1` and receive
 * `ListV3:mgr_id:1`). The router matches on our bare ids (`mgr_id:`,
 * `mgr:none`, `nav:more:`…), so strip any leading `ListV<n>:` prefix here — the
 * single parse boundary — so downstream matching is prefix-agnostic.
 */
export function normalizeReplyId(id: string): string {
  return id.replace(/^List(?:V\d+)?:/i, "");
}

// ---------------------------------------------------------------------------
// Outgoing message payload types (mirrors the Whapi request bodies we build).
// ---------------------------------------------------------------------------

export interface OutgoingTextPayload {
  to: string;
  body: string;
}

export interface OutgoingButton {
  type: "quick_reply";
  title: string;
  id: string;
}

export interface OutgoingInteractiveButtonPayload {
  to: string;
  type: "button";
  body: { text: string };
  action: { buttons: OutgoingButton[] };
}

export interface OutgoingListRow {
  id: string;
  title: string;
  description?: string;
}

export interface OutgoingListSection {
  title?: string;
  rows: OutgoingListRow[];
}

export interface OutgoingInteractiveListPayload {
  to: string;
  type: "list";
  body: { text: string };
  action: { list: { label: string; sections: OutgoingListSection[] } };
}

export interface OutgoingVoicePayload {
  to: string;
  media: string; // base64 (or data URI) ogg audio
}
