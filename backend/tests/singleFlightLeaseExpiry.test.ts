// Pins for CF-JOB-SINGLE-FLIGHT's 2026-09-07 fix (#1967 follow-up).
//
// The defect: the lease TTL was sized to the job's INTERVAL, so a daily job
// took a 23-hour lock and buyeriq.deal.scanner a 59-minute one. HobbyIQ3
// recycles both workers every ~10 minutes, so a lease taken by a process that
// died two minutes later blocked every subsequent boot until the interval
// elapsed — measured as 7 re-arms and 3 scans in 45 minutes.
//
// These pins hold the two properties that fix depends on, on a fake clock:
//   1. a lease EXPIRES and is re-taken by the next process
//   2. a cycle that throws does not stop the next cycle from running

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A fake Redis-less cache: honours TTLs against vi's fake clock, which is
// exactly the surface runSingleFlight uses.
const store = new Map<string, { value: string; expiresAt: number }>();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheAcquireLock: async (key: string, ttlSeconds: number) => {
    const hit = store.get(key);
    if (hit && Date.now() <= hit.expiresAt) return false;
    store.set(key, { value: "1", expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  },
  cacheGet: async (key: string) => {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) { store.delete(key); return null; }
    return hit.value;
  },
  cacheSet: async (key: string, value: string, ttlSeconds: number) => {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
}));

const { runSingleFlight, leaseTtlSeconds, LOCK_TTL_CAP_SECONDS } = await import("../src/jobs/_singleFlight.js");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("single-flight lease sizing", () => {
  it("caps the lease so a crashed owner cannot wedge the job for the interval", () => {
    // The two real intervals that wedged: hourly (buyeriq) and daily (dailyiq).
    expect(leaseTtlSeconds(HOUR_MS)).toBe(LOCK_TTL_CAP_SECONDS);
    expect(leaseTtlSeconds(DAY_MS)).toBe(LOCK_TTL_CAP_SECONDS);
    // Pre-fix values, pinned as the thing we must never return to.
    expect(leaseTtlSeconds(HOUR_MS)).not.toBe(3540);
    expect(leaseTtlSeconds(DAY_MS)).not.toBe(86340);
  });

  it("never takes a lease longer than the interval itself, and never under 60s", () => {
    expect(leaseTtlSeconds(5 * 60 * 1000)).toBe(240);
    expect(leaseTtlSeconds(60 * 1000)).toBe(60);
    expect(leaseTtlSeconds(1000)).toBe(60);
  });
});

describe("single-flight behaviour on a fake clock", () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("a lease taken by a dead worker expires, and the next process runs the cycle", async () => {
    const runs: string[] = [];

    // Worker A wins the hour and is recycled mid-cycle: it never writes the
    // cadence marker, so only its lease is left behind.
    await runSingleFlight("buyeriq.deal.scanner", HOUR_MS, async () => {
      runs.push("A");
      throw new Error("worker recycled mid-cycle");
    }).catch(() => { /* the cycle's rejection is the caller's */ });
    expect(runs).toEqual(["A"]);

    // Simulate the crash: the completed-cycle marker A wrote is gone with it.
    store.delete("cadence:job:buyeriq.deal.scanner");

    // Two minutes later a fresh boot must NOT be able to run (lease still held)
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    await runSingleFlight("buyeriq.deal.scanner", HOUR_MS, async () => { runs.push("B-too-early"); });
    expect(runs).toEqual(["A"]);

    // ...but once the capped lease expires it must be reclaimable — long
    // before the 60-minute interval that used to gate it.
    vi.setSystemTime(Date.now() + (LOCK_TTL_CAP_SECONDS * 1000) + 1000);
    await runSingleFlight("buyeriq.deal.scanner", HOUR_MS, async () => { runs.push("C"); });
    expect(runs).toEqual(["A", "C"]);

    // The pre-fix lease would still have been held at this point.
    expect(Date.now()).toBeLessThan(new Date("2026-09-07T13:00:00Z").getTime());
  });

  it("an exception inside a cycle does not stop the next cycle from running", async () => {
    const runs: string[] = [];
    await runSingleFlight("job.under.test", HOUR_MS, async () => {
      runs.push("first");
      throw new Error("boom");
    }).catch(() => {});

    // Next interval: the scheduler is still live and the cycle runs again.
    vi.setSystemTime(Date.now() + HOUR_MS + 1000);
    await runSingleFlight("job.under.test", HOUR_MS, async () => { runs.push("second"); });
    expect(runs).toEqual(["first", "second"]);
  });

  it("a fast tick still runs exactly one cycle per interval", async () => {
    let n = 0;
    // 5-minute ticks across a full hour on an hourly job: the cadence marker,
    // not the tick, decides. 12 ticks, 1 cycle.
    for (let i = 0; i < 12; i++) {
      await runSingleFlight("fast.tick.job", HOUR_MS, async () => { n++; });
      vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    }
    expect(n).toBe(1);

    // Into the next hour, exactly one more.
    vi.setSystemTime(Date.now() + HOUR_MS);
    await runSingleFlight("fast.tick.job", HOUR_MS, async () => { n++; });
    expect(n).toBe(2);
  });

  it("a cycle that throws every time does not become a hot loop on a fast tick", async () => {
    let n = 0;
    for (let i = 0; i < 6; i++) {
      await runSingleFlight("always.fails", HOUR_MS, async () => {
        n++;
        throw new Error("still broken");
      }).catch(() => {});
      vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    }
    expect(n).toBe(1);
  });
});
