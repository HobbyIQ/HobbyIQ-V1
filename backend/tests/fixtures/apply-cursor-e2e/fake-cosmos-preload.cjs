#!/usr/bin/env node
/**
 * Preload for the APPLY cursor end-to-end test (rematchApplyCursorE2E.test.ts),
 * the apply-side sibling of fixtures/census-cursor-e2e/fake-cosmos-preload.cjs.
 * That one proves a CENSUS resumes; this one proves an APPLY writes as it
 * classifies and resumes across a relaunch.
 *
 * WHY A SEPARATE FIXTURE. The census fixture serves BLANK titles (deliberately
 * UNDERIVABLE, so it never depends on the parser's vocabulary) and answers
 * every `sold_comps.item().read()` with a 404. An apply needs the opposite of
 * both: rows that actually classify writable, and a pool whose point reads
 * return the row so the write-time re-check can pass. Folding both into one
 * file would make every census assertion depend on the parser again.
 *
 * WHAT IT SERVES.
 *   sold_comps    APPLY_ROW_COUNT rows, paged APPLY_PAGE_ROWS at a time, each
 *                 page carrying a continuation token "apply:<next>" that
 *                 `items.query` honours -- the same opaque round-trip the
 *                 census fixture uses, and the same contract the real SDK
 *                 offers for a query with no ORDER BY. Point reads resolve
 *                 against the live in-memory pool, so a row this pass ALREADY
 *                 MOVED reads back at its new address and the write-time
 *                 only-improve re-check sees what a real re-read would.
 *   card_catalog  every slug is checklist-backed (source "beckett"), so a
 *                 derived destination always passes the backing gate.
 *   rematch_control  the same JSON-file-backed Map the census fixture uses, so
 *                 two child-process passes share a cursor exactly as two runs
 *                 against real Cosmos would.
 *
 * THE SIMULATED BUDGET STOP. SLOW_PAGE_MS sleeps before every page, so a small
 * RUN_MINUTES trips the budget check BETWEEN pages -- leaving pass 1 with some
 * pages written and a saved token, which is precisely the state pass 2 must
 * resume from.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CONTROL_STATE_FILE = process.env.CONTROL_STATE_FILE;
if (!CONTROL_STATE_FILE) throw new Error("CONTROL_STATE_FILE must be set for the apply cosmos preload");
const POOL_STATE_FILE = process.env.POOL_STATE_FILE || null;
const SLOW_PAGE_MS = Number(process.env.SLOW_PAGE_MS || 0);
const APPLY_ROW_COUNT = Number(process.env.APPLY_ROW_COUNT || 6);
const APPLY_PAGE_ROWS = Math.max(1, Number(process.env.APPLY_PAGE_ROWS || 2));

function loadJSON(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; }
}
function saveJSON(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state), "utf8");
}
const loadControlState = () => loadJSON(CONTROL_STATE_FILE, {});
const saveControlState = (s) => saveJSON(CONTROL_STATE_FILE, s);

/** The pool, persisted across passes so pass 2 sees pass 1's writes. Keyed
 *  `id::cardId`, the same pair a Cosmos point read takes. */
function loadPool() {
  if (POOL_STATE_FILE) {
    const saved = loadJSON(POOL_STATE_FILE, null);
    if (saved) return saved;
  }
  const rows = {};
  for (let n = 1; n <= APPLY_ROW_COUNT; n++) {
    const num = process.env.DISTINCT_CARDS === "true" ? String(n) : "27";
    const slug = "hiq:baseball:2021:topps-chrome:" + num + ":base:no-auto";
    const row = {
      id: "apply-" + n,
      cardId: slug,
      hobbyiqCardId: slug,
      title: "2021 Topps Chrome Mike Trout #" + num + " Refractor",
      sport: "baseball", cardYear: 2021, setName: "Topps Chrome",
      cardNumber: num, parallel: "", isAuto: false, printRun: null,
      source: "cardhedge", soldPrice: 100 + n, soldDate: "2026-01-01",
    };
    rows[row.id + "::" + row.cardId] = row;
  }
  return rows;
}
let POOL = loadPool();
const persistPool = () => { if (POOL_STATE_FILE) saveJSON(POOL_STATE_FILE, POOL); };
persistPool();

/** Every row currently in the pool, in insertion order -- what a query sees. */
const poolRows = () => Object.values(POOL);

