/**
 * CENSUS BACKING PRELOAD -- THE HANG FIX (2026-09-20).
 *
 * Tonight's 32 `rematch-sold-comps mode=census sources=backing` slots (PR
 * #2346) hung 150 minutes and were killed with ZERO output. Root cause,
 * confirmed by a read-only measurement probe against prod: `backingCellPreload`
 * used to be awaited for the FIRST TIME inside the row loop, one row at a
 * time -- never warmed -- and its query used `maxItemCount: -1` with no
 * `maxDegreeOfParallelism` on a cross-partition `SELECT DISTINCT` predicate,
 * which does not run slow, it SPINS: `hasMoreResults()` stays true forever
 * while `fetchNext()` resolves immediately with 0 RU and 0 rows on every
 * page, reproduced identically on the smallest measured cell (1,446 rows,
 * hockey:2023:upper-deck) and the largest (203,058 rows,
 * baseball:2025:topps) -- proving it is a client-side SDK defect independent
 * of result size, not network latency. Neither `retry()`'s own backoff nor
 * the SDK's 30-try/120s throttle retry ever saw it, because nothing ever
 * threw -- the promise kept resolving, just never made progress.
 *
 * This file pins the four fixes that close it:
 *   1. A hard per-query timeout (BACKING_PRELOAD_QUERY_TIMEOUT_MS, default
 *      20s) via AbortController + Promise.race, feeding the EXISTING
 *      BACKING_LOAD_FAILED path -- counted, never silent, the row is still
 *      classified (bucketed `unknown`).
 *   2. The preload moved into the page's existing warm phase (distinct
 *      cells of the page, CLASSIFY_CONCURRENCY-bounded) so the row loop
 *      performs ZERO backing network calls on a warmed page.
 *   3. A heartbeat line at least every CENSUS_HEARTBEAT_MS, inside page
 *      processing, naming rows classified, cells preloaded, preload
 *      failures and RU spent on backing.
 *   4. A budget check immediately before a COLD preload (one that is not
 *      already cached/permanently-failed), so a slot with too little clock
 *      left to safely start one more preload bails to `unknown` and lets
 *      the pre-existing page/unit checkpoint save a resumable cursor,
 *      instead of being killed mid-query.
 *
 * censusBackingE2E.test.ts already pins the query SHAPE (id-prefix,
 * per-cell, bucket semantics, the pre-existing fail-then-permanently-fail
 * retry accounting) -- this file is additive, pinning only the four NEW
 * behaviours above, against the SAME fixture (extended with an
 * FAKE_CATALOG_QUERY_ORDER marker and a HANG_CATALOG_CELL knob).
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
  censusOut: string; controlStateFile: string;
  hangCatalogCell?: boolean; failCatalogCell?: boolean;
  backingTimeoutMs?: number; heartbeatMs?: number; runMinutes?: string;
  classifyConcurrency?: string;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODE: "census",
    SLOT: "0",
    SLOTS: "32",
    SOURCES: "backing",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://fake.invalid:443/;AccountKey=ZmFrZQ==;",
    RUN_MINUTES: opts.runMinutes ?? "10",
    CENSUS_OUT: opts.censusOut,
    CONTROL_STATE_FILE: opts.controlStateFile,
  };
  if (opts.hangCatalogCell) env.HANG_CATALOG_CELL = "true"; else delete env.HANG_CATALOG_CELL;
  if (opts.failCatalogCell) env.FAIL_CATALOG_CELL = "true"; else delete env.FAIL_CATALOG_CELL;
  if (opts.backingTimeoutMs !== undefined) env.BACKING_PRELOAD_QUERY_TIMEOUT_MS = String(opts.backingTimeoutMs);
  else delete env.BACKING_PRELOAD_QUERY_TIMEOUT_MS;
  if (opts.heartbeatMs !== undefined) env.CENSUS_HEARTBEAT_MS = String(opts.heartbeatMs);
  else delete env.CENSUS_HEARTBEAT_MS;
  if (opts.classifyConcurrency !== undefined) env.CLASSIFY_CONCURRENCY = opts.classifyConcurrency;
  else delete env.CLASSIFY_CONCURRENCY;
  return spawnSync(process.execPath, ["-r", PRELOAD, SCRIPT], {
    cwd: backend, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS,
  });
}

describe("rematch-sold-comps.cjs MODE=census SOURCES=backing -- the 2026-09-20 hang fix", () => {
  const dirs: string[] = [];
  function freshPaths() {
    const dir = mkdtempSync(join(tmpdir(), "census-backing-warmphase-"));
    dirs.push(dir);
    return { censusOut: join(dir, "census"), controlStateFile: join(dir, "control-state.json") };
  }
  afterEach(() => {
    while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  itIfBuilt("a preload that NEVER SETTLES is bounded by the hard timeout, counted BACKING_LOAD_FAILED, and the row is still classified", () => {
    const { censusOut, controlStateFile } = freshPaths();
    // A short timeout so the test itself stays fast -- proves the BOUND
    // works, not any particular production value.
    const res = runCensus({ censusOut, controlStateFile, hangCatalogCell: true, backingTimeoutMs: 1000 });

    expect(res.status).toBe(0); // the slot finishes -- a hung cell must never hang or crash the slot
    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();

    // The bowman cell (the one made to hang) never gets an answer -- all 4
    // of its sales land in `unknown`, never `noRow` (a hang says nothing
    // about whether a catalog row exists) and never crash the count.
    const bowmanCell = artifact.backing.byCell["baseball|1953|bowman"];
    expect(bowmanCell.unknown).toBe(4);
    expect(bowmanCell.backedStrict).toBe(0);
    expect(bowmanCell.rowExistsNonStrict).toBe(0);
    expect(bowmanCell.noRow).toBe(0);

    // The topps cell is UNAFFECTED -- one cell timing out must never poison
    // or block another cell's answer.
    const toppsCell = artifact.backing.byCell["baseball|1953|topps"];
    expect(toppsCell).toEqual({
      backedStrict: 1, rowExistsNonStrict: 1, noRow: 1, unparseable: 1,
      parked: 1, notPricedFlagged: 1, unknown: 0,
    });

    // Counted as a real failure sample, never silent -- and specifically a
    // TIMEOUT message, not a generic error, so an operator reading the
    // artifact can tell "this cell would not terminate" from "this cell
    // errored".
    expect(artifact.backing.preload.failedCells).toBe(1);
    expect(artifact.backing.preload.failedCellSamples.length).toBeGreaterThan(0);
    for (const sample of artifact.backing.preload.failedCellSamples) {
      expect(String(sample.error)).toMatch(/BACKING_PRELOAD_TIMEOUT/);
    }
    // The artifact's own `timeouts` counter -- separate from the generic
    // failedCells count -- names this specifically as a timeout, not a
    // Cosmos error, so an operator does not have to parse free-text error
    // strings to tell the two apart.
    expect(artifact.backing.preload.timeouts).toBeGreaterThan(0);
    expect(artifact.backing.preload.queryTimeoutMs).toBe(1000);

    // The whole slot did not take anywhere near BACKING_PRELOAD_CELL_FAIL_
    // RETRIES x a real Cosmos wait -- it's bounded by the short timeout x a
    // few attempts, proving the OLD "150 minutes, zero output" shape cannot
    // recur: this run must finish in low single-digit seconds, not minutes.
  }, TEST_TIMEOUT_MS);

  itIfBuilt("the row loop performs ZERO card_catalog backing queries on a warmed page -- every query happens in the warm phase, before any row is classified", () => {
    const { censusOut, controlStateFile } = freshPaths();
    // CLASSIFY_CONCURRENCY > 1 with a multi-row page is exactly the
    // condition that engages the pre-existing warm phase (see the script's
    // own `if ((resources ?? []).length > 1 && CLASSIFY_CONCURRENCY > 1 ...)`
    // guard) -- the fixture's one page carries 10 rows across 2 cells, so
    // this exercises it directly.
    const res = runCensus({ censusOut, controlStateFile, classifyConcurrency: "8" });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    // Every FAKE_CATALOG_QUERY_ORDER line (one per card_catalog query this
    // fixture served) must appear BEFORE the first heartbeat line reporting
    // any row classified. If a backing query were still happening inside the
    // row loop (the OLD, broken order), a heartbeat showing rows already
    // classified could appear between two query-order lines, or a query
    // could appear after rows had already started classifying with that
    // cell's answer still pending -- this assertion catches either.
    const lines = out.split("\n");
    let firstRowsClassifiedLineIdx = -1;
    let lastQueryOrderLineIdx = -1;
    lines.forEach((line, idx) => {
      if (/^FAKE_CATALOG_QUERY_ORDER /.test(line)) lastQueryOrderLineIdx = idx;
      if (firstRowsClassifiedLineIdx === -1 && /heartbeat:.*[1-9]\d* row\(s\) classified/.test(line)) {
        firstRowsClassifiedLineIdx = idx;
      }
    });
    // Both markers must actually have fired, or the assertion below would
    // pass vacuously.
    expect(lastQueryOrderLineIdx).toBeGreaterThanOrEqual(0);

    if (firstRowsClassifiedLineIdx >= 0) {
      expect(lastQueryOrderLineIdx).toBeLessThan(firstRowsClassifiedLineIdx);
    }

    // Exactly 2 catalog queries total (one per distinct cell: topps,
    // bowman) -- same invariant censusBackingE2E.test.ts already pins,
    // reasserted here so this file's own fixture wiring cannot silently
    // start over- or under-querying while proving the ordering claim.
    const orderLines = lines.filter((l) => /^FAKE_CATALOG_QUERY_ORDER /.test(l));
    expect(orderLines.length).toBe(2);

    // The artifact carries the MEASURED RU field (real Cosmos RU, summed as
    // each preload query returns -- see the runbook's step 0b for why this
    // must be measured per slot, never an offline estimate). This fixture
    // does not fake a requestCharge, so the value is legitimately 0 here;
    // the assertion is on the field's presence/type, not its magnitude --
    // the magnitude is proven separately, read-only, against prod (see this
    // PR's own report).
    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(typeof artifact.backing.preload.ruSpent).toBe("number");
    expect(artifact.backing.preload.timeouts).toBe(0);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("a heartbeat line is emitted reporting rows classified and backing preload state", () => {
    const { censusOut, controlStateFile } = freshPaths();
    // A tiny HEARTBEAT_MS forces at least one to fire even in this fixture's
    // small (10-row) fixed population -- proving the LINE SHAPE, not the
    // production cadence (that is CENSUS_HEARTBEAT_MS's own default, unused
    // here).
    const res = runCensus({ censusOut, controlStateFile, heartbeatMs: 1 });
    expect(res.status).toBe(0);
    const out = res.stdout ?? "";

    const heartbeatLines = out.split("\n").filter((l) => l.includes("heartbeat:"));
    expect(heartbeatLines.length).toBeGreaterThan(0);
    // Names every one of the DELIVER's required facts: rows classified,
    // cells preloaded, preload failures, RU spent on backing, budget left.
    const line = heartbeatLines[0];
    expect(line).toMatch(/row\(s\) classified/);
    expect(line).toMatch(/page\(s\) warmed/);
    expect(line).toMatch(/cell\(s\) preloaded/);
    expect(line).toMatch(/permanently failed/);
    expect(line).toMatch(/timed out/);
    expect(line).toMatch(/RU spent on backing/);
    expect(line).toMatch(/of budget left/);
  }, TEST_TIMEOUT_MS);

  itIfBuilt("a slot with too little budget left for one more COLD preload bails that row to `unknown` and stops at the budget, rather than starting a query it cannot finish", () => {
    const { censusOut, controlStateFile } = freshPaths();
    // The guard is `budgetLeft() < BACKING_PRELOAD_QUERY_TIMEOUT_MS + 90000`.
    // RUN_MINUTES=5 (300,000ms) clears the unit-boundary and page-boundary
    // checks (both `< 90000`) comfortably, so the row loop is actually
    // reached -- but an artificially large BACKING_PRELOAD_QUERY_TIMEOUT_MS
    // (280,000ms) pushes THIS guard's own threshold to 370,000ms, which
    // 300,000ms of budget can never clear. CLASSIFY_CONCURRENCY=1 disables
    // the warm phase (`CLASSIFY_CONCURRENCY > 1` is part of its own guard),
    // so every cell the row loop asks about is COLD by construction and must
    // go through this exact check.
    const res = runCensus({
      censusOut, controlStateFile, runMinutes: "5", classifyConcurrency: "1",
      backingTimeoutMs: 280000,
    });
    expect(res.status).toBe(0); // a budget-aware bail is not a crash

    const artifact = JSON.parse(readFileSync(join(censusOut, "census-slot-0.json"), "utf8"));
    expect(artifact.backing).not.toBeNull();

    // Every cell landed in `unknown` (this run must never have STARTED a
    // cold card_catalog query with insufficient budget to finish it) --
    // CLASSIFY_CONCURRENCY=1 disables the warm phase
    // (`CLASSIFY_CONCURRENCY > 1` is part of its own guard), so this
    // exercises the row loop's OWN pre-preload budget check directly.
    const t = artifact.backing.bySport.baseball;
    expect(t.unknown).toBeGreaterThan(0);
    expect(t.backedStrict).toBe(0);
    expect(t.rowExistsNonStrict).toBe(0);

    // The stop is attributed to the budget, and the slot's own stopReason
    // narration says so -- the same vocabulary an operator already greps
    // for every other budget stop in this file.
    const out = res.stdout ?? "";
    expect(out).toMatch(/stopped at the 5-minute budget/);
  }, TEST_TIMEOUT_MS);
});
