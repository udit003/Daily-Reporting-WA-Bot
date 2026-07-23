import { describe, it, expect, beforeAll } from "vitest";

/**
 * Composition-root wiring smoke test.
 *
 * Importing `src/index.ts` must have NO side effects (no server listen, no cron,
 * no network), and `buildApp()` must construct the full object graph without
 * touching the network or DB (the pool connects lazily; the cron only starts in
 * `app.start()`). We do NOT call `app.start()` here — that would bind a port and
 * start the minute cron.
 */

beforeAll(() => {
  // Minimal env so loadConfig() succeeds inside buildApp().
  process.env.WHAPI_TOKEN ??= "test-whapi-token";
  process.env.OPENAI_API_KEY ??= "test-openai-key";
  process.env.DATABASE_URL ??= "postgres://localhost/test";
  process.env.WEBHOOK_SECRET ??= "test-secret";
});

describe("composition root (src/index.ts)", () => {
  it("imports without side effects and buildApp() wires the graph", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.buildApp).toBe("function");

    const app = mod.buildApp();
    expect(typeof app.start).toBe("function");
    expect(typeof app.stop).toBe("function");
  });
});
