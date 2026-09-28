// CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (2026-09-27, then re-review same day).
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
// FIRST REVIEW found a second hazard: the doc id is date-only, so a same-day
// workflow_dispatch re-run can find an EARLIER run's doc under the same id.
// `notBefore` guards that: a doc is only "found" if its own `computedAt` is
// fresh enough.
//
// SECOND REVIEW found two defects in that first guard, both fixed in
// scripts/lib/not-before.cjs (see its header for the full reasoning) and
// pinned here:
//   1. String comparison of ISO timestamps is wrong when one side carries
//      milliseconds and the other doesn't -- must compare parsed epoch ms,
//      with a clock-skew tolerance.
//   2. notBefore must be REQUIRED: an empty or unparseable bound is now a
//      hard failure (exit 1), never a silent skip of the guard.
import { describe, it, expect, vi } from "vitest";
import { waitForDoc } from "../scripts/wait-for-doc.cjs";
import { CLOCK_SKEW_TOLERANCE_MS } from "../scripts/lib/not-before.cjs";

const NOT_BEFORE = "2026-09-26T03:51:00Z"; // this run's own dispatch time

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
  it("returns 0 immediately when a fresh doc is already present", async () => {
    const container = fakeContainer(async () => ({
      resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T05:00:00.000Z" },
    }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: NOT_BEFORE,
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("keeps polling through 404s and returns 0 once a fresh doc lands", async () => {
    let calls = 0;
    const container = fakeContainer(async () => {
      calls += 1;
      if (calls < 3) throw notFoundError();
      return { resource: { id: "doc", computedAt: "2026-09-26T05:00:00.000Z" } };
    });
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "doc",
      notBefore: NOT_BEFORE,
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
      notBefore: NOT_BEFORE,
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
      notBefore: NOT_BEFORE,
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
      notBefore: NOT_BEFORE,
      err: (s: string) => errs.push(s),
      log: () => {},
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("WAIT_FOR_DOC_ID required");
  });

  // ── STALE-DOC HAZARD (first review) ─────────────────────────────────────
  // The report id is date-only (`<scanDate>::anomaly-scan-report`), and
  // nightly-cleanliness.yml keeps workflow_dispatch enabled, so a same-day
  // re-dispatch can find an EARLIER run's doc under the SAME id before the
  // new chain ever finishes. Existence alone is not "found" — the doc's own
  // `computedAt` (stamped by anomaly-force-scan.cjs at report-build time)
  // must be fresh enough relative to `notBefore` (this dispatch's own start
  // time), or the doc is treated exactly like "not present yet".
  it("a doc that predates notBefore is treated as not-yet-present — keeps polling, never accepted as found", async () => {
    let calls = 0;
    const container = fakeContainer(async () => {
      calls += 1;
      // An EARLIER run's doc: computedAt is well before this dispatch started.
      return { resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T03:10:00.000Z" } };
    });
    const logs: string[] = [];
    const nowSpy = vi.spyOn(Date, "now");
    let simulatedNow = 1_000_000;
    nowSpy.mockImplementation(() => simulatedNow);
    const pollMs = 5_000;
    const sleepFn = vi.fn(async () => { simulatedNow += pollMs; });

    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: NOT_BEFORE, // 03:51:00Z — well after the stale doc's computedAt
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
    expect(logs.join("\n")).toContain("stale doc from 2026-09-26T03:10:00.000Z");
    expect(logs.join("\n")).toContain("waiting for a newer one");
  });

  it("a doc at or after notBefore is accepted as found (exit 0)", async () => {
    const container = fakeContainer(async () => ({
      resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T05:22:00.000Z" },
    }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: NOT_BEFORE, // doc's computedAt is well after this bound
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("MUTATION CHECK: a missing notBefore fails fast (1) rather than silently accepting any doc", async () => {
    // Same fixture as the stale-doc test above (an earlier run's doc), but
    // with no notBefore passed at all. Proves the guard is REQUIRED, not
    // merely present-when-provided: an omitted bound must not silently
    // reduce to "existence alone is found" (the pre-guard behavior).
    const container = fakeContainer(async () => ({
      resource: { id: "2026-09-26::anomaly-scan-report", computedAt: "2026-09-26T03:10:00.000Z" },
    }));
    const errs: string[] = [];
    const code = await waitForDoc(container, {
      docId: "2026-09-26::anomaly-scan-report",
      notBefore: undefined as any,
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: (s: string) => errs.push(s),
      sleepFn: vi.fn(async () => undefined),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("WAIT_FOR_DOC_NOT_BEFORE invalid");
  });

  // ── COMPARISON DEFECT (second review) ───────────────────────────────────
  // DISPATCHED_AT is stamped by `date -u +%Y-%m-%dT%H:%M:%SZ` (no ms);
  // anomaly-force-scan.cjs stamps computedAt with `new Date().toISOString()`
  // (WITH ms). A doc computed in the SAME second, with ms, must still be
  // accepted — a raw string compare would wrongly reject it, because "." (in
  // ".500Z") sorts before "Z".
  it("a doc computed in the same second, with milliseconds, is accepted (proves epoch-ms compare, not string compare)", async () => {
    const container = fakeContainer(async () => ({
      resource: { id: "doc", computedAt: "2026-09-26T03:51:00.500Z" }, // 500ms AFTER notBefore
    }));
    const sleepFn = vi.fn(async () => undefined);
    const code = await waitForDoc(container, {
      docId: "doc",
      notBefore: "2026-09-26T03:51:00Z", // no milliseconds
      maxMs: 60_000,
      pollMs: 5_000,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    expect(code).toBe(0);
  });

  it("a doc computed 1 full second beyond the clock-skew tolerance is rejected as stale", async () => {
    // CLOCK_SKEW_TOLERANCE_MS is 5000ms; "1s before notBefore" alone is well
    // inside that tolerance and must be ACCEPTED (see the acceptance test
    // above) — this fixture is 1s PAST the tolerance instead.
    let calls = 0;
    const staleComputedAt = new Date(
      Date.parse("2026-09-26T03:51:00Z") - CLOCK_SKEW_TOLERANCE_MS - 1000,
    ).toISOString();
    const container = fakeContainer(async () => {
      calls += 1;
      return { resource: { id: "doc", computedAt: staleComputedAt } };
    });
    const nowSpy = vi.spyOn(Date, "now");
    let simulatedNow = 1_000_000;
    nowSpy.mockImplementation(() => simulatedNow);
    const pollMs = 1_000;
    const sleepFn = vi.fn(async () => { simulatedNow += pollMs; });

    const code = await waitForDoc(container, {
      docId: "doc",
      notBefore: "2026-09-26T03:51:00Z",
      maxMs: 3_000,
      pollMs,
      log: () => {},
      err: () => {},
      sleepFn,
    });
    nowSpy.mockRestore();
    expect(code).toBe(2);
    expect(calls).toBeGreaterThan(1);
  });
});
