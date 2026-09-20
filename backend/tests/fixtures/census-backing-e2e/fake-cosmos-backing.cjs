#!/usr/bin/env node
/**
 * Preload script for the census backing-count end-to-end test
 * (censusBackingE2E.test.ts). Same `require.cache` injection technique as
 * fixtures/census-cursor-e2e/fake-cosmos-preload.cjs, built separately
 * because this test's whole point is exercising REAL `card_catalog` reads --
 * the cursor fixture always answers `card_catalog` 404, which would prove
 * nothing about the backing preload's query shape or its answers.
 *
 * `sold_comps`: one unit, cardYear=1953 (slot 0's OWN measured shard unit --
 * see data/rematch-shard-table.json slot 0, `y=1953`, any sport -- a row
 * with a different year/sport would be filtered out by `rowInSlot` before
 * it ever reached the classify loop), sport=baseball, 10 rows -- blank
 * titles (deriveIdentity -> UNDERIVABLE, no parser dependency). Six sit in
 * the (baseball, 1953, topps) cell (a normal, successfully-loading cell);
 * FOUR sit in a SEPARATE (baseball, 1953, bowman) cell used only to
 * exercise the load-failure path -- four sales, not one, because the retry
 * budget (BACKING_PRELOAD_CELL_FAIL_RETRIES) is spent one attempt PER SALE
 * OF THE CELL, never in a tight loop by the preload itself; a single-sale
 * cell can only ever produce ONE attempt no matter how the retry budget is
 * configured, so proving "retried up to K times, THEN marked permanently
 * failed" needs at least K sales sharing the failing cell:
 *   row 1  hiq:baseball:1953:topps:1:base:no-auto    -> catalog row, source "beckett"    (strict)
 *   row 2  hiq:baseball:1953:topps:2:base:no-auto    -> catalog row, source "cardhedge"  (row exists, not strict)
 *   row 3  hiq:baseball:1953:topps:3:base:no-auto    -> no catalog row at all             (noRow)
 *   row 4  hobbyiqCardId null                        -> no id to look up                 (unparseable)
 *   row 5  identityUnverified: true                  -> parked, never reaches the lookup
 *   row 6  flaggedWrong: true                        -> notPricedFlagged, never reaches the lookup
 *   rows 7-10  hiq:baseball:1953:bowman:1..4:base:no-auto -> all four in the SEPARATE
 *          bowman cell, whose card_catalog query is made to fail EVERY
 *          attempt when FAIL_CATALOG_CELL=true (no row exists for bowman in
 *          CATALOG_ROWS either way, so a successful load would answer noRow
 *          for all four -- the failure test asserts `unknown`, never noRow,
 *          which is exactly the distinction this fix exists to prove)
 *
 * card_catalog is queried by ID PREFIX (STARTSWITH(c.id, @prefix)), matching
 * the corrected preload -- the fixture keys its canned rows off the
 * `@prefix` parameter, never off a `setKey` FIELD equality, so a fixture
 * bug that regresses to field-equality would be caught by a query for the
 * wrong prefix returning the wrong (or no) rows.
 *
 * FAIL_CATALOG_CELL=true makes the bowman cell's query throw on every
 * attempt (a permanent failure, exercising BACKING_PRELOAD_CELL_FAIL_RETRIES
 * exhaustion); unset, every query succeeds normally (and answers noRow for
 * bowman, since CATALOG_ROWS holds no bowman entries).
 */
"use strict";
const path = require("path");

