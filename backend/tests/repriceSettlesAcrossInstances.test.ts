/**
 * CF-REPRICE-SETTLES-ACROSS-INSTANCES (2026-09-08) tests.
 *
 * The incident: six eBay-imported holdings sat on "CHECKING PRICE…" with
 * VALUE "—" indefinitely, even though the engine had already priced them and
 * WITHHELD with `reason: "no-checklist-match"`, writing a full prose reason
 * to each row. The refusal was correct and the client can render it — but it
 * was never shown, because the client believed a reprice was still running.
 *
 * Why it believed that: HobbyIQ3 runs 2 serving instances and the reprice job
 * map is per-process. A poll routed to the worker that did NOT dispatch
 * answers `unknown-here` (or `idle`), and BOTH are keep-polling by design —
 * correct, because answering "settled" for a run you cannot see was the
 * earlier bug (CF-PORTFOLIO-REFRESH-ASYNC). But nothing could ever resolve
 * that state, so the client polled to its 5-minute deadline with
 * `autoRefreshing` true the whole time, and the row's spinner suppressed the
 * withheld reason for the duration.
 *
 * The fix: a worker with no view of the run may still settle it from facts
 * BOTH instances share — the durable `lastRepriceDispatchAt` marker and each
 * holding's own `lastUpdated`. If every row was written at or after the
 * dispatch, the run demonstrably finished, whoever ran it.
 *
 * These tests pin the predicate, especially its conservative direction: any
 * missing or ambiguous fact must return to keep-polling, never a false
 * settle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildRepriceStatusPayload,
  settledElsewhere,
  type DurableRepriceEvidence,
} from "../src/services/portfolioiq/portfolioStore.service";
import * as repriceJobs from "../src/services/portfolioiq/repriceJobTracker";

const USER = "user-settles-across-instances";
const DISPATCH = Date.parse("2026-09-08T13:14:00.000Z");
const NOW = Date.parse("2026-09-08T13:20:00.000Z");

/** Every row written after the dispatch — the run reached all of them. */
const allRowsFresh: DurableRepriceEvidence = {
  dispatchedAt: DISPATCH,
  oldestValuationAtMs: Date.parse("2026-09-08T13:15:02.000Z"),
  holdingCount: 44,
};

describe("settledElsewhere — the cross-instance settlement predicate", () => {
  it("settles when every holding was written at or after the dispatch", () => {
    const out = settledElsewhere(allRowsFresh, NOW);
    expect(out).not.toBeNull();
    // Reports the last write it can prove, not the dispatch.
    expect(out!.finishedAt).toBe("2026-09-08T13:15:02.000Z");
  });

  it("settles on the exact boundary (oldest row == dispatch instant)", () => {
    const out = settledElsewhere(
      { dispatchedAt: DISPATCH, oldestValuationAtMs: DISPATCH, holdingCount: 3 },
      NOW,
    );
    expect(out).not.toBeNull();
  });

  it("does NOT settle a run still in flight — an unreached row is older", () => {
    // The run has written some rows but not all; the stalest still carries
    // yesterday's stamp. This is exactly the mid-run state that must keep
    // the client polling.
    expect(
      settledElsewhere(
        {
          dispatchedAt: DISPATCH,
          oldestValuationAtMs: Date.parse("2026-09-07T09:51:00.000Z"),
          holdingCount: 44,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("does NOT settle when no dispatch is on record", () => {
    expect(
      settledElsewhere({ dispatchedAt: null, oldestValuationAtMs: NOW, holdingCount: 5 }, NOW),
    ).toBeNull();
  });

  it("does NOT settle when a row carries no valuation stamp at all", () => {
    // A stampless row cannot testify that the run reached it. The handler
    // collapses this case to a null oldest.
    expect(
      settledElsewhere(
        { dispatchedAt: DISPATCH, oldestValuationAtMs: null, holdingCount: 44 },
        NOW,
      ),
    ).toBeNull();
  });

  it("does NOT settle on a future-dated marker (clock artifact, not evidence)", () => {
    expect(
      settledElsewhere(
        { dispatchedAt: NOW + 60_000, oldestValuationAtMs: NOW, holdingCount: 1 },
        NOW,
      ),
    ).toBeNull();
  });

  it("settles an empty portfolio on the dispatch alone — nothing to write", () => {
    const out = settledElsewhere(
      { dispatchedAt: DISPATCH, oldestValuationAtMs: null, holdingCount: 0 },
      NOW,
    );
    expect(out).not.toBeNull();
    expect(out!.finishedAt).toBe(new Date(DISPATCH).toISOString());
  });

  it("returns null on absent evidence (Cosmos read failed → previous behaviour)", () => {
    expect(settledElsewhere(null, NOW)).toBeNull();
  });
});

describe("buildRepriceStatusPayload — settlement reaches the wire", () => {
  beforeEach(() => {
    repriceJobs.__resetForTests?.();
  });

  it("reports settled-elsewhere for a jobId this worker never issued", () => {
    // The exact incident shape: the client names a run minted on the OTHER
    // instance, and this worker can prove from durable facts that it landed.
    const p = buildRepriceStatusPayload(USER, "job-from-the-other-worker", NOW, allRowsFresh);
    expect(p.status).toBe("settled-elsewhere");
    expect(p.settled).toBe(true);
    expect(p.running).toBe(false);
  });

  it("still answers unknown-here when the evidence does not prove a finish", () => {
    const p = buildRepriceStatusPayload(USER, "job-from-the-other-worker", NOW, {
      dispatchedAt: DISPATCH,
      oldestValuationAtMs: Date.parse("2026-09-07T09:51:00.000Z"),
      holdingCount: 44,
    });
    expect(p.status).toBe("unknown-here");
    expect(p.settled).toBe(false);
  });

  it("degrades to the pre-CF answer when durable evidence is unavailable", () => {
    const p = buildRepriceStatusPayload(USER, "job-from-the-other-worker", NOW, null);
    expect(p.status).toBe("unknown-here");
    expect(p.settled).toBe(false);
  });

  it("never reports settled-elsewhere over a run this worker owns and is running", () => {
    // Local truth outranks inference: a job map entry we own is authoritative,
    // and must not be overridden by durable stamps from an earlier run.
    const owned = repriceJobs.markStarted(USER, NOW);
    const p = buildRepriceStatusPayload(USER, owned.jobId, NOW, allRowsFresh);
    expect(p.status).toBe("running");
    expect(p.settled).toBe(false);
  });
});
