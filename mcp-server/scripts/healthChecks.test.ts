// Unit tests for checkUrlReachable + isUrlHealthy (CF-HEALTH-SIGNAL-URL-CHECK).
//
// Verifies the status-code classification that distinguishes the today's-bug
// case (404 URL_NOT_FOUND) from healthy paths and from other failure modes.
// Stubs global.fetch to simulate each response shape.
//
// Run: cd mcp-server && npx tsx --test scripts/healthChecks.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";

let checkUrlReachable: typeof import("../healthChecks.js").checkUrlReachable;
let isUrlHealthy: typeof import("../healthChecks.js").isUrlHealthy;

type Fetch = typeof globalThis.fetch;
const originalFetch: Fetch = globalThis.fetch;

interface StubConfig {
  status?: number;
  rejectWith?: Error;
  delayMs?: number;
}

function stubFetch(cfg: StubConfig): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (cfg.delayMs) {
      // Honor the AbortSignal if it's already aborted (or fires during delay).
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, cfg.delayMs);
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }
      });
    }
    if (cfg.rejectWith) throw cfg.rejectWith;
    return new Response("", { status: cfg.status ?? 200 });
  }) as Fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

before(async () => {
  process.env.TEST_HEALTH_URL = "https://example.invalid/api/test";
  process.env.TEST_HEALTH_KEY = "test-key-xyz";
  const mod = await import("../healthChecks.js");
  checkUrlReachable = mod.checkUrlReachable;
  isUrlHealthy = mod.isUrlHealthy;
});

after(() => {
  restoreFetch();
  delete process.env.TEST_HEALTH_URL;
  delete process.env.TEST_HEALTH_KEY;
});

describe("checkUrlReachable status classification", () => {
  beforeEach(() => {
    restoreFetch();
  });

  it("200 → URL_OK with status_code 200", async () => {
    stubFetch({ status: 200 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_OK");
    assert.equal(h.status_code, 200);
    assert.ok(typeof h.latency_ms === "number" && h.latency_ms >= 0);
  });

  it("400 → URL_OK (function exists, complaining about params — the no-side-effect probe target)", async () => {
    stubFetch({ status: 400 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_OK");
    assert.equal(h.status_code, 400);
  });

  it("401 → URL_AUTH_FAILED (key wrong)", async () => {
    stubFetch({ status: 401 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_AUTH_FAILED");
    assert.equal(h.status_code, 401);
  });

  it("404 → URL_NOT_FOUND (today's load-bearing bug case)", async () => {
    stubFetch({ status: 404 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_NOT_FOUND");
    assert.equal(h.status_code, 404);
  });

  it("403 → URL_AUTH_FAILED", async () => {
    stubFetch({ status: 403 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_AUTH_FAILED");
    assert.equal(h.status_code, 403);
  });

  it("500 → URL_SERVER_ERROR", async () => {
    stubFetch({ status: 500 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_SERVER_ERROR");
    assert.equal(h.status_code, 500);
  });

  it("503 → URL_SERVER_ERROR", async () => {
    stubFetch({ status: 503 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_SERVER_ERROR");
    assert.equal(h.status_code, 503);
  });

  it("418 (non-403 non-404 4xx) → URL_REACHABLE_BUT_BROKEN", async () => {
    stubFetch({ status: 418 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_REACHABLE_BUT_BROKEN");
    assert.equal(h.status_code, 418);
  });

  it("fetch rejects (network error) → URL_UNREACHABLE", async () => {
    stubFetch({ rejectWith: new Error("ECONNREFUSED") });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    assert.equal(h.status, "URL_UNREACHABLE");
    assert.ok(typeof h.error === "string" && h.error.includes("ECONNREFUSED"));
  });

  it("timeout (slow fetch beyond 100ms timeout) → URL_UNREACHABLE", async () => {
    stubFetch({ status: 200, delayMs: 500 });
    const h = await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY", 100);
    assert.equal(h.status, "URL_UNREACHABLE");
    assert.ok(typeof h.latency_ms === "number");
  });

  it("unset env var → URL_NOT_CONFIGURED (no fetch call)", async () => {
    // Stub fetch to throw so we'd notice if it WAS called
    stubFetch({ rejectWith: new Error("should not have been called") });
    const h = await checkUrlReachable("NONEXISTENT_HEALTH_URL");
    assert.equal(h.status, "URL_NOT_CONFIGURED");
    // No latency_ms / status_code / error for not-configured case
    assert.equal(h.status_code, undefined);
    assert.equal(h.latency_ms, undefined);
    assert.equal(h.error, undefined);
  });

  it("empty-string env var → URL_NOT_CONFIGURED", async () => {
    process.env.TEST_EMPTY_URL = "";
    stubFetch({ rejectWith: new Error("should not have been called") });
    const h = await checkUrlReachable("TEST_EMPTY_URL");
    assert.equal(h.status, "URL_NOT_CONFIGURED");
    delete process.env.TEST_EMPTY_URL;
  });

  it("whitespace-only env var → URL_NOT_CONFIGURED", async () => {
    process.env.TEST_WS_URL = "   ";
    stubFetch({ rejectWith: new Error("should not have been called") });
    const h = await checkUrlReachable("TEST_WS_URL");
    assert.equal(h.status, "URL_NOT_CONFIGURED");
    delete process.env.TEST_WS_URL;
  });

  it("URL probe appends ?code=<KEY> when keyEnvVar is provided", async () => {
    let observedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      observedUrl = typeof input === "string" ? input : input.toString();
      return new Response("", { status: 200 });
    }) as Fetch;
    await checkUrlReachable("TEST_HEALTH_URL", "TEST_HEALTH_KEY");
    const u = new URL(observedUrl);
    assert.equal(u.searchParams.get("code"), "test-key-xyz");
  });

  it("URL probe omits ?code= when keyEnvVar is not provided", async () => {
    let observedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      observedUrl = typeof input === "string" ? input : input.toString();
      return new Response("", { status: 200 });
    }) as Fetch;
    await checkUrlReachable("TEST_HEALTH_URL");
    const u = new URL(observedUrl);
    assert.equal(u.searchParams.has("code"), false);
  });
});

describe("isUrlHealthy", () => {
  it("URL_OK → true", () => {
    assert.equal(isUrlHealthy({ status: "URL_OK", status_code: 200 }), true);
  });
  it("URL_NOT_FOUND → false (today's bug case)", () => {
    assert.equal(isUrlHealthy({ status: "URL_NOT_FOUND", status_code: 404 }), false);
  });
  it("URL_AUTH_FAILED → false", () => {
    assert.equal(isUrlHealthy({ status: "URL_AUTH_FAILED", status_code: 401 }), false);
  });
  it("URL_UNREACHABLE → false", () => {
    assert.equal(isUrlHealthy({ status: "URL_UNREACHABLE", error: "ECONNREFUSED" }), false);
  });
  it("URL_NOT_CONFIGURED → false", () => {
    assert.equal(isUrlHealthy({ status: "URL_NOT_CONFIGURED" }), false);
  });
  it("URL_SERVER_ERROR → false", () => {
    assert.equal(isUrlHealthy({ status: "URL_SERVER_ERROR", status_code: 500 }), false);
  });
});
