// CF-UNIFIED-SEARCH-AND-CERT W5-Windows — shared concurrency primitive tests.

import { describe, expect, it } from "vitest";
import {
  withConcurrency,
  withConcurrencyResult,
} from "../src/services/shared/concurrency.js";

describe("withConcurrency", () => {
  it("returns empty array on empty input without invoking fn", async () => {
    let invocations = 0;
    const out = await withConcurrency([], 8, async () => {
      invocations += 1;
      return 0;
    });
    expect(out).toEqual([]);
    expect(invocations).toBe(0);
  });

  it("preserves input ordering even when tasks complete out of order", async () => {
    const items = [100, 10, 50, 1, 200];
    const out = await withConcurrency(items, 8, async (ms, idx) => {
      await new Promise((r) => setTimeout(r, ms));
      return idx;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await withConcurrency(items, 4, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return null;
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("clamps limit upward (limit < 1 still runs at least one worker)", async () => {
    const out = await withConcurrency([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it("clamps limit downward (limit > items.length doesn't oversubscribe)", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3];
    await withConcurrency(items, 100, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return null;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("throws on individual task failure (use withConcurrencyResult for isolation)", async () => {
    await expect(
      withConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("withConcurrencyResult", () => {
  it("returns empty array on empty input", async () => {
    const out = await withConcurrencyResult<number, number>([], 8, async () => 0);
    expect(out).toEqual([]);
  });

  it("captures per-task errors without throwing", async () => {
    const out = await withConcurrencyResult([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n * 10;
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ ok: true, value: 10 });
    expect(out[1]).toEqual({ ok: false, error: new Error("nope") });
    expect(out[2]).toEqual({ ok: true, value: 30 });
  });

  it("preserves input ordering when both success and failure interleave", async () => {
    const out = await withConcurrencyResult([1, 2, 3, 4, 5], 3, async (n) => {
      if (n % 2 === 0) throw new Error(`even:${n}`);
      return n;
    });
    expect(out.map((r) => (r.ok ? r.value : `err:${(r.error as Error).message}`))).toEqual([
      1,
      "err:even:2",
      3,
      "err:even:4",
      5,
    ]);
  });

  it("all-failures returns all-error results without throwing", async () => {
    const out = await withConcurrencyResult([1, 2], 2, async () => {
      throw new Error("always");
    });
    expect(out.every((r) => !r.ok)).toBe(true);
  });
});
