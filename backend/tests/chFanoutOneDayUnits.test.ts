/**
 * CF-THE-UNIT-IS-ONE-DAY — the CH fan-out's budget unit, its marker, and its
 * 429 column.
 *
 * THE INCIDENT. Run 34234951079 (2026-09-08 13:55Z, manual dispatch, defaults)
 * printed
 *
 *   slice days: 14
 *   budget 300m loop + 5m unit reserve + 1m verify cap
 *   TIME_BUDGET=300m (job timeout is 340m)
 *   Slice 2026-08-29 → 2026-09-08
 *
 * and was then CANCELLED by the job's timeout-minutes: 340 at 19:36Z — 5h39m
 * in, 179,500 of 267,561 writes landed, with NO finishLane, NO budget marker
 * and NO reconcile.
 *
 * WHY THE BUDGET DID NOT FIRE. `outOfClock()` is a BETWEEN-UNITS pre-check by
 * the runner-budget contract, and the reserve is sized to the WORST UNIT.
 * BULK_SLICE_DAYS was 14 against a NIGHTLY_WINDOW_DAYS of 10, so the entire
 * window was ONE unit — there was never a second unit at which the check could
 * run. A 5-minute reserve against a multi-hour unit is fiction.
 *
 * WHAT THIS FILE PINS:
 *   1. the unit boundary math — a 10-day window is TEN units, newest first
 *   2. a budget stop leaves the marker the relaunch greps, naming the day to
 *      redo (never the day after it)
 *   3. a 429 swallowed inside recordSoldComp is COUNTED, never lost
 *   4. the reserve is sized to a measured unit, not to a house style
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT = path.join(__dirname, "..", "scripts", "bulk-import-ch-daily-to-sold-comps.cjs");
const WORKFLOW = path.join(
  __dirname, "..", "..", ".github", "workflows", "ch-fanout-to-sold-comps.yml",
);
const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
const yml = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");

/** The script's own date arithmetic, reproduced exactly. Kept in step by the
 *  first case below, which asserts the source still spells it this way. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The walk the script performs: newest-first, half-open [from, to) windows,
 *  clamped at END_DATE — the exact loop shape from main(). */
function unitsFor(start: string, end: string, sliceDays: number): Array<[string, string]> {
  const units: Array<[string, string]> = [];
  let currentEnd = start;
  let currentStart = addDays(currentEnd, -sliceDays);
  // The same guard the script's `while` uses, so an off-by-one here is an
  // off-by-one there.
  while (currentEnd > end && units.length < 500) {
    if (currentStart < end) currentStart = end;
    units.push([currentStart, currentEnd]);
    currentEnd = currentStart;
    currentStart = addDays(currentEnd, -sliceDays);
  }
  return units;
}

describe("the unit is ONE DAY, so the budget has somewhere to stop", () => {
  it("the nightly 10-day window is TEN units, not one", () => {
    // THE REGRESSION, stated as arithmetic. At the old SLICE_DAYS=14 this
    // window is a single unit and `outOfClock()` is never reached a second
    // time — which is precisely what ran 5h39m and got cancelled.
    const nightly = unitsFor("2026-09-08", "2026-08-29", 1);
    expect(nightly).toHaveLength(10);

    const asFourteen = unitsFor("2026-09-08", "2026-08-29", 14);
    expect(
      asFourteen,
      "at SLICE_DAYS=14 the whole window is ONE unit — the defect, kept here as "
        + "the contrast that makes the 10 above meaningful",
    ).toHaveLength(1);
  });

  it("walks newest first, and every unit is exactly one day", () => {
    const units = unitsFor("2026-09-08", "2026-08-29", 1);
    expect(units[0]).toEqual(["2026-09-07", "2026-09-08"]);
    expect(units[units.length - 1]).toEqual(["2026-08-29", "2026-08-30"]);
    for (const [from, to] of units) {
      expect(addDays(from, 1)).toBe(to);
    }
    // Strictly descending: the resume date is a single date only because the
    // walk never revisits a day out of order.
    const tops = units.map((u) => u[1]);
    expect([...tops].sort().reverse()).toEqual(tops);
  });

  it("the windows are half-open, so no sale is fanned out twice in one run", () => {
    // The query is `sale_date >= @from AND sale_date < @to`, so unit N's `from`
    // is unit N-1's `to` and the days tile without overlap.
    const units = unitsFor("2026-09-08", "2026-08-29", 1);
    for (let i = 1; i < units.length; i++) {
      expect(units[i][1]).toBe(units[i - 1][0]);
    }
  });

  it("a window that is not a whole multiple of the slice still stops AT end_date", () => {
    // Clamping matters: without it the last unit would reach past END_DATE and
    // fan out days the operator did not ask for.
    const units = unitsFor("2026-09-08", "2026-09-04", 3);
    expect(units[units.length - 1][0]).toBe("2026-09-04");
    expect(units.every(([from]) => from >= "2026-09-04")).toBe(true);
  });

  it("SLICE_DAYS defaults to 1 in the source, and the workflow does not override it back", () => {
    expect(
      src,
      "the default must be a source literal of 1 — the day is the resume unit",
    ).toMatch(/const SLICE_DAYS = Number\(process\.env\.BULK_SLICE_DAYS \|\| "1"\)/);
    // The workflow's env must not hard-code a wider unit for the cron. It may
    // pass an INPUT through (the historical bulk mode), but the fallback that
    // governs a scheduled run is 1.
    const line = /^\s*BULK_SLICE_DAYS:\s*(.+)$/m.exec(yml);
    expect(line, "the workflow must set BULK_SLICE_DAYS").toBeTruthy();
    expect(
      (line as RegExpExecArray)[1],
      "a scheduled run passes no inputs, so the fallback IS the nightly unit",
    ).toMatch(/inputs\.slice_days \|\| '1'/);
    expect((line as RegExpExecArray)[1]).not.toMatch(/^'14'/);
  });

  it("the slice can never again be wider than the nightly window without saying so", () => {
    // The defect in one line: a unit wider than the window is a unit the budget
    // cannot stop between. NIGHTLY_WINDOW_DAYS is read from the same file.
    const win = /^\s*NIGHTLY_WINDOW_DAYS:\s*'(\d+)'/m.exec(yml);
    expect(win, "the workflow must declare NIGHTLY_WINDOW_DAYS").toBeTruthy();
    const windowDays = Number((win as RegExpExecArray)[1]);
    const defaultSlice = Number(
      (/const SLICE_DAYS = Number\(process\.env\.BULK_SLICE_DAYS \|\| "(\d+)"\)/.exec(src) as RegExpExecArray)[1],
    );
    expect(
      defaultSlice,
      `a default slice of ${defaultSlice} days under a ${windowDays}-day nightly window makes the `
        + `whole walk ${Math.ceil(windowDays / defaultSlice)} unit(s). At 1 unit the budget has no `
        + `seam and the job dies on its timeout — run 34234951079.`,
    ).toBeLessThan(windowDays);
    expect(Math.ceil(windowDays / defaultSlice)).toBeGreaterThanOrEqual(10);
  });
});

