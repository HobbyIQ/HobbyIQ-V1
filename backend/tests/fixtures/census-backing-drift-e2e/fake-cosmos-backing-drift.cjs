#!/usr/bin/env node
/**
 * Preload script for the census backing STORED-FIELD DRIFT fix
 * (censusBackingDriftE2E.test.ts). Same `require.cache` injection technique
 * as fixtures/census-backing-e2e/fake-cosmos-backing.cjs -- this fixture is
 * scoped narrowly to the 2026-09-27 defect: a sale whose stored `setName`
 * normalises (era-blind, via `normalizeSetKey`, which takes no year) to a
 * DIFFERENT setKey than the one embedded in its own `hobbyiqCardId` (minted
 * WITH the year, via `spellForEra`).
 *
 * `sold_comps`: one unit, cardYear=1953 (slot 0's OWN measured shard unit --
 * see data/rematch-shard-table.json slot 0, `y=1953`), sport=baseball:
 *
 *   row d1  hobbyiqCardId hiq:baseball:1953:donruss:35:base:no-auto
 *           setName "Donruss" (normalizes era-blind to "panini-donruss",
 *           the REAL 2026-09-27 defect shape: a pre-modern-era Donruss sale
 *           whose stored setName-derived spelling disagrees with its own
 *           id) -- a card_catalog row EXISTS at the id's real cell
 *           (donruss), strict-sourced. Must count backedStrict (the cell is
 *           read off the id) AND bump storedFieldDrift (the id and the
 *           setName-derived stored triple disagree).
 *   row d2  hobbyiqCardId hiq:baseball:1953:topps:9:base:no-auto, setName
 *           "Topps" (normalizes to "topps" -- AGREES with the id). No
 *           catalog row at this id. Must count noRow and must NOT bump
 *           storedFieldDrift -- the control row proving drift is not
 *           over-counted for a row that agrees.
 *   row d3  hobbyiqCardId null. Must stay unparseable and must NOT bump
 *           storedFieldDrift -- there is no id-side answer to disagree with
 *           `stored` when there is no id at all.
 *
 * card_catalog is queried by ID PREFIX (STARTSWITH(c.id, @prefix)), exactly
 * like the sibling fixture -- keyed off the `@prefix` parameter, never a
 * setKey FIELD equality, so a regression to field-equality would return the
 * wrong (or no) rows for the `donruss` prefix this test asserts on.
 */
"use strict";
const path = require("path");

const CATALOG_ROWS = [
  { id: "hiq:baseball:1953:donruss:35:base:no-auto", source: "beckett", sport: "baseball" },
];

const SOLD_COMPS_ROWS = [
  {
    id: "d1", cardId: "hiq:baseball:1953:donruss:35:base:no-auto",
    hobbyiqCardId: "hiq:baseball:1953:donruss:35:base:no-auto",
    title: "", sport: "baseball", cardYear: 1953, setKey: "donruss",
    setName: "Donruss", cardNumber: "35", parallel: "Base", isAuto: false,
    printRun: null, source: "cardhedge",
  },
  {
    id: "d2", cardId: "hiq:baseball:1953:topps:9:base:no-auto",
    hobbyiqCardId: "hiq:baseball:1953:topps:9:base:no-auto",
    title: "", sport: "baseball", cardYear: 1953, setKey: "topps",
    setName: "Topps", cardNumber: "9", parallel: "Base", isAuto: false,
    printRun: null, source: "cardhedge",
  },
  {
    id: "d3", cardId: "hiq:baseball:1953:topps:10:base:no-auto",
    hobbyiqCardId: null,
    title: "", sport: "baseball", cardYear: 1953, setKey: "topps",
    setName: "Topps", cardNumber: "10", parallel: "Base", isAuto: false,
    printRun: null, source: "cardhedge",
  },
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
        query: (spec) => {
          catalogQueryCount++;
          const prefix = (spec.parameters ?? []).find((p) => p.name === "@prefix")?.value;
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
  process.stdout.write(`FAKE_CATALOG_QUERY_COUNT ${catalogQueryCount}\n`);
});

const azureCosmosPath = require.resolve("@azure/cosmos", { paths: [path.join(__dirname, "..", "..", "..", "scripts")] });
require.cache[azureCosmosPath] = {
  id: azureCosmosPath, filename: azureCosmosPath, loaded: true, exports: { CosmosClient: FakeCosmosClient },
};
