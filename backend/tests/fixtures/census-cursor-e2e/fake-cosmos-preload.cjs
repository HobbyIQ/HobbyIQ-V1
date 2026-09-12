#!/usr/bin/env node
/**
 * Preload script for the census cursor end-to-end test
 * (rematchCensusCursorE2E.test.ts). Run via `node -r <this file>
 * rematch-sold-comps.cjs`, it injects a FAKE `@azure/cosmos` into
 * require.cache -- resolved from rematch-sold-comps.cjs's own location, so
 * the script's `require("@azure/cosmos")` sees exactly this fake -- before
 * the target script ever loads. This is the only way to exercise the real
 * `main()` end to end: it is not exported (it only runs under
 * `require.main === module`) and constructs its own CosmosClient internally,
 * so the existing test suite's convention of stubbing an exported function's
 * `pool`/`control` argument does not reach it.
 *
 * WHAT IT SERVES. `sold_comps` (the pool): two units' worth of rows, keyed by
 * the FIXTURE_CASE env var:
 *   unit "y=2025/s=pokemon"  cardYear=2025 sport=pokemon   3 rows, BLANK titles
 *   unit "y=1953"            cardYear=1953                 2 rows, BLANK titles
 * A blank title makes deriveIdentity() return {ok:false, reasons:["no-title"]}
 * deterministically -- UNDERIVABLE, no parser/catalog dependency at all -- so
 * the fixture is not coupled to parseTitleIdentity's vocabulary. `card_catalog`
 * answers every read 404 (not found): nothing here needs a checklist match.
 * `rematch_control` is a real in-memory Map PERSISTED TO A JSON FILE at
 * CONTROL_STATE_FILE between the two child-process passes this test runs, so
 * pass 2 reads pass 1's saved cursor exactly as a relaunch reading Cosmos
 * would.
 *
 * THE SIMULATED BUDGET STOP. Unit 1's fetchNext() sleeps SLOW_UNIT_MS
 * (env-set) before returning its 3 rows, so with RUN_MINUTES set small enough
 * that the post-unit-1 budgetLeft() check trips (< 90000ms remaining), the
 * pass stops cleanly AT THE UNIT BOUNDARY -- unit 1 fully classified and
 * marked done, unit 2 never even queried. Pass 2 (no sleep, same
 * RUN_MINUTES/CONTROL_STATE_FILE) then reads the saved cursor, skips unit 1,
 * and classifies only unit 2.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CONTROL_STATE_FILE = process.env.CONTROL_STATE_FILE;
const SLOW_UNIT_MS = Number(process.env.SLOW_UNIT_MS || 0);
if (!CONTROL_STATE_FILE) throw new Error("CONTROL_STATE_FILE must be set for the fake cosmos preload");

function loadControlState() {
  try { return JSON.parse(fs.readFileSync(CONTROL_STATE_FILE, "utf8")); } catch { return {}; }
}
function saveControlState(state) {
  fs.mkdirSync(path.dirname(CONTROL_STATE_FILE), { recursive: true });
  fs.writeFileSync(CONTROL_STATE_FILE, JSON.stringify(state), "utf8");
}

const UNIT_A_ROWS = [1, 2, 3].map((n) => ({
  id: `unitA-${n}`, cardId: `hiq:pokemon:2025:some-set:${n}:base:no-auto`,
  hobbyiqCardId: `hiq:pokemon:2025:some-set:${n}:base:no-auto`,
  title: "", sport: "pokemon", cardYear: 2025, setName: "Some Set",
  cardNumber: String(n), parallel: "Base", isAuto: false, printRun: null,
  source: "cardhedge",
}));
const UNIT_B_ROWS = [1, 2].map((n) => ({
  id: `unitB-${n}`, cardId: `hiq:baseball:1953:topps:${n}:base:no-auto`,
  hobbyiqCardId: `hiq:baseball:1953:topps:${n}:base:no-auto`,
  title: "", sport: "baseball", cardYear: 1953, setName: "Topps",
  cardNumber: String(n), parallel: "Base", isAuto: false, printRun: null,
  source: "cardhedge",
}));

/** Which fixture unit a Cosmos SQL predicate string is asking for. The real
 *  query text is `SELECT * FROM c WHERE (c.cardYear = @y0 AND c.sport =
 *  @s0) OR (c.cardYear = @y1)` (or just one half if resuming past the
 *  other) -- so this fake keys off the PARAMETER VALUES, not the SQL shape,
 *  matching what unitPredicate() actually binds. */
function rowsForQuery(spec) {
  const years = new Set((spec.parameters ?? []).filter((p) => /^@y/.test(p.name)).map((p) => Number(p.value)));
  const out = [];
  if (years.has(2025)) out.push(...UNIT_A_ROWS);
  if (years.has(1953)) out.push(...UNIT_B_ROWS);
  return out;
}

function fakeContainer(name) {
  if (name === "sold_comps") {
    return {
      items: {
        query: (spec) => {
          const rows = rowsForQuery(spec);
          const isUnitA = rows === UNIT_A_ROWS || (rows.length && rows[0].id.startsWith("unitA"));
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: async () => {
              served = true;
              if (isUnitA && SLOW_UNIT_MS > 0) await new Promise((r) => setTimeout(r, SLOW_UNIT_MS));
              return { resources: rows };
            },
          };
        },
      },
      item: () => ({ read: async () => { const e = new Error("not found"); e.code = 404; throw e; } }),
    };
  }
  if (name === "card_catalog") {
    return {
      items: { query: () => ({ fetchNext: async () => ({ resources: [] }) }) },
      item: () => ({ read: async () => { const e = new Error("not found"); e.code = 404; throw e; } }),
    };
  }
  if (name === "rematch_control") {
    return {
      items: {
        // FAIL_CURSOR_UPSERT (2026-09-12): simulates run 34658848883 slot 3's
        // real failure -- the container-level 404 -- so rematchCensusCursor
        // SaveFailureE2E.test.ts can drive the ACTUAL caller-side checkpoint
        // block in main() (not a re-implementation of it) through a save that
        // fails, and assert on what reaches stdout and the process exit code.
        upsert: async (doc) => {
          if (process.env.FAIL_CURSOR_UPSERT === "true") {
            const e = new Error('Resource Not Found. Learn more: https://aka.ms/cosmosdb-tsg-not-found');
            e.code = 404;
            throw e;
          }
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
    // getOrCreateControlContainer (rematch-sold-comps.cjs, 2026-09-12) calls
    // `containers.createIfNotExists` instead of a bare `.container()` lookup,
    // to fix the real defect this fixture predates: `rematch_control` was
    // never actually provisioned in Cosmos, so every lazy `.container()`
    // reference 404'd on first use. This fake's `rematch_control` container
    // is always "present" (an in-memory Map), so createIfNotExists is a
    // straight pass-through -- it exists ONLY so the real call shape resolves
    // under this fixture rather than throwing "not a function".
    containers: { createIfNotExists: async (spec) => ({ container: fakeContainer(spec.id) }) },
  });
  this.dispose = async () => {};
}

const azureCosmosPath = require.resolve("@azure/cosmos", { paths: [path.join(__dirname, "..", "..", "..", "scripts")] });
require.cache[azureCosmosPath] = {
  id: azureCosmosPath, filename: azureCosmosPath, loaded: true, exports: { CosmosClient: FakeCosmosClient },
};
