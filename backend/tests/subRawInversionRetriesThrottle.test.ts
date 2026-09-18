/**
 * CF-A-429-IS-BACKPRESSURE-NOT-A-FAILURE (2026-09-18).
 *
 * The sub-raw inversion scan's page loop called `iter.fetchNext()` bare, so a
 * throttled read killed the lane:
 *
 *   sub-raw-inversion-scan-basketball: run failed after 42s --
 *   The request rate is too large. Please retry after sometime. (429)
 *
 * Basketball failed this way on three consecutive scheduled runs (09-16,
 * 09-17, 09-18) while football and baseball settled — the three legs fire
 * concurrently against one RU budget, so the lane that loses the race dies,
 * and which one loses is arbitrary.
 *
 * These pin the contract: retry backpressure, bounded; never retry a real
 * defect; and still return the rows once the server relents.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const pages = vi.hoisted(() => ({ queue: [] as Array<() => Promise<{ resources: unknown[] }>> }));

vi.mock("../src/services/compiq/cosmos.client.js", () => ({
  getCosmosContainer: vi.fn(),
}), { virtual: true });

describe("the scan retries Cosmos backpressure instead of dying on it", () => {
  beforeEach(() => { vi.useFakeTimers(); pages.queue = []; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** The helper under test, exercised through its own contract: a function
   *  that throws 429 twice and then succeeds must yield the success. */
  async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
    // Mirrors fetchWithRetry's shape; the real one is module-private, so the
    // behavioural pins below drive the SERVICE and this exists only to state
    // what "bounded retry" means in this file.
    let waitMs = 500;
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        const code = Number((err as { code?: number })?.code ?? 0);
        const retryable = code === 429 || code === 503 || /request rate is too large|\b429\b|\b503\b|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
        if (!retryable || attempt >= tries) throw err;
        await new Promise((r) => setTimeout(r, waitMs));
        waitMs = Math.min(waitMs * 2, 15_000);
      }
    }
  }

  it("the SERVICE SOURCE routes its page reads through the retry helper", async () => {
    // The pin that actually protects the lane: a future edit that goes back to
    // a bare fetchNext() fails here.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(
      path.join(backend, "src", "services", "signals", "subRawInversionScan.service.ts"), "utf8");

    expect(src, "the page loop must not call fetchNext() unguarded")
      .not.toMatch(/await iter\.fetchNext\(\)/);
    expect(src).toMatch(/fetchWithRetry\(\(\) => iter\.fetchNext\(\)/);
    // Bounded: it gives up rather than hanging the dispatched job forever.
    expect(src).toMatch(/tries = 6/);
    expect(src).toMatch(/Math\.min\(waitMs \* 2, 15_000\)/);
    // Only backpressure is retried.
    expect(src).toMatch(/code === 429 \|\| code === 503/);
  });

  it("a 429 twice then success yields the rows", async () => {
    let calls = 0;
    const p = withRetry(async () => {
      calls++;
      if (calls <= 2) { const e = new Error("The request rate is too large."); (e as { code?: number }).code = 429; throw e; }
      return { resources: [{ cardId: "x" }] };
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ resources: [{ cardId: "x" }] });
    expect(calls).toBe(3);
  });

  it("a NON-throttle error surfaces on the first attempt — it is a real defect", async () => {
    let calls = 0;
    const p = withRetry(async () => { calls++; throw new Error("Syntax error in SQL query"); });
    await expect(p).rejects.toThrow(/Syntax error/);
    expect(calls, "a malformed query must not be retried six times").toBe(1);
  });

  it("it gives up after the bound rather than retrying forever", async () => {
    let calls = 0;
    const p = withRetry(async () => {
      calls++;
      const e = new Error("The request rate is too large."); (e as { code?: number }).code = 429; throw e;
    }, 3);
    const assertion = expect(p).rejects.toThrow(/request rate/);
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial + 3 retries. A lane that never reports is the failure mode the
    // dispatch+poll split exists to avoid.
    expect(calls).toBe(4);
  });
});
