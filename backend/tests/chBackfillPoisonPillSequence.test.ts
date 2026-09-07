// CF-CH-BACKFILL-POISON-PILL-SEQUENCE (2026-09-07) — the escape must arm
// across REAL consecutive runs, and a quarantine run must not report failure.
//
// WHY THIS FILE EXISTS. chBackfillPoisonPill.test.ts pins the give-up RULE,
// but it does so against a local re-implementation of the decision:
//
//     function decideOnIncompleteDay(cursor, date) { ... }
//
// That pins arithmetic, not the system. It cannot see whether
// runHistoricalBackfill actually PERSISTS the attempt it just computed, nor
// whether the next run READS it back, nor what the runner does with the
// result. The live cursor after the first real poison-pill run showed
//
//     blockedDate "2025-10-08", blockedAttempts 1
//
// which is correct — but nothing in the suite proved run 2 would read that 1
// and write a 2, or that run 3 would step over the date. This file drives the
// real service three times against one in-memory cursor doc, which is the
// sequence the scheduled job actually performs.
//
// THE DEFECT IT CATCHES. backfill-ch-historical.cjs derives its exit code from
// res.perDay:
//
//     const failed = res.perDay.filter((d) => !d.complete);
//     if (failed.length > 0) { ...; return 2; }
//
// A QUARANTINED day is incomplete by construction — it 500s, that is the whole
// reason it is quarantined — so it stays in `failed` forever. The escape works,
// the cursor advances, later days ingest, and the workflow STILL exits 2 and
// reports failure on every subsequent run. A permanent red on a job that is
// now healthy is how a real regression gets ignored, so the run must be judged
// on days that blocked the walk, not on days already given up on.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

const downloadMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const readCursorMock = vi.hoisted(() => vi.fn());
const writeCursorMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/compiq/cardhedgeDailyExport.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/compiq/cardhedgeDailyExport.client.js")
  >("../src/services/compiq/cardhedgeDailyExport.client.js");
  return { ...actual, downloadDailyPriceExport: downloadMock };
});

vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  recordSoldComp: recordMock,
}));

vi.mock("../src/services/portfolioiq/chHistoricalBackfillStore.service.js", () => ({
  readBackfillCursor: readCursorMock,
  writeBackfillCursor: writeCursorMock,
}));

const CSV_HEADER = [
  "price_history_id", "source", "description", "price", "listing_url",
  "image_url", "pop", "sale_date", "sale_type", "card_id",
  "card_description", "number", "player", "grade", "grader",
  "group", "card_set", "card_set_type", "variant", "year",
  "created_at", "updated_at",
].join(",");

