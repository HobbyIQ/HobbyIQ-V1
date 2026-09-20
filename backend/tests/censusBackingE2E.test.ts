/**
 * CENSUS BACKING COUNT -- the end-to-end pin (2026-09-19 census batch,
 * corrected 2026-09-19 per independent review).
 *
 * Drives the REAL `main()` of rematch-sold-comps.cjs, MODE=census
 * SOURCES=backing, against a fake card_catalog holding two cells: 6 sales in
 * (baseball, 1953, topps) -- 1953 is slot 0's OWN measured shard unit, see
 * data/rematch-shard-table.json -- one strict-backed catalog row, one
 * non-strict catalog row, one sale with no catalog row, one sale with no
 * hobbyiqCardId, one parked (identityUnverified) sale, one flagged
 * (flaggedWrong) sale; plus 4 sales in a SEPARATE (baseball, 1953, bowman)
 * cell (no catalog row for bowman either way) used only to exercise the
 * load-FAILURE path -- 4 sales because the retry budget is spent one
 * attempt PER SALE of the failing cell, so proving "3 attempts then
 * permanently failed" needs at least 3 sales sharing that cell.
 *
 * WHAT THIS PROVES THAT A UNIT TEST OF THE PURE HELPERS CANNOT:
 *   1. `SOURCES=backing` actually arms the block (`backing` is present and
 *      non-null in the written census-slot-0.json, `null`/absent otherwise).
 *   2. Sales sharing a cell are answered from ONE card_catalog query --
 *      never one point read per sale/id -- the whole reason this design
 *      exists (see CENSUS_BACKING's own comment on the ~49 RU/point-read
 *      finding). The ORDINARY (non-backing) classify path already issues
 *      its own unconditional card_catalog query per product via
 *      `clashSubsetsFor(stored)` -- pre-existing, unrelated to this change
 *      -- so the pin is on the DELTA armed - baseline, never an assumed
 *      zero baseline.
 *   3. The query is by ID PREFIX (STARTSWITH(c.id, 'hiq:<sport>:<year>:
 *      <setKey>:')), not by the setKey FIELD -- the fixture keys its
 *      response off the `@prefix` parameter and would return nothing (or
 *      wrong rows) if the implementation regressed to field equality.
 *   4. The bucket a sale lands in matches what its catalog row (or lack of
 *      one) says, including parked/unparseable/notPricedFlagged.
 *   5. A card_catalog load FAILURE for a cell buckets its sales `unknown`
 *      -- NEVER `noRow` -- is retried up to BACKING_PRELOAD_CELL_FAIL_RETRIES
 *      times, is counted in `preload.failedCells`/`failedCellSamples`, and
 *      does not crash the slot.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backend = join(__dirname, "..");
const SCRIPT = join(backend, "scripts", "rematch-sold-comps.cjs");
const PRELOAD = join(backend, "tests", "fixtures", "census-backing-e2e", "fake-cosmos-backing.cjs");
const DIST_EXISTS = existsSync(join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));
const itIfBuilt = DIST_EXISTS ? it : it.skip;
const TEST_TIMEOUT_MS = 60_000;

function runCensus(opts: {
  censusOut: string; controlStateFile: string; sources?: string;
  failCatalogCell?: boolean; failRetries?: number;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: "census",
    SLOT: "0",
    SLOTS: "32",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: "10",
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
  };
  if (opts.sources !== undefined) env.SOURCES = opts.sources; else delete env.SOURCES;
  if (opts.failCatalogCell) env.FAIL_CATALOG_CELL = "true"; else delete env.FAIL_CATALOG_CELL;
  if (opts.failRetries !== undefined) env.BACKING_PRELOAD_CELL_FAIL_RETRIES = String(opts.failRetries);
  else delete env.BACKING_PRELOAD_CELL_FAIL_RETRIES;
  return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
}

describe("rematch-sold-comps.cjs MODE=census SOURCES=backing -- end to end against a real card_catalog read", () => {
  const dirs: string[] = [];
  function freshPaths() {
    const dir = mkdtempSync(join(tmpdir(), "census-backing-e2e-"));
    dirs.push(dir);
    return { censusOut: join(dir, "census"), controlStateFile: join(dir, "control-state.json") };
  }
  afterEach(() => {
    while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  itIfBuilt("baseline (no SOURCES=backing): the pre-existing clashSubsetsFor query fires once per product, `backing` is null", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile }); // SOURCES unset
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    const m = /FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(out);
    expect(m).not.toBeNull();
    // The ordinary classify path's OWN unconditional card_catalog query
    // (clashSubsetsFor(stored), pre-existing and unrelated to this PR) fires
    // once per (year, setKey, sport) PRODUCT -- topps (6 sales) and bowman
    // (1 sale) are two products, so this baseline is 2, not 0 and not 1.
    expect(Number(m![1])).toBe(2);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).toBeNull();
  });

  itIfBuilt("SOURCES=backing adds exactly ONE more query per cell (2 cells here) on top of the baseline, and writes a correctly-bucketed `backing` block", () => {
    const base = freshPaths();
    const baseline = runCensus(base);
    const baselineQueries = Number(/FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(baseline.stdout ?? "")?.[1] ?? NaN);
    expect(Number.isFinite(baselineQueries)).toBe(true);

    const armed = freshPaths();
    const res = runCensus({ ...armed, sources: "backing" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    // Proves the design point: the backing preload adds exactly TWO more
    // queries (one per cell: topps, bowman) on top of whatever the ordinary
    // path already issues -- never a point read per sale/id, and never more
    // than one query per DISTINCT cell regardless of how many sales share it.
    const m = /FAKE_CATALOG_QUERY_COUNT (\d+)/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(baselineQueries + 2);

    const artifact = JSON.parse(readFileSync(join(armed.censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();
    expect(artifact.backing.armedBy).toBe("SOURCES=backing");

    const sport = artifact.backing.bySport.baseball;
    expect(sport).toEqual({
      // topps: backedStrict 1, rowExistsNonStrict 1, noRow 1, unparseable 1,
      // parked 1, notPricedFlagged 1. bowman: 4 sales, no catalog row for
      // any of them (CATALOG_ROWS holds no bowman entries), so all 4 land
      // in noRow -> sport-level noRow = 1 (topps) + 4 (bowman) = 5.
      backedStrict: 1, rowExistsNonStrict: 1, noRow: 5, unparseable: 1,
      parked: 1, notPricedFlagged: 1, unknown: 0,
    });

    const toppsCell = artifact.backing.byCell["baseball|1953|topps"];
    expect(toppsCell).toEqual({
      backedStrict: 1, rowExistsNonStrict: 1, noRow: 1, unparseable: 1,
      parked: 1, notPricedFlagged: 1, unknown: 0,
    });

    const bowmanCell = artifact.backing.byCell["baseball|1953|bowman"];
    expect(bowmanCell).toEqual({
      backedStrict: 0, rowExistsNonStrict: 0, noRow: 4, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });

    // Two backing-preload queries (one per distinct cell), regardless of how
    // many the baseline path itself issued -- the artifact's own metric, so
    // a reader does not have to diff raw fixture query counts.
    expect(artifact.backing.preload.distinctCellQueries).toBe(2);
    expect(artifact.backing.preload.distinctCellsTouched).toBe(2);
    expect(artifact.backing.preload.catalogRowsRead).toBe(2); // the 2 catalog rows under the topps prefix (bowman has 0 -- it is not in CATALOG_ROWS in this run)
    expect(artifact.backing.preload.failedCells).toBe(0);
    expect(artifact.backing.preload.failedCellSamples).toEqual([]);

    const denom = artifact.backing.denominatorNote as string;
    expect(denom).toMatch(/included-in-denominator/);
    expect(denom).toMatch(/excluded-from-denominator/);
  });

  itIfBuilt("a wrong SOURCES value (not literally 'backing') does not arm the block", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile, sources: "some-other-thing" });
    expect(res.status).toBe(0);
    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).toBeNull();
  });

  itIfBuilt("a FAILED card_catalog load buckets its sales `unknown`, never `noRow`, retries per sale up to the budget, then never crashes the slot", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile, sources: "backing", failCatalogCell: true, failRetries: 3 });
    expect(res.status).toBe(0); // the slot finishes -- a failed cell load is not fatal

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();

    // The bowman cell has 4 sales; the first 3 each trigger a fresh load
    // attempt (never cached as a failure), all 3 fail, and the cell is then
    // marked permanently failed -- so the 4th sale gets NO query at all and
    // is also bucketed unknown. All 4 land in `unknown`, never `noRow`, and
    // never counted toward backedStrict/rowExistsNonStrict.
    const bowmanCell = artifact.backing.byCell["baseball|1953|bowman"];
    expect(bowmanCell).toEqual({
      backedStrict: 0, rowExistsNonStrict: 0, noRow: 0, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 4,
    });

    // The topps cell is UNAFFECTED -- a failure in one cell must not poison
    // another cell's answers.
    const toppsCell = artifact.backing.byCell["baseball|1953|topps"];
    expect(toppsCell).toEqual({
      backedStrict: 1, rowExistsNonStrict: 1, noRow: 1, unparseable: 1,
      parked: 1, notPricedFlagged: 1, unknown: 0,
    });

    // The bowman cell was QUERIED exactly BACKING_PRELOAD_CELL_FAIL_RETRIES
    // times (3), not 4 -- the 4th sale's attempt was skipped entirely
    // because the cell was already marked permanently failed by then. This
    // proves the retry-then-give-up accounting: not an infinite retry loop,
    // not a silent single-attempt give-up, and not a wasted 4th query.
    const out = res.stdout ?? "";
    const bowmanAttempts = Number(/FAKE_BOWMAN_CELL_QUERY_COUNT (\d+)/.exec(out)?.[1] ?? NaN);
    expect(bowmanAttempts).toBe(3);

    expect(artifact.backing.preload.failedCells).toBe(1);
    expect(artifact.backing.preload.failedCellSamples).toHaveLength(3); // one sample per failed attempt
    for (const sample of artifact.backing.preload.failedCellSamples) {
      expect(sample.cell).toBe("1953|bowman|baseball");
      expect(String(sample.error)).toMatch(/simulated card_catalog outage/);
    }
    expect(artifact.backing.preload.failedCellSamples.map((s: any) => s.attempt)).toEqual([1, 2, 3]);

    // The sport-level bucket carries all 4 unknown sales too, separate from
    // noRow, so a reader summing bySport sees it without opening byCell.
    const sport = artifact.backing.bySport.baseball;
    expect(sport.unknown).toBe(4);
    expect(sport.noRow).toBe(1); // only the topps cell's genuine noRow sale
  });

  itIfBuilt("a lower BACKING_PRELOAD_CELL_FAIL_RETRIES is honoured -- fewer attempts before giving up", () => {
    const { censusOut, controlStateFile } = freshPaths();
    const res = runCensus({ censusOut, controlStateFile, sources: "backing", failCatalogCell: true, failRetries: 1 });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";
    const bowmanAttempts = Number(/FAKE_BOWMAN_CELL_QUERY_COUNT (\d+)/.exec(out)?.[1] ?? NaN);
    expect(bowmanAttempts).toBe(1);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing.preload.failedCells).toBe(1);
    // All 4 bowman sales are unknown even though only 1 query was actually
    // issued -- 3 of the 4 sales never even attempt a query, because the
    // cell was already marked permanently failed after the first.
    expect(artifact.backing.byCell["baseball|1953|bowman"].unknown).toBe(4);
  });
});

/**
 * SOURCES=backing SURVIVES A STOP-MID-SHARD RESUME (2026-09-20, the census
 * self-relaunch backing-loss fix -- the end-to-end pin for all three pieces
 * together: the workflow forwards `sources`, the cursor signature keys on
 * it, and the checkpoint carries the backing tallies forward).
 *
 * Drives the REAL main() as two separate child-process passes over slot 0,
 * the same two-pass shape rematchCensusCursorE2E.test.ts uses for the
 * unit-boundary cursor -- but stopped via LIMIT rather than a simulated
 * budget exhaustion. LIMIT sets `stopReason` through the EXACT SAME
 * checkpoint code path a real budget stop does (main()'s cursor-save block
 * branches only on whether `stopReason` is set, never on its text), so this
 * proves the same resume machinery -- and LIMIT is the only stop mechanism
 * that can land cleanly BETWEEN unit A's 3 rows finishing (each with a full,
 * un-throttled backing budget) and unit B's first row, without also
 * starving the backing preload's own margin check
 * (`budgetLeft() < BACKING_PRELOAD_QUERY_TIMEOUT_MS + 90000`) the way an
 * artificially slowed fetch would: shrinking the clock to trip the ordinary
 * page-boundary check ALSO trips backing's stricter one first, which would
 * make unit A's own sales bucket `unknown` (this run "chose not to spend
 * its last budget" on the preload) rather than exercising the resume this
 * test exists to prove.
 *
 *   PASS 1  LIMIT=3 -- classifies unit A's exactly 3 sales (one
 *           backedStrict, two noRow, all in the pokemon|2025|some-set cell)
 *           with a full backing budget, then stops on touching unit B's
 *           first row. Unit A is marked done; unit B is untouched.
 *   PASS 2  resumes, reads pass 1's cursor (now carrying the backing tally
 *           too), classifies ONLY unit B's 2 sales (baseball|1953|topps
 *           cell, both noRow), and its FINAL artifact must show BOTH
 *           cells' tallies -- proving the merge, not an overwrite -- with
 *           the backing total equal to `classified` (5), never short.
 */
