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
 * it ever reached the classify loop, which is exactly the bug the first
 * draft of this fixture had), sport=baseball, 5 rows -- blank titles
 * (deriveIdentity -> UNDERIVABLE, no parser dependency), all in the SAME
 * (baseball, 1953, topps) cell:
 *   row 1  hobbyiqCardId hiq:baseball:1953:topps:1:base:no-auto   -> catalog row, source "beckett"    (strict)
 *   row 2  hobbyiqCardId hiq:baseball:1953:topps:2:base:no-auto   -> catalog row, source "cardhedge"  (row exists, not strict)
 *   row 3  hobbyiqCardId hiq:baseball:1953:topps:3:base:no-auto   -> no catalog row at all             (noRow)
 *   row 4  hobbyiqCardId null                                     -> no id to look up                 (unparseable)
 *   row 5  identityUnverified: true                                -> parked, never reaches the lookup
 *
 * card_catalog is queried ONCE (this fixture counts every `items.query` call
 * and echoes the total to stdout on process exit) for the whole cell --
 * proving 5 sales cost ONE projected query, never five point reads.
 */
"use strict";
const path = require("path");

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
];

let catalogQueryCount = 0;

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
        // backingCellPreloadRaw calls `.query(...).fetchAll()` -- the same
        // method checklistCells/flagshipNumbers/etc. already call on this
        // container -- so the fake must implement fetchAll(), not just the
        // fetchNext()-only iterator sold_comps's fixture uses.
        query: (spec) => {
          catalogQueryCount++;
          const sk = (spec.parameters ?? []).find((p) => p.name === "@sk")?.value;
          const rows = sk === "topps" ? CATALOG_ROWS : [];
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
  // Echoed as its own line so the test can assert on the query count
  // without a second IPC channel -- the child process's stdout is already
  // captured by spawnSync.
  process.stdout.write(`FAKE_CATALOG_QUERY_COUNT ${catalogQueryCount}\n`);
});

const azureCosmosPath = require.resolve("@azure/cosmos", { paths: [path.join(__dirname, "..", "..", "..", "scripts")] });
require.cache[azureCosmosPath] = {
  id: azureCosmosPath, filename: azureCosmosPath, loaded: true, exports: { CosmosClient: FakeCosmosClient },
};
