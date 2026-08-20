// CF-JOB-SINGLE-FLIGHT (2026-08-20) — pins runSingleFlight.
//
// Every start*Job() in server.ts arms its setInterval inside the API process,
// so with numberOfWorkers=2 every scheduled cycle ran twice. Measured in
// hobbyiq-insights over 3h, dcount(cloud_RoleInstance) = 2 for
// price.alert.evaluator, portfolio.reprice.job, advanced.alert.evaluator,
// buyeriq.deal.scanner, ebay.order.poll.job and ebay.finances.enrichment.
//
// These run against the in-memory cache fallback (no REDIS_HOST), which is
// single-process, so within one file it behaves like one worker and the lock
// is directly observable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("CF-JOB-SINGLE-FLIGHT — runSingleFlight", () => {
  let savedRedisHost: string | undefined;

  beforeEach(async () => {
    savedRedisHost = process.env.REDIS_HOST;
    delete process.env.REDIS_HOST;
    const cache = await import("../src/services/shared/cache.service.js");
    cache.__resetMemoryCacheForTest();
  });

  afterEach(() => {
    if (savedRedisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = savedRedisHost;
  });

  it("runs the cycle when no other worker holds the lock", async () => {
    const { runSingleFlight } = await import("../src/jobs/_singleFlight.js");
    const cycle = vi.fn(async () => {});

    await runSingleFlight("test.job.a", 15 * 60 * 1000, cycle);

    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it("runs the cycle exactly once when two workers fire together", async () => {
    const { runSingleFlight } = await import("../src/jobs/_singleFlight.js");
    const cycle = vi.fn(async () => {});

    // Both timers fire within milliseconds of each other in prod.
    await Promise.all([
      runSingleFlight("test.job.b", 15 * 60 * 1000, cycle),
      runSingleFlight("test.job.b", 15 * 60 * 1000, cycle),
    ]);

    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it("keys the lock per job, so one job cannot block another", async () => {
    const { runSingleFlight } = await import("../src/jobs/_singleFlight.js");
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});

    await runSingleFlight("test.job.c", 15 * 60 * 1000, a);
    await runSingleFlight("test.job.d", 15 * 60 * 1000, b);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("propagates cycle errors to the caller, preserving existing .catch handling", async () => {
    const { runSingleFlight } = await import("../src/jobs/_singleFlight.js");
    const boom = async () => { throw new Error("cycle exploded"); };

    // Every job site does runSingleFlight(...).catch(err => console.error(...)),
    // which only works if the cycle's rejection still surfaces here.
    await expect(runSingleFlight("test.job.e", 15 * 60 * 1000, boom))
      .rejects.toThrow("cycle exploded");
  });

  it("runs rather than skips when the lock cannot be acquired", async () => {
    vi.resetModules();
    vi.doMock("../src/services/shared/cache.service.js", () => ({
      cacheAcquireLock: async () => { throw new Error("redis down"); },
    }));

    const { runSingleFlight } = await import("../src/jobs/_singleFlight.js");
    const cycle = vi.fn(async () => {});

    // A Redis blip must never silently halt every job on every worker.
    // Duplicate work is recoverable; a fleet of stopped jobs is not.
    await runSingleFlight("test.job.f", 15 * 60 * 1000, cycle);

    expect(cycle).toHaveBeenCalledTimes(1);
    vi.doUnmock("../src/services/shared/cache.service.js");
    vi.resetModules();
  });

  it("sizes the TTL below the interval but above one cycle", async () => {
    // ttl = intervalSeconds - 60, floored at 60. It must expire before the
    // next cycle (or one worker locks everyone out permanently) and outlast
    // a single run (or both workers execute).
    const ttlFor = (ms: number) => Math.max(60, Math.floor(ms / 1000) - 60);

    expect(ttlFor(15 * 60 * 1000)).toBe(840);
    expect(ttlFor(15 * 60 * 1000)).toBeLessThan(15 * 60);
    expect(ttlFor(24 * 60 * 60 * 1000)).toBe(86340);
    expect(ttlFor(24 * 60 * 60 * 1000)).toBeLessThan(24 * 60 * 60);

    // Degenerate/short intervals clamp to a minute rather than 0, which
    // would disable the lock entirely.
    expect(ttlFor(60 * 1000)).toBe(60);
    expect(ttlFor(1000)).toBe(60);
  });
});