describe("rematch-sold-comps.cjs MODE=census SOURCES=backing -- a resumed pass merges the PRIOR pass's backing tally, not just its counts", () => {
  const RESUME_PRELOAD = join(backend, "tests", "fixtures", "census-backing-resume-e2e", "fake-cosmos-backing-resume.cjs");
  const RESUME_TIMEOUT_MS = 60_000;

  function runResumePass(opts: { censusOut: string; controlStateFile: string; limit?: number }) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODE: "census",
      SLOT: "0",
      SLOTS: "32",
      SOURCES: "backing",
      COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
      RUN_MINUTES: "10",
      CENSUS_OUT: opts.censusOut,
      CONTROL_STATE_FILE: opts.controlStateFile,
    };
    if (opts.limit !== undefined) env.LIMIT = String(opts.limit); else delete env.LIMIT;
    return spawnSync(process.execPath, ["-r", RESUME_PRELOAD, SCRIPT], {
      cwd: backend, env, encoding: "utf8", timeout: RESUME_TIMEOUT_MS,
    });
  }

  let dir: string;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });

  itIfBuilt("pass 1 stops after unit A (LIMIT=3) with unit A's backing tally checkpointed", () => {
    dir = mkdtempSync(join(tmpdir(), "census-backing-resume-e2e-"));
    const censusOut = join(dir, "census");
    const controlStateFile = join(dir, "control-state.json");

    const res = runResumePass({ censusOut, controlStateFile, limit: 3 });
    expect(res.status).toBe(0);
    expect(res.stdout ?? "").toMatch(/stopped at the LIMIT of 3 rows/);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.classified).toBe(3); // unit A only
    expect(artifact.backing).not.toBeNull();
    expect(artifact.backing.bySport.pokemon).toEqual({
      backedStrict: 1, rowExistsNonStrict: 0, noRow: 2, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });

    // The checkpoint itself carries the backing maps -- the actual fix,
    // proven directly against the persisted cursor doc rather than inferred
    // only from pass 2's behaviour below.
    const controlState = JSON.parse(readFileSync(controlStateFile, "utf8"));
    const cursor = controlState["census-cursor::slot-0"];
    expect(cursor.aggregate.backingBySport).toBeTruthy();
    expect(cursor.aggregate.backingBySport.pokemon).toEqual({
      backedStrict: 1, rowExistsNonStrict: 0, noRow: 2, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });
    expect(cursor.aggregate.backingByCell["pokemon|2025|some-set"]).toBeTruthy();
    // The signature carries the new sourcesMode field, "backing".
    expect(cursor.signature.sourcesMode).toBe("backing");
  }, RESUME_TIMEOUT_MS + 10_000);

  itIfBuilt("pass 2 resumes, classifies only unit B, and the FINAL artifact's backing total equals classified (5) -- both cells present, neither overwritten", () => {
    dir = mkdtempSync(join(tmpdir(), "census-backing-resume-e2e-"));
    const censusOut = join(dir, "census");
    const controlStateFile = join(dir, "control-state.json");

    const first = runResumePass({ censusOut, controlStateFile, limit: 3 });
    expect(first.status).toBe(0);

    // Pass 2 -- what the workflow fix makes possible: SOURCES=backing is
    // still set (a real relaunch now forwards it verbatim), so this pass
    // arms CENSUS_BACKING exactly as pass 1 did, and its signature matches
    // pass 1's cursor (same sourcesMode: "backing"). No LIMIT this time --
    // the relaunch's own LIMIT would in practice be forwarded unchanged too,
    // but this test only needs pass 2 to run unit B to completion.
    const second = runResumePass({ censusOut, controlStateFile });
    expect(second.status).toBe(0);
    const out = second.stdout ?? "";
    expect(out).toMatch(/CENSUS CURSOR: resuming slot 0/);
    expect(out).not.toMatch(/INCOMPLETE BACKING/);

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.classified).toBe(5); // both units: 3 + 2
    expect(artifact.stoppedAtBudget).toBe(false);

    // BOTH cells present in the FINAL artifact -- pass 1's (pokemon cell)
    // merged in, pass 2's own (baseball|topps cell) added, neither lost.
    expect(artifact.backing.byCell["pokemon|2025|some-set"]).toEqual({
      backedStrict: 1, rowExistsNonStrict: 0, noRow: 2, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });
    expect(artifact.backing.byCell["baseball|1953|topps"]).toEqual({
      backedStrict: 0, rowExistsNonStrict: 0, noRow: 2, unparseable: 0,
      parked: 0, notPricedFlagged: 0, unknown: 0,
    });

    // THE ACCEPTANCE CRITERION: backing-classified total (summed across
    // bySport) EQUALS classified (5) -- the exact invariant the
    // INCOMPLETE BACKING assertion in main() checks. Before the fix (backing
    // maps absent from the cursor), this pass's OWN merge would have started
    // its backing tally at zero and finished with only unit B's 2 rows
    // backing-tallied against a `classified` of 5 -- short by 3, and this
    // assertion is exactly what would have caught it.
    const t = artifact.backing.bySport;
    const backingTotal = Object.values(t as Record<string, Record<string, number>>).reduce(
      (sum, b) => sum + Object.values(b).reduce((a, n) => a + n, 0), 0,
    );
    expect(backingTotal).toBe(artifact.classified);
  }, RESUME_TIMEOUT_MS + 10_000);
});