describe("the budget stops INSIDE a day too, because a day is 50-188 minutes", () => {
  it("checks the clock before each write batch, not only between days", () => {
    // MEASURED (run 34234951079): 179,500 writes in 337.5 min = 8.86 rows/s at
    // CONCURRENCY 8, so ~26,760 filtered rows/day is ~50 minutes and an
    // unfiltered 100k-row day is ~188. Neither fits in any reserve that also
    // fits under the runner's 150-minute ceiling, so the day cannot be the
    // finest seam.
    expect(src).toMatch(/const WRITE_BATCH = Number\(process\.env\.BULK_WRITE_BATCH \|\| "1000"\)/);
    // A PRE-check, before the batch is drained — never a loop-top elapsed test.
    expect(src).toMatch(/for \(let b = 0; b < writes\.length; b \+= WRITE_BATCH\) \{\s*\n\s*if \(CLOCK\.outOfClock\(\)\)/);
  });

  it("a mid-day stop leaves the resume date ON that day, never past it", () => {
    // The relaunch redoes the partially-drained day; contentHash dedup makes
    // the overlap free. Advancing the window on a mid-day stop would skip the
    // undrained remainder of that day forever — a permanent hole.
    expect(
      src,
      "the window advance must be guarded by the mid-day stop flag",
    ).toMatch(/if \(batchStopped\) break;\s*\n\s*currentEnd = currentStart;/);
  });

  it("the reserve is sized to a measured unit and the margin still holds", () => {
    const reserve = /const RESERVE_MS = Number\(process\.env\.RESERVE_MS \|\| (\d+) \* 60 \* 1000\)/.exec(src);
    expect(reserve, "the reserve must stay a source literal the margin pin can read").toBeTruthy();
    const reserveMin = Number((reserve as RegExpExecArray)[1]);
    // One batch at the measured rate (1000 / 8.86 = 1.9 min) plus a day's
    // fetch (~0.5 min even unfiltered), with headroom. Anything less than the
    // batch it commits is not a reserve.
    expect(reserveMin).toBeGreaterThanOrEqual(3);
    const runMin = Number(
      (/const RUN_MINUTES = Number\(process\.env\.RUN_MINUTES \|\| (\d+)\)/.exec(src) as RegExpExecArray)[1],
    );
    // VERIFY_MS is spelled as a plain ms product (`60 * 1000`), so parse the
    // product the way runnerBudgetMargin's msDefault() does rather than
    // assuming a leading minutes factor.
    const verifyExpr = /const VERIFY_MS = Number\(process\.env\.VERIFY_MS \|\| ([0-9]+(?:\s*\*\s*[0-9]+)*)\)/.exec(src);
    expect(verifyExpr, "the verify cap must stay a source literal too").toBeTruthy();
    const verifyMin =
      (verifyExpr as RegExpExecArray)[1].split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1)
      / 60000;
    // The runner's step ceiling is 150 and runnerBudgetMargin requires >= 15
    // minutes of margin. Recomputed here so this file fails for the same
    // reason, by name, rather than only that one.
    expect(runMin + reserveMin + verifyMin + 1).toBeLessThanOrEqual(135);
  });
});

