// CF-CLEANLINESS-ANOMALY-BUDGET (2026-09-11, cron canary triage).
//
// nightly-cleanliness.yml's forced anomaly rescan has gone two nights
// straight (09-10, 09-11) without a single terminal answer inside
// poll-admin-job.cjs's 1501s ceiling. The scan is a full sold_comps walk
// with no paging cap and no wall-clock budget of its own (unlike its
// sibling baseline-pool-snapshot.cjs, which runs under runner-budget.cjs's
// clock) — the stale "~30s" comment that used to justify skipping a budget
// is gone, and detectAnomalies now logs scan start/finish (elapsedMs) so
// the NEXT triage has a real number instead of re-deriving one from
// App Insights showing only the instant 202 dispatch.
//
// This pins the cheap, deterministic slice of that change: a force:true
// call logs its start unconditionally (via console.warn, same stream
// convention as logSubRawInversionObserved — App Insights keeps WARN,
// drops INFO/stdout) even when the container guard short-circuits before
// any scan work runs, and a non-forced (cached-path) call never logs at
// all. The slow-path (finish log + elapsedMs) needs a live Cosmos
// container to exercise for real and is exactly what the nightly cron
// already covers — not re-tested here with a live connection per
// "never run WRITE paths locally against prod" / no live Cosmos calls
// from a unit test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectAnomalies } from "../src/services/portfolioiq/anomalyDetection.service.js";

describe("CF-CLEANLINESS-ANOMALY-BUDGET — scan start/finish logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const savedConn = process.env.COSMOS_CONNECTION_STRING;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.COSMOS_CONNECTION_STRING;
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (savedConn === undefined) delete process.env.COSMOS_CONNECTION_STRING;
    else process.env.COSMOS_CONNECTION_STRING = savedConn;
  });

  function scanStartedEvents() {
    return warnSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((p): p is Record<string, unknown> => p != null && p.event === "anomaly_detection_scan_started");
  }

  it("force:true logs a scan-started event even when no Cosmos container is configured", async () => {
    const report = await detectAnomalies({ force: true });
    expect(report).toBeNull(); // no COSMOS_CONNECTION_STRING → early null, same as before this change
    const started = scanStartedEvents();
    expect(started).toHaveLength(1);
    expect(started[0]!.source).toBe("anomalyDetection.service");
    expect(started[0]!.force).toBe(true);
    expect(typeof started[0]!.startedAt).toBe("string");
  });

  it("a non-forced call never logs a scan-started event", async () => {
    const report = await detectAnomalies({ force: false });
    expect(report).toBeNull();
    expect(scanStartedEvents()).toEqual([]);
  });

  it("an omitted opts object (default {}) behaves like force:false — no log", async () => {
    const report = await detectAnomalies();
    expect(report).toBeNull();
    expect(scanStartedEvents()).toEqual([]);
  });
});
