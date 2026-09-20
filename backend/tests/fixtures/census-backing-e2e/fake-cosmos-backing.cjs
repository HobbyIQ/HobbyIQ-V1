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

let catalogQueryCount = 0;
let bowmanCellQueryCount = 0;

function fakeContainer(name) {
  if (name === "sold_comps") {
    return {
      items: {
        query: (spec) => {
          const years = new Set((spec.parameters ?? []).filter((p) => /^@y/.test(p.name)).map((p) => Number(p.value)));
          const rows = years.has(1953) ? SOLD_COMPS_ROWS : [];
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
        query: (spec) => {
          const prefix = (spec.parameters ?? []).find((p) => p.name === "@prefix")?.value;
          if (FAIL_CATALOG_CELL && prefix === FAILING_PREFIX) {
            bowmanCellQueryCount++;
            return {
              hasMoreResults: () => true,
              fetchAll: async () => { throw new Error(`simulated card_catalog outage for ${prefix}`); },
              fetchNext: async () => { throw new Error(`simulated card_catalog outage for ${prefix}`); },
            };
          }
          catalogQueryCount++;
          const rows = CATALOG_ROWS.filter((r) => r.id.startsWith(prefix ?? " "));
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
