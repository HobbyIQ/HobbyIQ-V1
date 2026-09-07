#!/usr/bin/env node
// CF-BACKFILL-SEARCHTOKENS-ALL-SPORTS (Drew, 2026-08-02).
//
// The existing backfill-search-fields.cjs only touches c.source='cardsight'
// AND defaults to baseball. Result: basketball/football/hockey/soccer
// have ZERO searchTokens indexed, so canonicalCardSearch returns 0 hits
// for those sports even for common names (Luka, Herbert), causing web
// search to fall through to CardHedge's /card-search endpoint = 30s+
// hang.
//
// This script rebuilds searchTokens for EVERY row lacking them,
// regardless of source or sport. Pure Cosmos read/write, no vendor
// API calls.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   RUN_MINUTES                the work loop's budget (default 110)
//   RESERVE_MS / VERIFY_MS     unit reserve / verify cap (see THE CLOCK)
//   BACKFILL_CONCURRENCY       parallel workers (default 10)
//   SPORT_FILTER               optional single sport (basketball, football, etc.)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 10));
const SPORT_FILTER = process.env.SPORT_FILTER || null;

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane WRITES card_catalog rows
// (searchText + searchTokens + __searchIndexedAt) and had a LOCAL time cap
// rather than a budget: BACKFILL_MAX_MINUTES, defaulting to 25, checked at the
// TOP of the page loop with no unit reserve, and signalling continuation
// through RELAUNCH_NEEDED rather than the marker every other budgeted lane
// prints.
//
// THAT CAP WAS NOT A BUDGET. It reserved NOTHING for the page still in flight,
// so a page admitted a millisecond before expiry ran its 200 whole-document
// upserts to completion past it -- the loop-top defect #1799 named. And its
// RELAUNCH_NEEDED protocol, sound while a lane cannot be killed, goes SILENT
// when the step is killed: `RN` parses empty and the runner's RELAUNCH_NEEDED
// step falls to a `::warning::` that does not fail the job, so a killed run
// went GREEN with the work half done -- #1906's defect in a second protocol.
//
// It now takes the same three-constant clock as every other lane and moves onto
// the MARKER protocol, whose relaunch step (#1913's three-way shape)
// distinguishes a budget stop from a clean finish from a KILL.
//
// THE UNIT IS ONE PAGE of up to 200 catalog rows (maxItemCount: 200) -- the
// page is fetched whole, then drained through a CONCURRENCY-wide window of
// whole-document upserts, and the loop cannot stop inside one. Note the scan is
// `SELECT *`, so each row is the FULL document and each write replaces it
// whole; 90 seconds comfortably exceeds that drain against a container that
// throttles, and it is checked BEFORE the page is fetched so the page whose 200
// upserts would overrun is never STARTED.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// Mirror of buildSearchIndex from backend/src/services/portfolioiq/searchIndexing.service.ts
function buildSearchText(row) {
  const parts = [];
  const player = row.playerName ?? row.player;
  const releaseName = row.releaseName;
  const setName = row.setName ?? row.set;
  const number = row.cardNumber ?? row.number;
  const title = row.title;
  const variant = row.variant;
  if (player) parts.push(String(player));
  if (releaseName) parts.push(String(releaseName));
  if (setName && setName !== releaseName) parts.push(String(setName));
  if (title && title !== releaseName && title !== setName) parts.push(String(title));
  if (number) parts.push(String(number));
  if (row.year !== undefined && row.year !== null && row.year !== "") parts.push(String(row.year));
  if (variant) parts.push(String(variant));
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p && p.name) parts.push(String(p.name));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set();
  const out = [];
  const raw = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const r of raw) {
    if (r.length >= 2 && !seen.has(r)) { seen.add(r); out.push(r); }
    if (r.includes("-")) {
      for (const f of r.split("-")) {
        if (f.length >= 2 && !seen.has(f)) { seen.add(f); out.push(f); }
      }
    }
  }
  return out;
}

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[backfill-searchtokens-all-sports] apply=${APPLY} concurrency=${CONCURRENCY} sport=${SPORT_FILTER ?? "all"}`);
  console.log(`  ${CLOCK.describe()}`);

  const sportClause = SPORT_FILTER ? " AND c.sport = @sport" : "";
  const params = SPORT_FILTER ? [{ name: "@sport", value: SPORT_FILTER }] : [];
  const query = "SELECT * FROM c WHERE (NOT IS_DEFINED(c.searchTokens) OR ARRAY_LENGTH(c.searchTokens) = 0)" +
                sportClause;

  const iter = cc.items.query({ query, parameters: params }, { maxItemCount: 200 });
  const stats = { scanned: 0, indexed: 0, empty: 0, errors: 0, bySport: {} };
  const inFlight = [];
  // `written` did not exist: `indexed` counted rows the lane DECIDED to write,
  // incremented before the upsert was even attempted, so a run whose every write
  // failed still printed `indexed: N`. reportWrites needs both sides.
  let written = 0;
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page (feedback: a slice is not a
  // sibling counter).
  let stoppedAtBudget = false;

  async function processRow(row) {
    try {
      const searchText = buildSearchText(row);
      const searchTokens = buildSearchTokens(searchText);
      if (!searchTokens.length) { stats.empty++; return; }
      const sport = row.sport || "unknown";
      stats.bySport[sport] = (stats.bySport[sport] || 0) + 1;
      stats.indexed++;
      if (APPLY) {
        row.searchText = searchText;
        row.searchTokens = searchTokens;
        row.__searchIndexedAt = new Date().toISOString();
        await withRetry(() => cc.items.upsert(row));
        written++;
      }
    } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its 200 whole-document upserts have been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 2000 === 0) {
        console.log(`  scanned=${stats.scanned} indexed=${stats.indexed} empty=${stats.empty} err=${stats.errors}`);
      }
      // The inner break only leaves the row walk; the outer `while` re-checks
      // the same clock at the top, so the budget is honoured PER RUN rather than
      // per page (#1947's retire-impossible-grade-rows lesson).
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:  ${stats.scanned}`);
  console.log(`  indexed:  ${stats.indexed}`);
  console.log(`  empty:    ${stats.empty}  (no text to tokenize)`);
  console.log(`  errors:   ${stats.errors}`);
  console.log(`  by sport:`);
  for (const [s, n] of Object.entries(stats.bySport).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(15)}${String(n).padStart(10)}`);
  }
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);

  // RECONCILE OVER WHAT WAS SEEN. `indexed` counts only rows this run decided to
  // write, so the identity holds whether the loop finished or the budget stopped
  // it -- a budget stop shrinks BOTH sides rather than opening a gap.
  if (APPLY) {
    console.log(`  reconciled: intended ${stats.indexed} = written ${written} + failed ${stats.errors}`);
    if (written + stats.errors !== stats.indexed) {
      console.error("  !! RECONCILE MISMATCH -- an indexed row was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-searchtokens-all-sports",
      intended: stats.indexed, written, skipped: stats.empty, failed: stats.errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: the scan selects only"
      + " rows whose searchTokens are absent or empty, and an indexed row has neither.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