const FAIL_CATALOG_CELL = process.env.FAIL_CATALOG_CELL === "true";
const FAILING_PREFIX = "hiq:baseball:1953:bowman:";
// A cell whose query NEVER settles -- the fixture's own stand-in for the
// real defect this PR fixes (a Cosmos SDK query that spins forever). Used to
// prove the hard timeout actually bounds the wait rather than hanging the
// test process itself, which is why it is a SEPARATE knob from
// FAIL_CATALOG_CELL (a load that throws) -- a promise that never resolves is
// a different failure shape than one that rejects, and this PR's whole point
// is that the OLD code had no way to bound the former at all.
const HANG_CATALOG_CELL = process.env.HANG_CATALOG_CELL === "true";
const HANGING_PREFIX = "hiq:baseball:1953:bowman:";
// A cell whose query resolves FOREVER via MICROTASKS ONLY -- never a real
// timer, never a real socket wait -- reproducing the ACTUAL 2026-09-20
// defect this PR's spin guard exists for: `maxItemCount: -1` cross-partition
// DISTINCT resolves fetchNext() IMMEDIATELY with 0 rows/0 RU on every page,
// with no macrotask tick between pages at all. A `setTimeout`-based timeout
// (withHardTimeout) provably CANNOT fire against this (confirmed
// independently: a timer registered before a tight microtask-only loop never
// runs, because Node's timer phase only runs BETWEEN macrotasks and a
// microtask loop never yields one) -- so this knob is what proves the
// SYNCHRONOUS in-loop spin guard is the thing that actually stops it, not
// HANG_CATALOG_CELL above (which resolves via a real unsettled Promise that
// IS subject to the timer phase once something else in the process ticks the
// event loop, which is a materially different, easier failure shape).
const SPIN_CATALOG_CELL = process.env.SPIN_CATALOG_CELL === "true";
const SPINNING_PREFIX = "hiq:baseball:1953:bowman:";
// Row-budgeted eviction scenario (2026-09-20 per review). When set, adds N
// SYNTHETIC large cells (`hiq:baseball:1953:big-<i>:`) each returning
// BIG_CELL_ROWS canned rows, so a test can drive the row-budget eviction
// path with real cell sizes under its control without needing prod-scale
// fixture data. Independent of CATALOG_ROWS/the topps/bowman cells above.
const BIG_CELLS = Math.max(0, Number(process.env.BIG_CELLS || 0));
const BIG_CELL_ROWS = Math.max(0, Number(process.env.BIG_CELL_ROWS || 0));

const CATALOG_ROWS = [
  { id: "hiq:baseball:1953:topps:1:base:no-auto", source: "beckett", sport: "baseball" },
  { id: "hiq:baseball:1953:topps:2:base:no-auto", source: "cardhedge", sport: "baseball" },
];

