// CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (2026-09-27).
//
// nightly-cleanliness.yml's "Wait for anomaly-force-scan ... to settle" step
// used to poll `gh run list --workflow=backfill-runner.yml --limit 1` with no
// lane filter. backfill-runner.yml is a shared dispatcher with one static
// workflow name used by every lane, so "the newest run" is whichever lane
// fired most recently -- on 2026-09-26 that was an unrelated hourly lane
// (run-ebay-order-poll, run 36215231471 @ 03:36Z) that was already complete,
// which got read as "settled" while the real anomaly-force-scan chain was
// still mid-sweep. Runs 36213879571 / 36089169537 / 35950221396 all show the
// same race; last green was 35682083053 on 09-22.
//
// backend/scripts/wait-for-doc.cjs replaces that sample with a direct,
// bounded poll of the OUTCOME doc itself: anomaly-force-scan.cjs writes
// `<scanDate>::anomaly-scan-report` to anomaly_scan_reports only once the
// full sweep completes (a budget-stop mid-sweep writes a crawl_state cursor
// and deliberately no report), so the doc's existence is race-free by
// construction -- there is no lane identity to sample around.
//
// These pins exercise the core `waitForDoc(container, opts)` loop against a
// fake container (no real Cosmos, no real timers), covering: found on the
// first read, found after some 404s, and the bounded timeout naming the
// missing doc.
import { describe, it, expect, vi } from "vitest";
import { waitForDoc } from "../scripts/wait-for-doc.cjs";

function notFoundError() {
  const e: any = new Error("Entity with the specified id does not exist in the system.");
  e.code = 404;
  return e;
}

function fakeContainer(readImpl: () => Promise<{ resource: any }>) {
  return {
    item: (id: string, pk: string) => {
      expect(pk).toBe(id); // pk = id is the doc's whole contract
      return { read: readImpl };
    },
  };
}

describe("wait-for-doc: waitForDoc core loop", () => {
  it("returns 0 immediately when the doc is already present", async () => {
    const container = fakeContainer(async () => ({ resource: { id: "2026-09-26::anomaly-scan-report" } }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("keeps polling through 404s and returns 0 once the doc lands", async () => {
    let calls = 0;
    const container = fakeContainer(async () => {
      calls += 1;
      if (calls < 3) throw notFoundError();
      return { resource: { id: "doc" } };
    });
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "doc",
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
    expect(calls).toBe(3);
    // Two 404s before the hit -> slept twice, never sampling any run-list.
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("never treats a non-404 read error as absence — surfaces it as a hard failure (1)", async () => {
    const container = fakeContainer(async () => {
      throw new Error("ECONNRESET");
    });
    const errs: string[] = [];
    const code = await waitForDoc(container, {
      docId: "doc",
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: (s: string) => errs.push(s),
      sleepFn: vi.fn(async () => undefined),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("wait-for-doc read failed");
  });

  it("times out at the bound and names the missing doc + container (exit 2)", async () => {
    // Simulate wall-clock advancing by pollMs on every sleep, so the bound
    // check (real Date.now() inside waitForDoc) actually trips instead of
    // spinning thousands of times against a sleepFn that resolves instantly.
    const nowSpy = vi.spyOn(Date, "now");
    let simulatedNow = 1_000_000;
    nowSpy.mockImplementation(() => simulatedNow);

    const container = fakeContainer(async () => {
      throw notFoundError();
    });
    const errs: string[] = [];
    const pollMs = 5_000;
    const sleepFn = vi.fn(async () => {
      simulatedNow += pollMs;
    });
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      containerName: "anomaly_scan_reports",
      maxMs: 15_000,
      pollMs,
      log: () => {},
      err: (s: string) => errs.push(s),
      sleepFn,
    });
    nowSpy.mockRestore();
    expect(code).toBe(2);
    const msg = errs.join("\n");
    expect(msg).toContain("timed out waiting for 2026-09-26::anomaly-scan-report");
    expect(msg).toContain("anomaly_scan_reports");
    expect(msg).toContain("never finished settling");
    // maxMs=15s / pollMs=5s → bounded to a handful of attempts, never spins forever.
    expect(sleepFn.mock.calls.length).toBeLessThan(10);
  });

  it("requires a doc id and fails fast (1) rather than polling with an empty id", async () => {
    const container = fakeContainer(async () => ({ resource: null }));
    const errs: string[] = [];
    const code = await waitForDoc(container, {
      docId: "",
      err: (s: string) => errs.push(s),
      log: () => {},
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("WAIT_FOR_DOC_ID required");
  });

  // CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (review, 2026-09-27) — STALE-DOC
  // HAZARD. The report id is date-only (`<scanDate>::anomaly-scan-report`),
  // and nightly-cleanliness.yml keeps workflow_dispatch enabled, so a
  // same-day re-dispatch can find an EARLIER run's doc under the SAME id
  // before the new chain ever finishes. Existence alone is not "found" —
  // the doc's own `computedAt` (stamped by anomaly-force-scan.cjs at report-
  // build time) must be >= the caller's `notBefore` (this dispatch's own
  // start time), or the doc is treated exactly like "not present yet".
  it("a doc that predates notBefore is treated as not-yet-present — keeps polling, never accepted as found", async () => {
    let calls = 0;
    const container = fakeContainer(async () => {
      calls += 1;
      // An EARLIER run's doc: computedAt is before this dispatch started.
      return { resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T03:10:00Z" } };
    });
    const logs: string[] = [];
    const nowSpy = vi.spyOn(Date, "now");
    let simulatedNow = 1_000_000;
    nowSpy.mockImplementation(() => simulatedNow);
    const pollMs = 5_000;
    const sleepFn = vi.fn(async () => { simulatedNow += pollMs; });

    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: "2026-09-26T03:51:00Z", // this dispatch started AFTER the stale doc's computedAt
      maxMs: 15_000,
      pollMs,
      log: (s: string) => logs.push(s),
      err: () => {},
      sleepFn,
    });
    nowSpy.mockRestore();

    // Never accepted — the loop runs out its bound rather than returning 0
    // on the stale doc.
    expect(code).toBe(2);
    expect(calls).toBeGreaterThan(1);
    expect(logs.join("\n")).toContain("stale doc from 2026-09-26T03:10:00Z");
    expect(logs.join("\n")).toContain("waiting for a newer one");
  });

  it("a doc at or after notBefore is accepted as found (exit 0)", async () => {
    const container = fakeContainer(async () => ({
      resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T05:22:00Z" },
    }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: "2026-09-26T03:51:00Z", // doc's computedAt is AFTER this bound
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("MUTATION CHECK: without a notBefore bound, the same stale doc IS accepted immediately (proves the guard, not a tautology)", async () => {
    // Same fixture as the stale-doc test above, but with no notBefore passed
    // -- this is the pre-fix behavior (existence alone = found). If this
    // ever also returned 2, the stale-doc test above would not be proving
    // anything about the notBefore guard specifically.
    const container = fakeContainer(async () => ({
      resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T03:10:00Z" },
    }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
  });
});
