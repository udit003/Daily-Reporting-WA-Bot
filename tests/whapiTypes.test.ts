import { describe, it, expect } from "vitest";
import { parseWebhook, parseMessage } from "../src/whapi/types";

describe("parseMessage normalization", () => {
  it("parses a text message to the normalized shape", () => {
    const m = parseMessage({
      id: "m1",
      from: "919111111111@s.whatsapp.net",
      chat_id: "919111111111@s.whatsapp.net",
      type: "text",
      timestamp: 1700000000,
      text: { body: "Aaj 3 site visits kiye" },
    });
    expect(m).toMatchObject({
      id: "m1",
      wa_id: "919111111111@s.whatsapp.net",
      type: "text",
      timestamp: 1700000000,
      is_group: false,
      text: "Aaj 3 site visits kiye",
    });
    expect(m?.mediaId).toBeUndefined();
    expect(m?.reply).toBeUndefined();
  });

  it("parses a voice message to mediaId + mediaType=voice", () => {
    const m = parseMessage({
      id: "v1",
      chat_id: "9199@s.whatsapp.net",
      type: "voice",
      voice: { id: "media-voice-1" },
    });
    expect(m?.mediaId).toBe("media-voice-1");
    expect(m?.mediaType).toBe("voice");
    expect(m?.text).toBeUndefined();
  });

  it("parses an audio message to mediaId + mediaType=audio", () => {
    const m = parseMessage({
      id: "a1",
      chat_id: "9199@s.whatsapp.net",
      type: "audio",
      audio: { id: "media-audio-1" },
    });
    expect(m?.mediaId).toBe("media-audio-1");
    expect(m?.mediaType).toBe("audio");
  });

  it("parses a buttons_reply into reply {id,title}", () => {
    const m = parseMessage({
      id: "b1",
      chat_id: "9199@s.whatsapp.net",
      type: "reply",
      reply: { type: "buttons_reply", buttons_reply: { id: "mgr:none", title: "I'm the CEO" } },
    });
    expect(m?.reply).toEqual({ id: "mgr:none", title: "I'm the CEO" });
  });

  it("parses a list_reply into reply {id,title}", () => {
    const m = parseMessage({
      id: "l1",
      chat_id: "9199@s.whatsapp.net",
      type: "reply",
      reply: { type: "list_reply", list_reply: { id: "mgr_id:42", title: "Rohit Shah" } },
    });
    expect(m?.reply).toEqual({ id: "mgr_id:42", title: "Rohit Shah" });
  });

  it("strips the ListV3: prefix Whapi adds to list_reply ids (picker-loop regression)", () => {
    // Whapi returns our row id wrapped as `ListV3:mgr_id:42`; the router matches
    // on the bare id, so parseMessage must normalize it back.
    const m = parseMessage({
      id: "l2",
      chat_id: "9199@s.whatsapp.net",
      type: "reply",
      reply: { type: "list_reply", list_reply: { id: "ListV3:mgr_id:42", title: "Rohit Shah" } },
    });
    expect(m?.reply).toEqual({ id: "mgr_id:42", title: "Rohit Shah" });
  });

  it("strips the ListV3: prefix from mgr:none / nav:more ids too", () => {
    const none = parseMessage({
      id: "l3",
      chat_id: "9199@s.whatsapp.net",
      type: "reply",
      reply: { type: "list_reply", list_reply: { id: "ListV3:mgr:none", title: "top" } },
    });
    expect(none?.reply?.id).toBe("mgr:none");
  });

  it("falls back to `from` for wa_id when chat_id is missing", () => {
    const m = parseMessage({
      id: "m2",
      from: "919222222222@s.whatsapp.net",
      type: "text",
      text: { body: "hi" },
    });
    expect(m?.chat_id).toBeNull();
    expect(m?.wa_id).toBe("919222222222@s.whatsapp.net");
  });

  it("marks group chats (@g.us) as is_group", () => {
    const m = parseMessage({
      id: "g1",
      chat_id: "120363000000000000@g.us",
      type: "text",
      text: { body: "group message" },
    });
    expect(m?.is_group).toBe(true);
    expect(m?.wa_id).toBe("120363000000000000@g.us");
  });

  it("returns null for a message without an id", () => {
    expect(parseMessage({ id: "", chat_id: "x@s.whatsapp.net" } as never)).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it("captures from_me flag", () => {
    const m = parseMessage({
      id: "m3",
      chat_id: "9199@s.whatsapp.net",
      from_me: true,
      type: "text",
      text: { body: "sent by bot" },
    });
    expect(m?.from_me).toBe(true);
  });
});

describe("parseWebhook", () => {
  it("parses all messages in a batch preserving order", () => {
    const msgs = parseWebhook({
      messages: [
        { id: "a", chat_id: "1@s.whatsapp.net", type: "text", text: { body: "first" } },
        { id: "b", chat_id: "1@s.whatsapp.net", type: "text", text: { body: "second" } },
      ],
    });
    expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns [] for a body without messages", () => {
    expect(parseWebhook({})).toEqual([]);
    expect(parseWebhook(undefined)).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });

  it("includes group messages flagged so callers can skip them", () => {
    const msgs = parseWebhook({
      messages: [{ id: "g", chat_id: "120@g.us", type: "text", text: { body: "x" } }],
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].is_group).toBe(true);
  });
});
