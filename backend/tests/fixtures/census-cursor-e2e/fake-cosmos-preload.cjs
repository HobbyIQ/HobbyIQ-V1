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
 *
 * THE SIMULATED MID-UNIT (PAGE) BUDGET STOP (2026-09-12, #2058 follow-up).
 * When UNIT_A_PAGE_ROWS is set, unit A's rows are split into pages of that
 * size instead of being served in one `fetchNext()` -- each page carries a
 * `continuationToken` of the form `"unitA:<nextIndex>"`, and a query issued
 * WITH that token as `continuationToken` in its options resumes from
 * `nextIndex` instead of serving page 1 again, exactly like the real SDK's
 * non-ORDER-BY replay contract this fix relies on (see rematch-sold-comps
 * .cjs's THE CENSUS CURSOR header). SLOW_UNIT_MS then sleeps on EVERY page of
 * unit A (not just its one-and-only page as before), so a small enough
 * RUN_MINUTES trips the budget check strictly BETWEEN two pages, never at
 * the unit's own end -- proving the checkpoint that lands is the mid-unit
 * page cursor, not the coarser unit-done one.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CONTROL_STATE_FILE = process.env.CONTROL_STATE_FILE;
const SLOW_UNIT_MS = Number(process.env.SLOW_UNIT_MS || 0);
// PAGE-CHECKPOINT FIXTURE KNOBS (2026-09-12, #2058 follow-up). Unset (0)
// preserves the original one-page-per-unit behaviour every pre-existing test
// in this suite relies on.
const UNIT_A_ROW_COUNT = Number(process.env.UNIT_A_ROW_COUNT || 3);
const UNIT_A_PAGE_ROWS = Number(process.env.UNIT_A_PAGE_ROWS || 0); // 0 = one page, all rows
if (!CONTROL_STATE_FILE) throw new Error("CONTROL_STATE_FILE must be set for the fake cosmos preload");

function loadControlState() {
  try { return JSON.parse(fs.readFileSync(CONTROL_STATE_FILE, "utf8")); } catch { return {}; }
}
function saveControlState(state) {
  fs.mkdirSync(path.dirname(CONTROL_STATE_FILE), { recursive: true });
  fs.writeFileSync(CONTROL_STATE_FILE, JSON.stringify(state), "utf8");
}

const UNIT_A_ROWS = Array.from({ length: UNIT_A_ROW_COUNT }, (_, i) => i + 1).map((n) => ({
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
        // `spec` carries the query text + parameters, same as `unitPredicate`
        // binds. `options.continuationToken`, when present, is exactly what
        // rematch-sold-comps.cjs's `resumeToken` passes through from a saved
        // `partialUnit.continuationToken` -- honouring it here is what proves
        // the SCRIPT actually threads a resumed token into `items.query`
        // rather than silently discarding it and re-paging from the start.
        query: (spec, options) => {
          const rows = rowsForQuery(spec);
          const isUnitA = rows === UNIT_A_ROWS || (rows.length && rows[0].id.startsWith("unitA"));
          if (isUnitA && UNIT_A_PAGE_ROWS > 0) {
            // Multi-page unit A. A continuation token is this fake's own
            // opaque string "unitA:<nextIndex>" -- never inspected by the
            // real script, only round-tripped, matching how an actual Cosmos
            // token is opaque to callers.
            let nextIndex = 0;
            const startToken = options && options.continuationToken;
            if (startToken) {
              const m = /^unitA:(\d+)$/.exec(String(startToken));
              if (!m) throw new Error(`fake cosmos: unrecognised continuation token "${startToken}"`);
              nextIndex = Number(m[1]);
            }
            return {
              hasMoreResults: () => nextIndex < rows.length,
              fetchNext: async () => {
                if (SLOW_UNIT_MS > 0) await new Promise((r) => setTimeout(r, SLOW_UNIT_MS));
                const page = rows.slice(nextIndex, nextIndex + UNIT_A_PAGE_ROWS);
                nextIndex += page.length;
                const more = nextIndex < rows.length;
                return { resources: page, continuationToken: more ? `unitA:${nextIndex}` : undefined, hasMoreResults: more };
              },
            };
          }
          // Original one-page-per-unit shape, unchanged, for every test that
          // does not set UNIT_A_PAGE_ROWS.
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
