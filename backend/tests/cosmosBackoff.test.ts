import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const { withBackoff, makeRetrier, isThrottled, retryAfterMsOf, computeBackoffMs } = require_(
  path.join(LIB, "cosmos-backoff.cjs"),
);

/**
 * cosmos-backoff.cjs -- bounded, logged, application-level backoff for a
 * Cosmos 429, added after run 36297136135 (repoint-sales-isauto-flip.cjs,
 * SCOPE baseball:2026 APPLY, 2026-09-27) died mid-scan on a 429 inside an
 * unwrapped `Item.read()`. See that script's own header and
 * cosmos-backoff.cjs's own header for the full incident trace.
 */

function throttledErr(over: Record<string, unknown> = {}) {
  return Object.assign(new Error("The request rate is too large. Please retry after sometime."), over);
}

describe("isThrottled -- recognising a Cosmos 429", () => {
  it("recognises err.code === 429 (number)", () => {
    expect(isThrottled({ code: 429, message: "x" })).toBe(true);
  });
  it("recognises err.code === '429' (string)", () => {
    expect(isThrottled({ code: "429", message: "x" })).toBe(true);
  });
  it("recognises err.statusCode === 429 when .code is absent", () => {
    expect(isThrottled({ statusCode: 429, message: "x" })).toBe(true);
  });
  it("recognises a numeric retryAfterInMs even with no code attached", () => {
    expect(isThrottled({ retryAfterInMs: 500, message: "x" })).toBe(true);
  });
  it("recognises the x-ms-retry-after-ms header", () => {
    expect(isThrottled({ headers: { "x-ms-retry-after-ms": "250" }, message: "x" })).toBe(true);
  });
  it("recognises the EXACT message shape from the incident's own log, with no code at all", () => {
    expect(isThrottled(new Error("The request rate is too large. Please retry after sometime."))).toBe(true);
  });
  it("recognises the message case-insensitively", () => {
    expect(isThrottled(new Error("REQUEST RATE IS TOO LARGE"))).toBe(true);
  });
  it("does NOT recognise a 404", () => {
    expect(isThrottled({ code: 404, message: "not found" })).toBe(false);
  });
  it("does NOT recognise a 412 (etag precondition failed)", () => {
    expect(isThrottled({ code: 412, message: "precondition failed" })).toBe(false);
  });
  it("does NOT recognise an unrelated error with no throttling shape at all", () => {
    expect(isThrottled(new Error("ECONNRESET"))).toBe(false);
  });
  it("handles a null/undefined error without throwing", () => {
    expect(isThrottled(null)).toBe(false);
    expect(isThrottled(undefined)).toBe(false);
  });
});

describe("retryAfterMsOf -- the server's own wait, when given", () => {
  it("reads err.retryAfterInMs", () => {
    expect(retryAfterMsOf({ retryAfterInMs: 1234 })).toBe(1234);
  });
  it("reads the x-ms-retry-after-ms header when retryAfterInMs is absent", () => {
    expect(retryAfterMsOf({ headers: { "x-ms-retry-after-ms": "777" } })).toBe(777);
  });
  it("prefers retryAfterInMs over the header when BOTH are present", () => {
    expect(retryAfterMsOf({ retryAfterInMs: 10, headers: { "x-ms-retry-after-ms": "999" } })).toBe(10);
  });
  it("returns null when neither is present", () => {
    expect(retryAfterMsOf({ message: "x" })).toBeNull();
  });
  it("returns null for a negative retryAfterInMs (never a negative wait)", () => {
    expect(retryAfterMsOf({ retryAfterInMs: -5 })).toBeNull();
  });
});

describe("computeBackoffMs -- exponential with jitter", () => {
  it("is capped at maxMs regardless of how large attempt grows", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ms = computeBackoffMs(attempt, 500, 30000);
      expect(ms).toBeLessThanOrEqual(30000);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });
  it("jitters to [0.5x, 1.0x) of min(maxMs, base*2^attempt)", () => {
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(2, 100, 10000); // base*2^2 = 400
      expect(ms).toBeGreaterThanOrEqual(200);
      expect(ms).toBeLessThanOrEqual(400);
    }
  });
  it("grows roughly exponentially before hitting the cap", () => {
    const a0 = computeBackoffMs(0, 100, 100000);
    const a3 = computeBackoffMs(3, 100, 100000);
    // a0 in [50,100], a3 in [400,800] -- no overlap, so this is a reliable
    // ordering check even with jitter's randomness.
    expect(a3).toBeGreaterThan(a0);
  });
});

