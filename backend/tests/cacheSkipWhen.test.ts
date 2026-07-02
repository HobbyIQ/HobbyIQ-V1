// CF-CH-SEARCH-NO-CACHE-EMPTY (2026-07-01) — pin the skipCacheWhen contract.
//
// Motivating case: CardHedge's `/cards/card-search` occasionally returns []
// on transient upstream conditions (rate-limit backpressure, deploy warmup
// blips). The prior 6-hour SEARCH_TTL_SEC would then hold that empty
// response for the full window — turning a transient blip into a persistent
// picker failure (Pete Alonso Auto / Bo Bichette Auto reproducibly stuck at
// 0 candidates post-deploy of PR #241, while identical direct CH probes
// returned 50 every time).
//
// Fix: cacheWrap accepts an optional `skipCacheWhen` predicate. When the
// predicate returns true for a freshly-fetched result, the result is
// returned to the caller as normal but NOT persisted. Next call retries
// the underlying fn — the transient blip self-heals.
//
// THIS FILE PINS:
//   1. predicate returns true → next call re-invokes fn (no cache write)
//   2. predicate returns false → normal cache write, next call is a hit
//   3. predicate absent (legacy call shape) → normal cache write
//   4. First call always invokes fn — skipCacheWhen never reads a cache

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  cacheWrap,
  __resetMemoryCacheForTest,
  __cacheServiceInternals,
} from "../src/services/shared/cache.service.js";

beforeEach(() => {
  delete process.env.REDIS_HOST;
  __resetMemoryCacheForTest();
  __cacheServiceInternals.resetPrefixCounters();
  __cacheServiceInternals.stopEmitTimer();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __cacheServiceInternals.stopEmitTimer();
});

describe("cacheWrap — skipCacheWhen", () => {
  it("predicate returns true → result NOT cached, next call re-invokes fn", async () => {
    const key = "test:skip:empty";
    let calls = 0;
    const fn = async () => {
      calls++;
      return [] as number[];
    };

    const first = await cacheWrap<number[]>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(first).toEqual([]);
    expect(calls).toBe(1);

    // Second call: predicate suppressed the write, so fn runs again.
    const second = await cacheWrap<number[]>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(second).toEqual([]);
    expect(calls).toBe(2);
  });

  it("predicate returns false → result IS cached, next call is a hit", async () => {
    const key = "test:skip:non-empty";
    let calls = 0;
    const fn = async () => {
      calls++;
      return [{ card_id: "abc" }];
    };

    const first = await cacheWrap<Array<{ card_id: string }>>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(first).toEqual([{ card_id: "abc" }]);
    expect(calls).toBe(1);

    const second = await cacheWrap<Array<{ card_id: string }>>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(second).toEqual([{ card_id: "abc" }]);
    expect(calls).toBe(1); // no re-invoke — cache hit
  });

  it("skipCacheWhen absent → legacy caching behavior (empty results DO cache)", async () => {
    const key = "test:legacy:empty";
    let calls = 0;
    const fn = async () => {
      calls++;
      return [] as number[];
    };

    // No skipCacheWhen — legacy behavior: empty result IS cached.
    await cacheWrap<number[]>(key, fn, { freshTtlSeconds: 3600 });
    await cacheWrap<number[]>(key, fn, { freshTtlSeconds: 3600 });
    expect(calls).toBe(1); // cache hit on second call
  });

  it("bare-number ttl form (no opts) → skipCacheWhen unavailable → empty caches (backward compat)", async () => {
    const key = "test:legacy:bare-ttl";
    let calls = 0;
    const fn = async () => {
      calls++;
      return [] as number[];
    };
    await cacheWrap<number[]>(key, fn, 3600);
    await cacheWrap<number[]>(key, fn, 3600);
    expect(calls).toBe(1); // legacy single-number form still caches empties
  });

  it("mixed results across calls: first empty (skipped) → second non-empty (cached) → third is hit", async () => {
    const key = "test:skip:mixed";
    let call = 0;
    const fn = async () => {
      call++;
      // First call: transient empty. Later calls: real data.
      return call === 1 ? [] : [{ card_id: "recovered" }];
    };

    const first = await cacheWrap<Array<{ card_id: string }>>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(first).toEqual([]);

    const second = await cacheWrap<Array<{ card_id: string }>>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(second).toEqual([{ card_id: "recovered" }]);

    // Third call → cache hit on the recovered value; fn NOT invoked.
    const third = await cacheWrap<Array<{ card_id: string }>>(key, fn, {
      freshTtlSeconds: 3600,
      skipCacheWhen: (r) => r.length === 0,
    });
    expect(third).toEqual([{ card_id: "recovered" }]);
    expect(call).toBe(2); // only 2 fn invocations across 3 calls
  });
});
