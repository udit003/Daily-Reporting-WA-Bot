import { describe, it, expect, beforeAll, vi } from "vitest";
import { WhapiClient } from "../src/whapi/client";
import {
  filenameForContentType,
  isSupportedAudioContentType,
  transcribe,
} from "../src/openai/transcribe";

// Ensure config can load without real secrets in this unit test.
beforeAll(() => {
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

/** Build a fake fetch returning a binary media response. */
function fakeMediaFetch(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  bytes?: Buffer;
  body?: string;
}): typeof fetch {
  return vi.fn(async () => {
    const headers = new Map<string, string>();
    if (opts.contentType !== null) {
      headers.set("content-type", opts.contentType ?? "audio/ogg");
    }
    return {
      ok: opts.ok,
      status: opts.status ?? (opts.ok ? 200 : 500),
      statusText: opts.statusText ?? (opts.ok ? "OK" : "Error"),
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () => {
        const b = opts.bytes ?? Buffer.from([]);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      text: async () => opts.body ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch, maxMediaBytes?: number): WhapiClient {
  return new WhapiClient({
    baseUrl: "https://gate.example.test",
    token: "tok",
    maxMediaBytes,
    fetchImpl,
  });
}

describe("downloadMedia", () => {
  it("returns {buffer, contentType} on a 200 binary response", async () => {
    const payload = Buffer.from("fake-ogg-bytes");
    const client = makeClient(
      fakeMediaFetch({ ok: true, contentType: "audio/ogg; codecs=opus", bytes: payload }),
    );
    const res = await client.downloadMedia("media123");
    expect(Buffer.isBuffer(res.buffer)).toBe(true);
    expect(res.buffer.equals(payload)).toBe(true);
    expect(res.contentType).toBe("audio/ogg; codecs=opus");
  });

  it("hits GET /media/{id} with an Authorization bearer header", async () => {
    const spy = fakeMediaFetch({ ok: true, contentType: "audio/ogg", bytes: Buffer.from("x") });
    const client = makeClient(spy);
    await client.downloadMedia("abc");
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://gate.example.test/media/abc");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("throws on a non-2xx response (including status + body)", async () => {
    const client = makeClient(
      fakeMediaFetch({ ok: false, status: 404, statusText: "Not Found", body: "missing" }),
    );
    await expect(client.downloadMedia("nope")).rejects.toThrow(/404/);
  });

  it("throws when body exceeds MAX_MEDIA_BYTES", async () => {
    const big = Buffer.alloc(50);
    const client = makeClient(
      fakeMediaFetch({ ok: true, contentType: "audio/ogg", bytes: big }),
      10, // maxMediaBytes = 10
    );
    await expect(client.downloadMedia("big")).rejects.toThrow(/too large/i);
  });

  it("defaults content-type when header is absent", async () => {
    const client = makeClient(
      fakeMediaFetch({ ok: true, contentType: null, bytes: Buffer.from("x") }),
    );
    const res = await client.downloadMedia("noct");
    expect(res.contentType).toBe("application/octet-stream");
  });
});

describe("filename extension derivation", () => {
  it("maps known content-types to the right extension", () => {
    expect(filenameForContentType("audio/ogg")).toBe("audio.ogg");
    expect(filenameForContentType("audio/ogg; codecs=opus")).toBe("audio.ogg");
    expect(filenameForContentType("audio/mpeg")).toBe("audio.mp3");
    expect(filenameForContentType("audio/mp4")).toBe("audio.m4a");
    expect(filenameForContentType("audio/wav")).toBe("audio.wav");
  });
  it("defaults unknown content-types to .ogg", () => {
    expect(filenameForContentType("audio/weird")).toBe("audio.ogg");
  });
  it("isSupportedAudioContentType rejects non-audio types", () => {
    expect(isSupportedAudioContentType("audio/ogg")).toBe(true);
    expect(isSupportedAudioContentType("image/png")).toBe(false);
    expect(isSupportedAudioContentType("application/pdf")).toBe(false);
  });
});

describe("transcribe unsupported content-type", () => {
  it("rejects before calling OpenAI", async () => {
    const create = vi.fn();
    const fakeClient = { audio: { transcriptions: { create } } } as unknown as import("openai").default;
    await expect(
      transcribe({ buffer: Buffer.from("x"), contentType: "application/pdf" }, fakeClient),
    ).rejects.toThrow(/unsupported/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("calls whisper-1 with verbose_json for a supported type and returns {text, language}", async () => {
    const create = vi.fn(async () => ({ text: "namaste kaise ho", language: "hindi" }));
    const fakeClient = { audio: { transcriptions: { create } } } as unknown as import("openai").default;
    const res = await transcribe(
      { buffer: Buffer.from("audio-bytes"), contentType: "audio/ogg" },
      fakeClient,
    );
    expect(res).toEqual({ text: "namaste kaise ho", language: "hindi" });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe("whisper-1");
    expect(arg.response_format).toBe("verbose_json");
    expect(arg.language).toBeUndefined();
  });
});
