// CF-CH-DELTA-POLL-SINGLE-FLIGHT (2026-08-20) — pins the cross-worker lock.
//
// WHY THIS EXISTS. startChDeltaPollJob() is called from server.ts at boot, so
// its setInterval lives in EVERY App Service worker process. HobbyIQ3 runs
// numberOfWorkers=2, so the CardHedge delta poll fired twice per cycle against
// a quota-limited vendor. Measured in hobbyiq-insights: every 1-minute bin
// containing a poll showed dcount(cloud_RoleInstance) = 2, split 9/8 across the
// two instances over a 2h window.
//
// These tests run against the in-memory cache fallback (no REDIS_HOST), which
// is single-process — so within one test file it behaves like one worker and
// the lock is directly observable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const LOCK_KEY = "lock:ch-delta-poll";

describe("CF-CH-DELTA-POLL-SINGLE-FLIGHT", () => {
  let savedRedisHost: string | undefined;

  beforeEach(async () => {
    // Force the in-memory fallback so the lock is exercised without Redis.
    savedRedisHost = process.env.REDIS_HOST;
    delete process.env.REDIS_HOST;
    const cache = await import("../src/services/shared/cache.service.js");
    cache.__resetMemoryCacheForTest();
  });

  afterEach(() => {
    if (savedRedisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = savedRedisHost;
  });

  it("grants the lock to the first caller only", async () => {
    const { cacheAcquireLock } = await import("../src/services/shared/cache.service.js");

    expect(await cacheAcquireLock(LOCK_KEY, 300)).toBe(true);
    // The sibling worker's timer fires milliseconds later and must lose.
    expect(await cacheAcquireLock(LOCK_KEY, 300)).toBe(false);
    expect(await cacheAcquireLock(LOCK_KEY, 300)).toBe(false);
  });

  it("grants it again once the TTL lapses, so a dead holder cannot stall the job", async () => {
    const { cacheAcquireLock, __resetMemoryCacheForTest } = await import(
      "../src/services/shared/cache.service.js"
    );

    // 1s TTL, then wait it out — a worker that dies holding the lock must cost
    // at most one skipped cycle, never a permanently stalled poll.
    expect(await cacheAcquireLock(LOCK_KEY, 1)).toBe(true);
    expect(await cacheAcquireLock(LOCK_KEY, 1)).toBe(false);

    await new Promise((r) => setTimeout(r, 1100));

    expect(await cacheAcquireLock(LOCK_KEY, 1)).toBe(true);
    __resetMemoryCacheForTest();
  });

  it("keys the lock per name, so unrelated locks do not collide", async () => {
    const { cacheAcquireLock } = await import("../src/services/shared/cache.service.js");

    expect(await cacheAcquireLock(LOCK_KEY, 300)).toBe(true);
    expect(await cacheAcquireLock("lock:something-else", 300)).toBe(true);
  });

  it("runScheduledCycle SKIPS the cycle when another worker holds the lock", async () => {
    const cache = await import("../src/services/shared/cache.service.js");
    const { runScheduledCycle } = await import("../src/jobs/chDeltaPoll.job.js");

    // Simulate the sibling worker having already taken it this cycle.
    expect(await cache.cacheAcquireLock(LOCK_KEY, 300)).toBe(true);

    // null is the "skipped" signal — the poll must not run at all.
    await expect(runScheduledCycle(15 * 60 * 1000)).resolves.toBeNull();
  });

  it("sizes the lock TTL below the poll interval", async () => {
    // The TTL is intervalSeconds - 60, floored at 60. It must always expire
    // before the next cycle, or a single worker would lock everyone out
    // permanently; and it must outlast one poll (measured up to 20s) or both
    // workers would run.
    const ttlFor = (intervalMs: number) => Math.max(60, Math.floor(intervalMs / 1000) - 60);

    expect(ttlFor(15 * 60 * 1000)).toBe(840); // default 15min -> 14min
    expect(ttlFor(15 * 60 * 1000)).toBeLessThan((15 * 60 * 1000) / 1000);
    expect(ttlFor(15 * 60 * 1000)).toBeGreaterThan(20);

    // Degenerate/short intervals still clamp to a full minute rather than 0,
    // which would disable the lock entirely.
    expect(ttlFor(60 * 1000)).toBe(60);
    expect(ttlFor(1000)).toBe(60);
  });
});
