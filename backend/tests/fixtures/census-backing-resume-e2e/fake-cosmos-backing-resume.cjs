#!/usr/bin/env node
/**
 * Preload script for censusBackingE2E.test.ts's resume scenario ("SOURCES=
 * backing survives a stop-mid-shard resume"). Combines the two existing
 * fixtures' mechanisms rather than extending either in place, so neither
 * pre-existing suite (rematchCensusCursorE2E.test.ts,
 * censusBackingE2E.test.ts) is put at risk by a shared file:
 *   - fixtures/census-cursor-e2e/fake-cosmos-preload.cjs's TWO-UNIT SHAPE:
 *     `sold_comps` split into slot 0's OWN measured shard units
 *     (`y=2025/s=pokemon`, `y=1953`), and `rematch_control` PERSISTED TO
 *     CONTROL_STATE_FILE so a second child process reads the first's cursor.
 *     UNLIKE that fixture, the stop between units here is driven by the
 *     caller's LIMIT env var, never a simulated slow fetch -- see the test
 *     file's own header for why an artificial budget squeeze cannot be used
 *     here without ALSO tripping the backing preload's own, stricter margin
 *     check and bucketing unit A's sales `unknown` instead of exercising the
 *     resume.
 *   - fixtures/census-backing-e2e/fake-cosmos-backing.cjs's `card_catalog`
 *     BY-ID-PREFIX preload: unit A's 3 rows live in ONE cell
 *     (pokemon|2025|some-set), unit B's 2 rows in a SEPARATE cell
 *     (baseball|1953|topps), so pass 1 (unit A only) and pass 2 (unit B only)
 *     each preload a DIFFERENT cell -- proving a resumed pass's own live
 *     tally (this pass's own cell) is additive with the MERGED-IN prior
 *     pass's tally (the other cell), never one overwriting the other.
 *
 * Row shape: blank titles (deriveIdentity -> UNDERIVABLE, no parser
 * dependency), one card_catalog row for unit A's first sale (backedStrict),
 * none for the rest of unit A (noRow x2) or any of unit B (noRow x2) -- kept
 * deliberately small; the point of this fixture is the CHECKPOINT arithmetic,
 * not the bucket variety (censusBackingE2E.test.ts's own fixture already
 * covers every bucket).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CONTROL_STATE_FILE = process.env.CONTROL_STATE_FILE;
if (!CONTROL_STATE_FILE) throw new Error("CONTROL_STATE_FILE must be set for the fake cosmos preload");

function loadControlState() {
  try { return JSON.parse(fs.readFileSync(CONTROL_STATE_FILE, "utf8")); } catch { return {}; }
}
function saveControlState(state) {
  fs.mkdirSync(path.dirname(CONTROL_STATE_FILE), { recursive: true });
  fs.writeFileSync(CONTROL_STATE_FILE, JSON.stringify(state), "utf8");
}

// Unit A: (pokemon, 2025, some-set) -- 3 sales, one backed, two not.
const UNIT_A_ROWS = [
  { id: "unitA-1", cardId: "hiq:pokemon:2025:some-set:1:base:no-auto", hobbyiqCardId: "hiq:pokemon:2025:some-set:1:base:no-auto", title: "", sport: "pokemon", cardYear: 2025, setKey: "some-set", setName: "Some Set", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "unitA-2", cardId: "hiq:pokemon:2025:some-set:2:base:no-auto", hobbyiqCardId: "hiq:pokemon:2025:some-set:2:base:no-auto", title: "", sport: "pokemon", cardYear: 2025, setKey: "some-set", setName: "Some Set", cardNumber: "2", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "unitA-3", cardId: "hiq:pokemon:2025:some-set:3:base:no-auto", hobbyiqCardId: "hiq:pokemon:2025:some-set:3:base:no-auto", title: "", sport: "pokemon", cardYear: 2025, setKey: "some-set", setName: "Some Set", cardNumber: "3", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
];
// Unit B: (baseball, 1953, topps) -- 2 sales, both noRow.
const UNIT_B_ROWS = [
  { id: "unitB-1", cardId: "hiq:baseball:1953:topps:1:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:1:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
  { id: "unitB-2", cardId: "hiq:baseball:1953:topps:2:base:no-auto", hobbyiqCardId: "hiq:baseball:1953:topps:2:base:no-auto", title: "", sport: "baseball", cardYear: 1953, setKey: "topps", setName: "Topps", cardNumber: "2", parallel: "Base", isAuto: false, printRun: null, source: "cardhedge" },
];
// Exactly one catalog row, strict-sourced, under unit A's cell -- unit B's
// cell (baseball|1953|topps) has NO catalog row at all.
const CATALOG_ROWS = [
  { id: "hiq:pokemon:2025:some-set:1:base:no-auto", source: "beckett", sport: "pokemon" },
];

function rowsForQuery(spec) {
  const years = new Set((spec.parameters ?? []).filter((p) => /^@y/.test(p.name)).map((p) => Number(p.value)));
  const out = [];
  if (years.has(2025)) out.push(...UNIT_A_ROWS);
  if (years.has(1953)) out.push(...UNIT_B_ROWS);
  return out;
}

let catalogQueryCount = 0;

function fakeContainer(name) {
  if (name === "sold_comps") {
    return {
      items: {
        query: (spec) => {
          const rows = rowsForQuery(spec);
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
    return {
      items: {
        upsert: async (doc) => {
          const state = loadControlState();
          state[doc.id] = doc;
          saveControlState(state);
          return { resource: doc };
        },
      },
      item: (id) => ({
        read: async () => {
          const state = loadControlState();
          const d = state[id];
          if (!d) { const e = new Error("not found"); e.code = 404; throw e; }
          return { resource: d };
        },
        delete: async () => {
          const state = loadControlState();
          if (!(id in state)) { const e = new Error("not found"); e.code = 404; throw e; }
          delete state[id];
          saveControlState(state);
          return {};
        },
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