function soldCompsContainer() {
  return {
    items: {
      query: (_spec, options) => {
        // The page set is captured ONCE per query object, so rows this pass
        // re-keys mid-walk do not reshuffle the paging under its own feet.
        const rows = poolRows();
        let next = 0;
        const startToken = options && options.continuationToken;
        if (startToken) {
          const m = /^apply:(\d+)$/.exec(String(startToken));
          if (!m) throw new Error('fake cosmos: unrecognised continuation token "' + startToken + '"');
          next = Number(m[1]);
        }
        return {
          hasMoreResults: () => next < rows.length,
          fetchNext: async () => {
            if (SLOW_PAGE_MS > 0) await new Promise((r) => setTimeout(r, SLOW_PAGE_MS));
            const page = rows.slice(next, next + APPLY_PAGE_ROWS);
            next += page.length;
            const more = next < rows.length;
            return { resources: page, continuationToken: more ? "apply:" + next : undefined, hasMoreResults: more };
          },
        };
      },
      create: async (doc) => { POOL[doc.id + "::" + doc.cardId] = { ...doc }; persistPool(); return { resource: { ...doc } }; },
      upsert: async (doc) => { POOL[doc.id + "::" + doc.cardId] = { ...doc }; persistPool(); return { resource: { ...doc } }; },
    },
    item: (id, pk) => ({
      read: async () => {
        const d = POOL[id + "::" + pk];
        if (!d) { const e = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        if (!((id + "::" + pk) in POOL)) { const e = new Error("not found"); e.code = 404; throw e; }
        delete POOL[id + "::" + pk];
        persistPool();
        return {};
      },
      replace: async (doc) => { POOL[id + "::" + pk] = { ...doc }; persistPool(); return { resource: { ...doc } }; },
    }),
  };
}

/** Every slug is checklist-backed, so a derived destination always passes the
 *  backing gate and the classifier's verdict turns on the identity alone.
 *
 *  CATALOG_LATENCY_MS (2026-09-14) makes each point read cost real wall clock,
 *  which is what the classify path is actually bound by in prod (card_catalog
 *  at 100k RU, unthrottled -- the cost is the round trip, not the RU). With it
 *  set, this fixture measures the thing the CLASSIFY_CONCURRENCY prefetch is
 *  meant to move; with it unset (0) every existing test keeps its old speed.
 *  `catalogReads` counts the round trips so a test can prove the prefetch
 *  DEDUPES rather than merely overlapping -- N concurrent misses on one slug
 *  must still be one read. */
const CATALOG_LATENCY_MS = Number(process.env.CATALOG_LATENCY_MS || 0);
const counters = { catalogReads: 0 };
function cardCatalogContainer() {
  return {
    items: { query: () => ({ hasMoreResults: () => false, fetchNext: async () => ({ resources: [] }) }) },
    item: (id) => ({
      read: async () => {
        counters.catalogReads++;
        if (CATALOG_LATENCY_MS > 0) await new Promise((r) => setTimeout(r, CATALOG_LATENCY_MS));
        return { resource: { id, cardId: id, source: "beckett", checklistBacked: true } };
      },
    }),
  };
}
// The read count goes to stderr at exit so a harness can read it without
// parsing the lane's own stdout banner.
process.on("exit", () => {
  if (process.env.REPORT_CATALOG_READS === "true") {
    process.stderr.write(`FIXTURE_CATALOG_READS ${counters.catalogReads}
`);
  }
});

function controlContainer() {
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
        const d = loadControlState()[id];
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

function fakeContainer(name) {
  if (name === "sold_comps") return soldCompsContainer();
  if (name === "card_catalog") return cardCatalogContainer();
  if (name === "rematch_control") return controlContainer();
  throw new Error('fake cosmos: unexpected container "' + name + '"');
}

function FakeCosmosClient() {
  this.database = () => ({
    container: (name) => fakeContainer(name),
    containers: { createIfNotExists: async (spec) => ({ container: fakeContainer(spec.id) }) },
  });
  this.dispose = async () => {};
}

const azureCosmosPath = require.resolve("@azure/cosmos", { paths: [path.join(__dirname, "..", "..", "..", "scripts")] });
require.cache[azureCosmosPath] = {
  id: azureCosmosPath, filename: azureCosmosPath, loaded: true, exports: { CosmosClient: FakeCosmosClient },
};