function csvFor(ids: string[], saleDate: string): string {
  const lines = [CSV_HEADER];
  for (const id of ids) {
    lines.push([
      id, "ebay", "Topps Chrome Ohtani", "100", "https://e.test/1",
      "https://i.test/1.jpg", "0", saleDate, "auction", "card-1",
      "Topps Chrome Ohtani", "1", "Shohei Ohtani", "10", "PSA",
      "Baseball", "Topps Chrome", "Base", "Base", "2024",
      `${saleDate}T00:00:00Z`, `${saleDate}T00:00:00Z`,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

const okDownload = (csv: string) => ({
  status: 200,
  bodyStream: Readable.from([csv]),
  contentType: "text/csv",
  contentLength: csv.length,
  contentEncoding: null,
});

const fiveHundred = () => ({
  status: 500,
  bodyStream: null,
  contentType: null,
  contentLength: 0,
  contentEncoding: null,
});

/** The one date CardHedge permanently 500s on, in production. */
const POISON = "2025-10-08";

/**
 * A stand-in for the Cosmos cursor doc that behaves like the real store:
 * writeBackfillCursor merges over the prior doc, and `undefined` on a field
 * means "leave as-is" — which is what lets a successful-day write avoid
 * wiping an in-progress block record.
 */
function makeCursorDoc(initial: Record<string, unknown> | null) {
  let doc: Record<string, unknown> | null = initial ? { ...initial } : null;
  readCursorMock.mockImplementation(async () => (doc ? { ...doc } : null));
  writeCursorMock.mockImplementation(async (update: Record<string, unknown>) => {
    const prior = doc ?? {};
    const pick = (k: string, dflt: unknown): unknown =>
      update[k] !== undefined ? update[k] : (prior[k] ?? dflt);
    doc = {
      id: "histbackfill::cursor",
      card_id: "_checkpoint",
      lastCompletedDate: update.lastCompletedDate,
      blockedDate: pick("blockedDate", null),
      blockedAttempts: pick("blockedAttempts", 0),
      blockedFirstSeenAt: pick("blockedFirstSeenAt", null),
      blockedLastError: pick("blockedLastError", null),
      quarantinedDates: pick("quarantinedDates", []),
      cumulativeDays: ((prior.cumulativeDays as number) ?? 0) + 1,
      ttl: -1,
    };
  });
  return (): Record<string, unknown> | null => (doc ? { ...doc } : null);
}

describe("CF-CH-BACKFILL-POISON-PILL — the escape arms across real runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordMock.mockResolvedValue({ written: true });
    // Every day downloads fine EXCEPT the poison date, which 500s forever.
    downloadMock.mockImplementation(async (d: string) =>
      d === POISON ? fiveHundred() : okDownload(csvFor(["a"], d)),
    );
  });

  it("failure → increment persisted → third failure quarantines and walks on", async () => {
    // The live cursor, exactly as read from Cosmos on 2026-09-07: the walk
    // has completed through 2025-10-07 and resumes on the poison date.
    const readDoc = makeCursorDoc({
      lastCompletedDate: "2025-10-07",
      blockedDate: null,
      blockedAttempts: 0,
      quarantinedDates: [],
      cumulativeDays: 280,
    });

    const { runHistoricalBackfill } = await import(
      "../src/services/portfolioiq/chHistoricalBackfill.service.js"
    );
    const run = () =>
      runHistoricalBackfill({
        endDate: "2025-10-11", maxDays: 40, apply: true, apiKey: "k",
      });

    // ── Run 1: first failure. Hold, and PERSIST strike 1. ───────────────
    const r1 = await run();
    expect(r1.stoppedReason).toBe("hard-error");
    expect(r1.cursorAfter).toBe("2025-10-07");
    const c1 = readDoc()!;
    expect(c1.blockedDate).toBe(POISON);
    expect(c1.blockedAttempts).toBe(1);
    // The cursor must NOT have stepped past the failed day.
    expect(c1.lastCompletedDate).toBe("2025-10-07");

    // ── Run 2: the increment must be READ BACK, not restart at 1. ───────
    // This is the step the pure-function test cannot reach: it proves the
    // number the previous run wrote is the number this run counts from.
    const r2 = await run();
    expect(r2.stoppedReason).toBe("hard-error");
    const c2 = readDoc()!;
    expect(c2.blockedDate).toBe(POISON);
    expect(c2.blockedAttempts).toBe(2);
    expect(c2.lastCompletedDate).toBe("2025-10-07");
    // The first-seen timestamp is the FIRST failure's, not this run's —
    // a rewritten timestamp would mean sameAsBefore evaluated false.
    expect(c2.blockedFirstSeenAt).toBe(c1.blockedFirstSeenAt);

    // ── Run 3: strike 3 quarantines, steps over, and ingests later days. ─
    const r3 = await run();
    expect(r3.quarantinedThisRun).toEqual([POISON]);
    expect(r3.stoppedReason).not.toBe("hard-error");
    const c3 = readDoc()!;
    expect(c3.quarantinedDates).toEqual([POISON]);
    // The block record is cleared once the date is given up on.
    expect(c3.blockedDate).toBeNull();
    expect(c3.blockedAttempts).toBe(0);
    // The walk got PAST the poison date and did real work after it.
    expect(c3.lastCompletedDate).toBe("2025-10-11");
    expect(r3.daysCompleted).toBeGreaterThan(0);
    expect(downloadMock.mock.calls.map((c) => c[0])).toContain("2025-10-09");
  });

  it("a quarantined day is not a run failure — the runner's exit gate", async () => {
    // Reproduces the exit code backfill-ch-historical.cjs computes. The
    // quarantine run above ingested three good days and cleared the deadlock,
    // so it is a SUCCESS; judging it on perDay completeness marks it red
    // forever, because the quarantined day is incomplete by definition.
    makeCursorDoc({
      lastCompletedDate: "2025-10-07",
      blockedDate: POISON,
      blockedAttempts: 2,
      quarantinedDates: [],
      cumulativeDays: 282,
    });

    const { runHistoricalBackfill, blockingFailures } = await import(
      "../src/services/portfolioiq/chHistoricalBackfill.service.js"
    );

    const res = await runHistoricalBackfill({
      endDate: "2025-10-11", maxDays: 40, apply: true, apiKey: "k",
    });

    expect(res.quarantinedThisRun).toEqual([POISON]);
    // The naive gate — every incomplete day — still sees the poison date.
    expect(res.perDay.filter((d) => !d.complete).map((d) => d.fileDate)).toEqual([POISON]);
    // The gate that matters counts only days that BLOCKED the walk. A day
    // we deliberately gave up on and recorded as a known hole is not one.
    expect(blockingFailures(res)).toEqual([]);
  });

  it("still fails the run when a day blocks the walk short of quarantine", async () => {
    makeCursorDoc({
      lastCompletedDate: "2025-10-07",
      blockedDate: null,
      blockedAttempts: 0,
      quarantinedDates: [],
      cumulativeDays: 280,
    });

    const { runHistoricalBackfill, blockingFailures } = await import(
      "../src/services/portfolioiq/chHistoricalBackfill.service.js"
    );

    const res = await runHistoricalBackfill({
      endDate: "2025-10-11", maxDays: 40, apply: true, apiKey: "k",
    });

    // A held day genuinely stalled the walk — that IS a failure, and the
    // exit code must stay non-zero so a real outage is still loud.
    expect(res.stoppedReason).toBe("hard-error");
    expect(blockingFailures(res).map((d) => d.fileDate)).toEqual([POISON]);
  });
});
