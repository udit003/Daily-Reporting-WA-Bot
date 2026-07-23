/**
 * Whapi HTTP client. All network access to the Whapi gate lives here so the
 * domain layer can mock a single module. Uses the global `fetch` (Node >=18).
 *
 * Base URL comes from config (`WHAPI_BASE_URL`); every request carries
 * `Authorization: Bearer <WHAPI_TOKEN>`. Send methods throw on non-2xx with a
 * message including the HTTP status + response body text.
 */

import { loadConfig } from "../config";
import type {
  OutgoingButton,
  OutgoingInteractiveButtonPayload,
  OutgoingInteractiveListPayload,
  OutgoingListRow,
  OutgoingListSection,
  OutgoingTextPayload,
  OutgoingVoicePayload,
} from "./types";

/** Max data rows WhatsApp allows before we must paginate with a nav row. */
export const LIST_PAGE_SIZE = 9;
/** WhatsApp interactive buttons cap. */
export const MAX_BUTTONS = 3;

export interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

export interface WhapiClientOptions {
  baseUrl?: string;
  token?: string;
  maxMediaBytes?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class WhapiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxMediaBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WhapiClientOptions = {}) {
    const cfg = loadConfig();
    this.baseUrl = (opts.baseUrl ?? cfg.WHAPI_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token ?? cfg.WHAPI_TOKEN;
    this.maxMediaBytes = opts.maxMediaBytes ?? cfg.MAX_MEDIA_BYTES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(extra ?? {}),
    };
  }

  /** POST a JSON body; throw on non-2xx including status + body text. */
  private async postJson(path: string, payload: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Whapi POST ${path} failed: ${res.status} ${res.statusText} ${text}`);
    }
    return safeJson(res);
  }

  /** `POST /messages/text`. */
  async sendText(to: string, body: string): Promise<unknown> {
    const payload: OutgoingTextPayload = { to, body };
    return this.postJson("/messages/text", payload);
  }

  /**
   * `POST /messages/interactive` `type:"button"`. Throws if more than 3
   * buttons are supplied (WhatsApp hard limit).
   */
  async sendButtons(
    to: string,
    body: string,
    buttons: { id: string; title: string }[],
  ): Promise<unknown> {
    if (buttons.length > MAX_BUTTONS) {
      throw new Error(
        `sendButtons: at most ${MAX_BUTTONS} buttons allowed, got ${buttons.length}`,
      );
    }
    const action: OutgoingButton[] = buttons.map((b) => ({
      type: "quick_reply",
      id: b.id,
      title: b.title,
    }));
    const payload: OutgoingInteractiveButtonPayload = {
      to,
      type: "button",
      body: { text: body },
      action: { buttons: action },
    };
    return this.postJson("/messages/interactive", payload);
  }

  /**
   * `POST /messages/interactive` `type:"list"`, paginated. Shows at most
   * {@link LIST_PAGE_SIZE} data rows for this page; appends a
   * `nav:more:<nextOffset>` row when more items exist (`total > offset + 9`).
   * `rows` is expected to already be the full ordered set; this method slices
   * the page starting at `offset`.
   */
  async sendListPage(
    to: string,
    body: string,
    buttonText: string,
    rows: OutgoingListRow[],
    offset: number,
    total: number,
  ): Promise<unknown> {
    const start = Math.max(0, offset);
    const pageRows = rows.slice(start, start + LIST_PAGE_SIZE);
    const dataRows: OutgoingListRow[] = pageRows.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
    }));

    const nextOffset = start + LIST_PAGE_SIZE;
    if (total > nextOffset) {
      dataRows.push({ id: `nav:more:${nextOffset}`, title: "More…" });
    }

    const section: OutgoingListSection = { rows: dataRows };
    const payload: OutgoingInteractiveListPayload = {
      to,
      type: "list",
      body: { text: body },
      action: { list: { label: buttonText, sections: [section] } },
    };
    return this.postJson("/messages/interactive", payload);
  }

  /**
   * `GET /media/{id}` — the single media path (no webhook link fallback).
   * Returns the binary body as a Buffer + the response content-type. Throws on
   * non-2xx and when the payload exceeds `MAX_MEDIA_BYTES`.
   */
  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const res = await this.fetchImpl(this.url(`/media/${encodeURIComponent(mediaId)}`), {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(
        `Whapi GET /media/${mediaId} failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > this.maxMediaBytes) {
      throw new Error(
        `Whapi media ${mediaId} too large: ${buffer.length} bytes > MAX_MEDIA_BYTES ${this.maxMediaBytes}`,
      );
    }
    return { buffer, contentType };
  }

  /** `POST /messages/voice` — optional convenience for sending audio replies. */
  async sendVoice(to: string, oggBase64: string): Promise<unknown> {
    const payload: OutgoingVoicePayload = { to, media: oggBase64 };
    return this.postJson("/messages/voice", payload);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
