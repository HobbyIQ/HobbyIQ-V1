// CF-A-REFUSAL-IS-AN-OUTCOME-NOT-A-LOSS (2026-09-07).
//
// THE DEFECT. `tca-firehose-ingest.cjs` read FOUR of the outcome counters
// `persistVendorSalesToPool` returns and the service returns SIX.
// `twinAddressRefused` and `twinFolded` are TERMINAL — the row leaves the
// pipeline at the twin check and reaches none of the other four — so every
// refused row fell out of the ledger, `reportWrites` called the difference
// vanished work, and the run went red on exit 4.
//
// THE MEASUREMENT that identifies it beyond argument, from run 34071480616
// (2026-09-07T00:58Z), the run that motivated the fix:
//
//   fetched 19,109   written 9,177   skipped 9,719   ->  UNACCOUNTED 213 (1.11%)
//   `twin_address_refused` events in that run's log:                    213
//
// Exactly the shortfall, to the row. A missing term, not a dropped write.
//
// The staging promoter hit the identical bug and fixed it the identical way
// in #1953 (`UNACCOUNTED 6,557 (100.00%)`); the firehose was the one caller
// that never got that fix. These pins keep both from regressing, and pin the
// `refused` bucket that now names the outcome distinctly.
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { reconcileWrites } from "../src/services/ops/writeReconciliation";

afterEach(() => { process.exitCode = 0; });

describe("the 1.11% shortfall was a missing term", () => {
  // The run, reproduced exactly as the old code accounted for it.
  it("reproduces the red: the four-counter ledger loses 213 rows", () => {
    const r = reconcileWrites({
      job: "tca-firehose-ingest",
      intended: 19109,
      written: 9177,
      skipped: 9719,   // deduped + skipped + catalogUnmatched
      failed: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.unaccounted).toBe(213);
    expect((r.shortfallPct * 100).toFixed(2)).toBe("1.11");
    expect(process.exitCode).toBe(4);
    expect(r.message).toContain("WORK VANISHED");
  });

  // The same run with the refusals named. Nothing about the data changed —
  // 213 rows were always correctly refused; they were simply never counted.
  it("the same run reconciles to ZERO once the refusals are named", () => {
    const r = reconcileWrites({
      job: "tca-firehose-ingest",
      intended: 19109,
      written: 9177,
      skipped: 9719,
      refused: 213,    // twinAddressRefused + twinFolded
      failed: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.unaccounted).toBe(0);
    expect(r.overAccounted).toBe(0);
    expect(r.message).toContain("refused 213");
  });

  // THE REQUIRED FIXTURE: a parked row and a duplicate in the same run, both
  // counted. These two are the pair most easily confused — a dedup skip and a
  // guard refusal look alike in a log and are different outcomes — so the
  // ledger has to hold both at once and still land on zero.
  it("a parked row and a duplicate both count, in one run", () => {
    // 1,000 fetched: 600 written, 250 duplicates already in the pool, 100
    // refused by the twin guard, 30 folded onto an existing address, 20
    // unmatched to the catalog. Nothing vanished.
    const r = reconcileWrites({
      job: "tca-firehose-ingest",
      intended: 1000,
      written: 600,
      skipped: 250 + 20,   // deduped duplicates + catalogUnmatched
      refused: 100 + 30,   // twinAddressRefused + twinFolded
      failed: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.unaccounted).toBe(0);
    expect(r.message).toContain("skipped 270");
    expect(r.message).toContain("refused 130");
    expect(process.exitCode).toBe(0);
  });

  // A refusal is arithmetically a skip, so a caller that folds them together
  // still reconciles. The separate term buys a different QUESTION, not a
  // different sum: `skipped` is "we could not use this row", `refused` is "we
  // understood this row and declined to write it".
  it("refused folded into skipped reconciles identically — the term is for the reader", () => {
    const split = reconcileWrites({ job: "j", intended: 1000, written: 600, skipped: 270, refused: 130 });
    const folded = reconcileWrites({ job: "j", intended: 1000, written: 600, skipped: 400 });
    expect(split.ok).toBe(folded.ok);
    expect(split.unaccounted).toBe(folded.unaccounted);
  });

  // The over-accounting guard has to see refusals too, or double-counting a
  // row as both written and refused reads as a clean reconciliation.
  it("a refusal counted twice is OVER-accounting, as loud as a shortfall", () => {
    const r = reconcileWrites({
      job: "tca-firehose-ingest",
      intended: 1000,
      written: 600,
      skipped: 270,
      refused: 200,   // 130 real + 70 also counted somewhere else
    });
    expect(r.ok).toBe(false);
    expect(r.overAccounted).toBe(70);
    expect(process.exitCode).toBe(4);
    expect(r.message).toContain("COUNTERS DO NOT ADD UP");
  });

  it("a run with no refusals is unchanged — the banner does not grow a zero", () => {
    const r = reconcileWrites({ job: "j", intended: 100, written: 100, refused: 0 });
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain("refused");
  });

  it("a negative or fractional refused count cannot forge accounting", () => {
    const neg = reconcileWrites({ job: "j", intended: 100, written: 50, refused: -50 });
    expect(neg.unaccounted).toBe(50);
    const frac = reconcileWrites({ job: "j", intended: 100, written: 50, refused: 49.9 });
    expect(frac.unaccounted).toBe(1);
  });
});

describe("the ingest script names every outcome the service returns", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "tca-firehose-ingest.cjs"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("reads twinAddressRefused and twinFolded off the persist result", () => {
    expect(script).toContain("res.twinAddressRefused");
    expect(script).toContain("res.twinFolded");
  });

  it("declares them to reportWrites as refused, not as loss", () => {
    expect(script).toMatch(/refused:\s*totalTwinFolded \+ totalTwinRefused/);
  });

  // The equation printed in full, so a MISSING TERM is visible as a missing
  // term rather than as a number that is merely wrong.
  it("prints a self-checking ledger and shouts when it does not balance", () => {
    expect(script).toContain("[tca-firehose] reconcile —");
    expect(script).toMatch(/UNACCOUNTED \$\{unaccounted\} of \$\{totalFetched\}/);
  });

  it("the done banner surfaces both twin counters for the operator", () => {
    expect(script).toContain("twinFolded=${totalTwinFolded}");
    expect(script).toContain("twinRefused=${totalTwinRefused}");
  });

  // The service's own contract. If a SEVENTH terminal outcome is ever added,
  // this list is where the ingest learns it has to count it — and the
  // self-checking ledger above is what makes the omission loud at runtime.
  it("the six outcomes the ledger accounts for are all the terminal ones", () => {
    for (const term of [
      "totalWritten",
      "totalDedupSkipped",
      "totalCatalogUnmatched",
      "totalTwinFolded",
      "totalTwinRefused",
      "totalErrors",
    ]) {
      expect(script, term).toContain(term);
    }
  });
});

describe("the staging promoter's identical fix stays fixed (#1953)", () => {
  const promoter = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "promote-staging-pending.cjs"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  // This is the precedent the firehose fix follows. If it ever regresses, the
  // firehose's reader loses the one worked example of why the terms exist.
  it("still counts twin folds and refusals", () => {
    expect(promoter).toContain("res.twinAddressRefused");
    expect(promoter).toContain("res.twinFolded");
    expect(promoter).toContain("twinFolded + twinRefused");
  });
});