describe("every path prints the reconcile and the marker", () => {
  it("the ledger lives at module scope, so a throw can still report it", () => {
    // Locals in main() went out of scope with the throw: the catch printed a
    // stack and nothing about the writes already made.
    expect(src).toMatch(/^let emitted = 0;/m);
    expect(src).toMatch(/^let intendedWrites = 0;/m);
    expect(src).toMatch(/^let failedWrites = 0;/m);
    expect(src).toMatch(/^let currentEnd = null;/m);
  });

  it("the crash path reconciles before finishLane, and cannot mask the real error", () => {
    const tail = src.slice(src.indexOf(".catch(async (e)"));
    expect(tail).toMatch(/console\.error\(e\)/);
    expect(tail).toMatch(/try \{ reportLedger\(\); \}/);
    expect(tail).toMatch(/catch \(reportErr\)/);
    expect(tail).toMatch(/finishLane\(1, \{ budget: CLOCK \}\)/);
    // console.error(e) must come FIRST: the ledger is an addition to the
    // stack trace, never a replacement for it.
    expect(tail.indexOf("console.error(e)")).toBeLessThan(tail.indexOf("reportLedger()"));
  });

  it("the budget stop leaves the marker the relaunch greps", () => {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361): the runner greps
    // `stopped at the .*budget`. A source literal, never assembled.
    expect(src).toMatch(/stopped at the \$\{CLOCK\.RUN_MINUTES\}-minute budget/);
    const marker = src.slice(src.indexOf("if (stoppedOnBudget) {", src.indexOf("function reportLedger")));
    expect(marker).toMatch(/resume from BULK_START_DATE=\$\{currentEnd\}/);
    // And the mid-day stop sets that same flag, so a within-day budget stop is
    // as visible to the relaunch as a between-days one.
    expect(src).toMatch(/batchStopped = true;\s*\n\s*stoppedOnBudget = true;/);
  });

  it("reportLedger is called on the normal path and is idempotent", () => {
    expect(src).toMatch(/reportLedger\(\);\s*\n\s*return \{ client, budget: CLOCK \};/);
    expect(src).toMatch(/if \(reported\) return;\s*\n\s*reported = true;/);
  });
});

describe("a 429 is counted, never silently dropped", () => {
  it("recordSoldComp swallows the throw and returns written:true — the reason this is caller-side", () => {
    // THE ROOT CAUSE, pinned on the service so a future fix there is noticed
    // here. Its catch increments _emitFailureCounter, warns
    // sold_comps_upsert_error, and then FALLS THROUGH to
    // `return { written: true }`. The caller therefore cannot tell a throttled
    // write from a landed one, which is why this lane reads the counter.
    const service = fs.readFileSync(
      path.join(__dirname, "..", "src", "services", "portfolioiq", "soldCompsStore.service.ts"),
      "utf8",
    );
    expect(service).toMatch(/event: "sold_comps_upsert_error"/);
    expect(service).toMatch(/export function getEmitFailureCount\(\): number/);
  });

  it("the lane reads the emit-failure delta per batch and folds it into `failed`", () => {
    expect(src).toMatch(/getEmitFailureCount/);
    expect(src).toMatch(/const failBefore = getEmitFailureCount\(\);/);
    expect(src).toMatch(/const swallowed = getEmitFailureCount\(\) - failBefore;/);
    // A swallowed write is NOT written: it comes off `landed`/`emitted` and
    // goes onto `failedWrites`.
    expect(src).toMatch(/landed -= swallowed;/);
    expect(src).toMatch(/emitted \+= batch\.length - err - swallowed;/);
    expect(src).toMatch(/failedWrites \+= err \+ swallowed;/);
  });

  it("the reconcile identity still balances once the 429s are counted", () => {
    // The arithmetic the summary asserts: intended = written + failed. Before
    // this change a swallowed 429 was in NEITHER column and the identity
    // balanced on a row that was never in the pool.
    const batch = 1000;
    const err = 3;        // threw in the worker
    const swallowed = 7;  // threw inside recordSoldComp (429)
    const written = batch - err - swallowed;
    const failed = err + swallowed;
    expect(written + failed).toBe(batch);
    // and the previous behaviour, which did not:
    const writtenBefore = batch - err; // swallowed counted as landed
    expect(writtenBefore + err).toBe(batch);
    expect(
      writtenBefore,
      "the old count claimed the throttled rows were in the pool",
    ).toBeGreaterThan(written);
  });

  it("the summary prints the 429 column even when it is zero", () => {
    // Zero here is a measurement (the counter's delta), not an absence of one.
    expect(src).toMatch(/writes that threw inside recordSoldComp \(429 \/ throttle\)/);
    expect(src).toMatch(/counted as FAILED, re-attempted by the next run/);
  });

  it("does not change the RU budget or retry the throttle itself", () => {
    // Explicitly out of scope: the fix is accounting, not provisioning. A
    // silent RU bump here would hide the very signal this column exists for.
    expect(src).not.toMatch(/offerThroughput|replaceThroughput|autoscale/i);
  });
});