const SOLD_COMPS_ROWS = [
  { id: "s1", cardId: "hiq:baseball:1953:topps:1:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:1:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s2", cardId: "hiq:baseball:1953:topps:2:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:2:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "2", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s3", cardId: "hiq:baseball:1953:topps:3:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:3:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "3", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s4", cardId: "hiq:baseball:1953:topps:4:base:no-auto", hobbyiqCardId: null, title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "4", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s5", cardId: "hiq:baseball:1953:topps:5:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:5:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "5", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge", identityUnverified: true },
  { id: "s6", cardId: "hiq:baseball:1953:topps:6:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:6:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "6", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge", flaggedWrong: true },
  { id: "s7", cardId: "hiq:baseball:1953:bowman:1:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:bowman:1:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "bowman", setName: "Bowman", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s8", cardId: "hiq:baseball:1953:bowman:2:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:bowman:2:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "bowman", setName: "Bowman", cardNumber: "2", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s9", cardId: "hiq:baseball:1953:bowman:3:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:bowman:3:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "bowman", setName: "Bowman", cardNumber: "3", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "s10", cardId: "hiq:baseball:1953:bowman:4:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:bowman:4:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "bowman", setName: "Bowman", cardNumber: "4", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
];

// One synthetic sold_comps row per BIG_CELLS cell (`big-0`, `big-1`, ...),
// each naming its OWN card number so distinct sales never collide -- the
// warm phase's cell-distinct-ness only needs ONE row per cell to trigger a
// preload of that whole (large, BIG_CELL_ROWS-row) cell.
const BIG_SOLD_COMPS_ROWS = Array.from({ length: BIG_CELLS }, (_, i) => ({
  id: `big-s${i}`,
  cardId: `hiq:baseball:1953:big-${i}:0:base:no-auto`,
  hobbyiqCardId: `hiq:baseball:1953:big-${i}:0:base:no-auto`,
  title: "", sport: "baseball", cardYear: 1953, setKey: `big-${i}`, setName: `Big ${i}`,
  cardNumber: "0", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge",
}));

let catalogQueryCount = 0;
let bowmanCellQueryCount = 0;

function fakeContainer(name) {
  if (name === "sold_comps") {
    return {
      items: {
        query: (spec) => {
          const years = new Set((spec.parameters ?? []).filter((p) => /^@y/.test(p.name)).map((p) => Number(p.value)));
          const rows = years.has(1953) ? SOLD_COMPS_ROWS.concat(BIG_SOLD_COMPS_ROWS) : [];
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: async () => { served = true; return { resources: rows }; },
          };
        },
      },
      item: () => ({ read: async () => { const e = new Error("not found"); e.code = 404; throw e; } }),
    };
  }
  if (name === "card_catalog") {
    return {
      items: {
        // backingCellPreloadRaw calls `.query(...).fetchAll()` with a
        // STARTSWITH(c.id, @prefix) predicate -- the fixture keys its
        // response off the `@prefix` parameter's VALUE, matching the
        // corrected id-prefix design (never a `@sk`/setKey-field match).
        query: (spec, feedOptions) => {
          const prefix = (spec.parameters ?? []).find((p) => p.name === "@prefix")?.value;
          // ORDER MARKER (2026-09-20, the warm-phase pin). Printed for EVERY
          // BACKING-PRELOAD card_catalog query this fixture serves (i.e. one
          // keyed by `@prefix` -- the pre-existing, unrelated
          // `clashSubsetsFor(stored)` baseline query the ordinary classify
          // path already issues per product uses a DIFFERENT parameter shape
          // and is deliberately excluded here, or this marker would count
          // the wrong query and make the ordering assertion meaningless),
          // success or failure, BEFORE the fixture does anything else -- so a
          // test can grep stdout and assert every one of these lines landed
          // before the classify loop's first "rows classified > 0"
          // heartbeat, proving the preload happened in the warm phase and
          // not inside the row loop's own per-row await.
          if (prefix !== undefined) process.stdout.write(`FAKE_CATALOG_QUERY_ORDER ${prefix}\n`);
          if (SPIN_CATALOG_CELL && prefix === SPINNING_PREFIX) {
            // THE ACTUAL 2026-09-20 DEFECT, REPRODUCED: hasMoreResults() is
            // permanently true, and fetchNext() resolves via Promise.resolve()
            // ONLY -- a microtask, never a macrotask -- with 0 resources and 0
            // requestCharge every single time, exactly matching the
            // reviewer's own repro (1.3M empty pages in 8s). No setTimeout,
            // no real I/O, nothing that would ever let a registered timer's
            // phase run. If withHardTimeout's Promise.race/AbortController
            // were the only guard, this call would never return and the test
            // itself would hang until vitest's own test timeout -- the
            // in-loop spin guard inside backingCellPreloadRaw's `runOnce` is
            // what has to catch this, checked synchronously every iteration.
            return {
              hasMoreResults: () => true,
              fetchNext: () => Promise.resolve({ resources: [], requestCharge: 0 }),
            };
          }
          if (HANG_CATALOG_CELL && prefix === HANGING_PREFIX) {
            // Simulates the ACTUAL defect this PR fixes: a query whose
            // promise never settles (the real bug was `maxItemCount: -1`
            // cross-partition DISTINCT spinning forever at 0 RU/0 rows per
            // page -- see backingCellPreloadRaw's own comment). A fixture
            // that just throws would only prove the pre-existing failure
            // path; this proves the NEW hard timeout actually bounds an
            // unresolved promise. `feedOptions.abortSignal`, if the
            // implementation wires it through (it does), fires this handle's
            // own reject on abort -- exactly what a real Cosmos abort would
            // do -- so the hang does not outlive the timeout even in-process.
            bowmanCellQueryCount++;
            return {
              hasMoreResults: () => true,
              fetchNext: () => new Promise((_resolve, reject) => {
                const signal = feedOptions && feedOptions.abortSignal;
                if (signal) {
                  if (signal.aborted) { reject(new Error("aborted")); return; }
                  signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                }
                // Otherwise: never resolves, never rejects. The test's own
                // process-level timeout is the backstop if the
                // implementation regressed to not wiring abortSignal at all.
              }),
            };
          }
          if (FAIL_CATALOG_CELL && prefix === FAILING_PREFIX) {
            bowmanCellQueryCount++;
            return {
              hasMoreResults: () => true,
              fetchAll: async () => { throw new Error(`simulated card_catalog outage for ${prefix}`); },
              fetchNext: async () => { throw new Error(`simulated card_catalog outage for ${prefix}`); },
            };
          }
          // ROW-BUDGETED EVICTION SCENARIO (2026-09-20 per review). A BIG
          // synthetic cell, `hiq:baseball:1953:big-<i>:` for i in
          // [0, BIG_CELLS), each carrying BIG_CELL_ROWS canned rows -- real
          // ROW COUNTS under the test's control, so the row-budget eviction
          // path (never reachable via the small, fixed topps/bowman
          // fixtures above) can be driven directly. Served across pages of
          // 500 (matching the real maxItemCount), so the test also exercises
          // the STREAMED per-page Map-building path, not a single-page
          // shortcut.
          const bigMatch = /^hiq:baseball:1953:big-(\d+):$/.exec(prefix ?? "");
          if (BIG_CELLS > 0 && bigMatch) {
            catalogQueryCount++;
            const cellIndex = Number(bigMatch[1]);
            const PAGE_SIZE = 500;
            let served = 0;
            return {
              hasMoreResults: () => served < BIG_CELL_ROWS,
              fetchNext: async () => {
                const take = Math.min(PAGE_SIZE, BIG_CELL_ROWS - served);
                const resources = Array.from({ length: take }, (_, j) => {
                  const n = served + j;
                  return { id: `${prefix}${n}:base:no-auto`, source: "cardhedge", sport: "baseball" };
                });
                served += take;
                return { resources, requestCharge: take * 0.1 };
              },
            };
          }
          catalogQueryCount++;
          const rows = CATALOG_ROWS.filter((r) => r.id.startsWith(prefix ?? " "));
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: async () => { served = true; return { resources: rows }; },
            fetchAll: async () => { served = true; return { resources: rows }; },
          };
        },
      },
      item: () => ({ read: async () => { const e = new Error("not found"); e.code = 404; throw e; } }),
    };
  }
  if (name === "rematch_control") {
    const state = new Map();
    return {
      items: { upsert: async (doc) => { state.set(doc.id, doc); return { resource: doc }; } },
      item: (id) => ({
        read: async () => { if (!state.has(id)) { const e = new Error("not found"); e.code = 404; throw e; } return { resource: state.get(id) }; },
        delete: async () => { state.delete(id); return {}; },
      }),
    };
  }
  throw new Error(`fake cosmos: unexpected container "${name}"`);
}

function FakeCosmosClient() {
  this.database = () => ({
    container: (name) => fakeContainer(name),
    containers: { createIfNotExists: async (spec) => ({ container: fakeContainer(spec.id) }) },
  });
  this.dispose = async () => {};
}

process.on("exit", () => {
  // Echoed as their own lines so the test can assert on query counts
  // without a second IPC channel -- the child process's stdout is already
  // captured by spawnSync.
  process.stdout.write(`FAKE_CATALOG_QUERY_COUNT ${catalogQueryCount}\n`);
  process.stdout.write(`FAKE_BOWMAN_CELL_QUERY_COUNT ${bowmanCellQueryCount}\n`);
});

const azureCosmosPath = require.resolve("@azure/cosmos", { paths: [path.join(__dirname, "..", "..", "..", "scripts")] });
require.cache[azureCosmosPath] = {
  id: azureCosmosPath, filename: azureCosmosPath, loaded: true, exports: { CosmosClient: FakeCosmosClient },
};