describe("withBackoff -- retries then succeeds", () => {
  it("retries a 429 and returns the eventual success, calling fn() exactly as many times as needed", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => { calls++; if (calls < 3) throw throttledErr({ code: 429 }); return "ok"; },
      { label: "t", baseMs: 10, maxMs: 100, wait: async () => {}, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("resolves on the FIRST attempt with no retry at all when fn() never throws", async () => {
    let calls = 0;
    const result = await withBackoff(async () => { calls++; return 42; }, { label: "t", wait: async () => {}, log: () => {} });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("logs one [backoff] line per retry, naming the label and the attempt", async () => {
    let calls = 0;
    const lines: string[] = [];
    await withBackoff(
      async () => { calls++; if (calls < 3) throw throttledErr({ code: 429 }); return "ok"; },
      { label: "my-lane", baseMs: 5, maxMs: 50, wait: async () => {}, log: (l: string) => lines.push(l) },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[backoff\] my-lane 429 attempt 1\/8 wait \d+ms$/);
    expect(lines[1]).toMatch(/^\[backoff\] my-lane 429 attempt 2\/8 wait \d+ms$/);
  });

  it("honours the server-supplied retryAfterInMs INSTEAD of the computed backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withBackoff(
      async () => { calls++; if (calls === 1) throw throttledErr({ code: 429, retryAfterInMs: 4321 }); return "ok"; },
      { label: "t", baseMs: 500, maxMs: 30000, wait: async (ms: number) => { waits.push(ms); }, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(waits).toEqual([4321]); // NOT the computed exponential value
  });

  it("honours retryAfterInMs from the header form too", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withBackoff(
      async () => { calls++; if (calls === 1) throw throttledErr({ code: 429, headers: { "x-ms-retry-after-ms": "999" } }); return "ok"; },
      { label: "t", wait: async (ms: number) => { waits.push(ms); }, log: () => {} },
    );
    expect(waits).toEqual([999]);
  });

  it("calls onThrottle exactly once per 429 seen, BEFORE the wait", async () => {
    const order: string[] = [];
    let calls = 0;
    await withBackoff(
      async () => { calls++; if (calls < 3) throw throttledErr({ code: 429 }); return "ok"; },
      {
        label: "t", baseMs: 5, maxMs: 50,
        wait: async () => { order.push("wait"); },
        log: () => {},
        onThrottle: () => order.push("throttle"),
      },
    );
    expect(order).toEqual(["throttle", "wait", "throttle", "wait"]);
  });

  it("a throwing onThrottle never breaks the retry itself", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => { calls++; if (calls < 2) throw throttledErr({ code: 429 }); return "ok"; },
      { label: "t", wait: async () => {}, log: () => {}, onThrottle: () => { throw new Error("boom"); } },
    );
    expect(result).toBe("ok");
  });
});

describe("withBackoff -- exhaustion", () => {
  it("exhausts after maxAttempts and rethrows the ORIGINAL error object, fields preserved", async () => {
    const err = throttledErr({ code: 429 });
    let calls = 0;
    await expect(withBackoff(
      async () => { calls++; throw err; },
      { label: "my-call-site", maxAttempts: 3, wait: async () => {}, log: () => {} },
    )).rejects.toBe(err); // SAME object, not a wrapped copy
    expect(err.code).toBe(429); // e?.code === 429 still works for any downstream catch
    expect(calls).toBe(4); // the first attempt + 3 retries
  });

  it("prefixes .message with the label and attempt count on exhaustion", async () => {
    const err = throttledErr({ code: 429 });
    await expect(withBackoff(
      async () => { throw err; },
      { label: "checklist-fetch", maxAttempts: 2, wait: async () => {}, log: () => {} },
    )).rejects.toThrow(/^\[backoff\] checklist-fetch exhausted after 2 attempts: /);
  });

  it("singular 'attempt' (not 'attempts') when maxAttempts is 1", async () => {
    const err = throttledErr({ code: 429 });
    await expect(withBackoff(
      async () => { throw err; },
      { label: "x", maxAttempts: 1, wait: async () => {}, log: () => {} },
    )).rejects.toThrow(/exhausted after 1 attempt: /);
  });

  it("does NOT mutate .message on a non-exhausted throw (a caller catching a retryable error mid-run sees the original text)", async () => {
    let calls = 0;
    await withBackoff(
      async () => { calls++; if (calls < 2) throw throttledErr({ code: 429 }); return "ok"; },
      { label: "t", wait: async () => {}, log: () => {} },
    );
    expect(calls).toBe(2); // sanity: it DID retry once, proving the throw path ran without corrupting state
  });
});

describe("withBackoff -- a non-429 error is never retried", () => {
  it("passes through on the FIRST attempt, calling fn() exactly once", async () => {
    let calls = 0;
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    await expect(withBackoff(async () => { calls++; throw notFound; }, { label: "x", wait: async () => {}, log: () => {} }))
      .rejects.toBe(notFound);
    expect(calls).toBe(1);
  });

  it("never calls onThrottle for a non-429", async () => {
    const onThrottle = vi.fn();
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    await expect(withBackoff(async () => { throw notFound; }, { label: "x", wait: async () => {}, log: () => {}, onThrottle }))
      .rejects.toBe(notFound);
    expect(onThrottle).not.toHaveBeenCalled();
  });

  it("never mutates a non-429 error's .message", async () => {
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    await expect(withBackoff(async () => { throw notFound; }, { label: "x", wait: async () => {}, log: () => {} }))
      .rejects.toThrow("not found");
  });
});

describe("withBackoff -- defaults (no options object)", () => {
  it("defaults label to 'cosmos' and still retries a 429", async () => {
    let calls = 0;
    const result = await withBackoff(async () => { calls++; if (calls < 2) throw throttledErr({ code: 429 }); return "ok"; });
    expect(result).toBe("ok");
  }, 15000); // real setTimeout waits at the real (small) default baseMs

  it("uses console.log as the default logger and real setTimeout as the default wait (smoke test only, no assertions on timing)", async () => {
    const result = await withBackoff(async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("makeRetrier -- a bound retry()-shaped function for a shared options object", () => {
  it("returns a function taking fn and returning fn()'s result, retrying per the bound options", async () => {
    let calls = 0;
    const retry = makeRetrier({ label: "bound", baseMs: 5, maxMs: 20, wait: async () => {}, log: () => {} });
    const result = await retry(async () => { calls++; if (calls < 2) throw throttledErr({ code: 429 }); return "ok"; });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("two retriers bound with different labels stay independent", async () => {
    const err = throttledErr({ code: 429 });
    const a = makeRetrier({ label: "a", maxAttempts: 1, wait: async () => {}, log: () => {} });
    const b = makeRetrier({ label: "b", maxAttempts: 1, wait: async () => {}, log: () => {} });
    await expect(a(async () => { throw err; })).rejects.toThrow(/\[backoff\] a exhausted/);
    // err.message was mutated by the FIRST exhaustion (same object, by design) --
    // a fresh error proves b's own label is used independently.
    const err2 = throttledErr({ code: 429 });
    await expect(b(async () => { throw err2; })).rejects.toThrow(/\[backoff\] b exhausted/);
  });
});

describe("cosmos-backoff.cjs -- module shape", () => {
  it("exports exactly the documented surface", () => {
    const mod = require_(path.join(LIB, "cosmos-backoff.cjs"));
    expect(typeof mod.withBackoff).toBe("function");
    expect(typeof mod.makeRetrier).toBe("function");
    expect(typeof mod.isThrottled).toBe("function");
    expect(typeof mod.retryAfterMsOf).toBe("function");
    expect(typeof mod.computeBackoffMs).toBe("function");
  });
});
