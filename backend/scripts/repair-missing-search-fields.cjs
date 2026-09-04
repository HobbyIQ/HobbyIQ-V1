#!/usr/bin/env node
/**
 * CF-CHECKLIST-ROWS-MUST-BE-FINDABLE (Drew, 2026-09-01: "are they the same
 * format and inside the catalog?").
 *
 * They were not. A checklist row that exists but carries no `searchTokens` is
 * invisible: catalogSearch discriminates with
 * `ARRAY_CONTAINS(c.searchTokens, @t)`, so a row without them can never be
 * returned no matter how exactly a query names the card.
 *
 * The cause is structural, not a one-off: `deriveCatalogEntry` — what
 * ingest-scraped-checklist.cjs builds its docs from — did not populate
 * searchText / searchTokens / displayName at all (fixed forward in #1614; this
 * script heals the rows written before that landed).
 *
 * ONE IMPLEMENTATION. The fields are rebuilt by `rebuildSearchFields` from
 * catalogRowOps — the same function catalogRowOps uses on a move — and NOT by a
 * private copy here. A second spelling of the search text is how a row becomes
 * "stale" to the coverage canary while looking fine.
 *
 * CF-HEAL-EVERY-DERIVED-FIELD (Drew, 2026-09-01: "yes widen it with what we
 * can"). The predicate used to match only `NOT IS_DEFINED(c.searchTokens)`, so
 * a row that HAD tokens but no searchText or displayName reported "nothing to
 * do" and stayed half-indexed. Measured on 1989 o-pee-chee: 560/560 had tokens
 * while 139 lacked searchText and 11 lacked displayName. All four are derived
 * from the row by one pure function, so any one missing means the row was never
 * fully indexed. An empty string counts as missing: a row carrying
 * searchText:"" is no more findable than one carrying none.
 *
 * FILL ONLY WHAT IS ABSENT. The patch is built per row from what that row
 * lacks, so a good displayName is kept rather than rewritten. This is a heal,
 * not a rewrite — overwriting is how a better row's index gets clobbered by a
 * worse one, and it is why the widened net is safe to point at a large scope.
 * It is also what makes the script idempotent: a re-run matches nothing.
 *
 * CF-A-LARGE-SCOPE-NEEDS-PAGING-NOT-MEMORY (2026-09-01). The first large-scope
 * run — 2025 topps-chrome, 341,306 rows — moved the searchText gap 225,770 ->
 * 220,719 and then DIED. It called `.fetchAll()` on every matching row and
 * patched them one at a time: the whole result set had to fit in memory before
 * the first write, and a run that dies mid-sweep reports nothing about what it
 * did. This rewrite fixes all four causes:
 *
 *   1. CONTINUATION-TOKEN PAGING. One page (PAGE_SIZE rows) is resident at a
 *      time, so peak memory is bounded by the page, not by the scope.
 *   2. BATCHED WRITES. Each page's patches run through a bounded worker pool
 *      (CONCURRENCY) instead of strictly one at a time.
 *   3. BUDGET MARKER + RELAUNCH (#1361). At RUN_MINUTES the script STOPS
 *      CLEANLY and prints "stopped at the ... budget", which the runner greps
 *      to re-dispatch. A killed job cannot report progress
 *      (CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS), so the script owns a clock
 *      under the step ceiling rather than being SIGKILLed at it. The sweep
 *      re-queries what is still missing, so a relaunch resumes exactly — the
 *      fill-only-absent predicate IS the resume cursor.
 *   4. RECONCILED COUNTERS. `intended` is counted where `written` is, and
 *      every break path sets `notReached`, so the totals add up whether the run
 *      finished, hit its budget, or hit its limit.
 *
 * SHARDING. SLOT/SLOTS shard by sha1(id) — a guaranteed, measured axis
 * (CF-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED). Every row lands in exactly
 * one slot regardless of how the scope's setKeys or years are distributed, so
 * N dispatches need no coordination and none overlap.
 *
 * SCOPED, AND IT REFUSES BEFORE IT REQUIRES. A whole-container heal has to say
 * its own name (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME): at least one of
 * SET_KEY / SETKEY_LIKE / YEAR(S) / SPORT must be given, and an APPLY with no
 * scope at all is refused outright.
 *
 * Usage (direct):
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-missing-search-fields.cjs \
 *     --set-key=bowman-chrome-nscc --year=2018 [--parallel="..."] [--expect=50] [--apply]
 *
 * Usage (runner): script=repair-missing-search-fields, with
 *   setkey_like / years / sports / slot / slots / limit / apply.
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const crypto = require("crypto");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { rebuildSearchFields, patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. The reconciliation is the shared helper,
// not a print of the same shape. The arithmetic was right; being a private
// copy of it was the defect — a hand-rolled equation is invisible to the net
// that asserts every writer reconciles, so this script could have lost its
// reconciliation entirely and nothing would have said so.
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const env = (n, d = "") => String(process.env[n] ?? "").trim() || d;
const flag = (n) => process.argv.includes(`--${n}`);

// CF-THE-RUNNER-EXPORTS-BACKFILL-APPLY-NOT-APPLY. The runner sets
// BACKFILL_APPLY; a direct run uses --apply. Read both, trim both
// (CF-ENV-VAR-TRIM-SYMMETRY).
const APPLY = flag("apply") || env("BACKFILL_APPLY") === "true";

// Scope. Each axis reads its --flag first, then the runner env spellings.
// SET_KEY and SETKEY_LIKE are both wired to the runner's `setkey_like` input,
// so one input drives either an exact key or a prefix.
const SET_KEY = arg("set-key", env("SET_KEY"));
const SETKEY_LIKE = arg("setkey-like", env("SETKEY_LIKE"));
const YEAR = arg("year", env("YEAR") || env("YEARS"));
const SPORT = arg("sport", env("SPORT") || env("SPORTS"));
const PARALLEL = arg("parallel", "");
const SOURCE_PREFIX = arg("source-prefix", env("SOURCES"));
const EXPECT = arg("expect", "");

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so the env fallback below NEVER saw an absent value and this lane
// sharded itself sixteen ways on a dispatch that asked for no sharding --
// sweeping slot 0 and leaving fifteen sixteenths untouched, green and honestly
// reconciled. Sharding is now OPT-IN: an explicit --slot/--slots on the command
// line (a flag IS a choice, `--slot 0` included), a non-zero SLOT, or SHARD=true
// for slot 0 of a real fan-out. The inherited slot=0 slots=16 sweeps EVERY row.
// SLOTS binds to 1 when unsharded, so `% SLOTS` and `SLOTS > 1` guards below
// keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({
  slotArg: arg("slot", ""), slotsArg: arg("slots", ""),
  label: "repair-missing-search-fields",
});
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const LIMIT = Number(arg("limit", env("LIMIT", "0"))) || 0;
const CONCURRENCY = Math.max(1, Number(arg("concurrency", env("BACKFILL_CONCURRENCY", "16"))) || 16);
const PAGE_SIZE = Math.max(1, Number(arg("page-size", env("PAGE_SIZE", "1000"))) || 1000);
// 140 minutes leaves the marker inside the runner's 150-minute step ceiling.
const RUN_MINUTES = Number(arg("run-minutes", env("RUN_MINUTES", "140"))) || 140;

const blank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const num = (n) => Number(n).toLocaleString("en-US");

/** Bounded worker pool. Returns when every task has settled. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  });
  await Promise.all(workers);
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  // REFUSALS BEFORE REQUIRES. A heal with no scope is a whole-container
  // mutation, and a whole-scope write has to be asked for by name.
  const axes = [SET_KEY, SETKEY_LIKE, YEAR, SPORT].filter((v) => v !== "");
  if (!axes.length) {
    console.error("FATAL: no scope. Give at least one of --set-key / --setkey-like / --year / --sport");
    console.error("       (runner: setkey_like / years / sports). This script refuses whole-container scope.");
    process.exit(2);
  }
  if (!Number.isFinite(SLOTS) || SLOTS < 1 || !Number.isFinite(SLOT) || SLOT < 0 || SLOT >= SLOTS) {
    console.error(`FATAL: bad shard: slot=${SLOT} slots=${SLOTS}. Need 0 <= slot < slots.`);
    process.exit(2);
  }
  if (YEAR && !/^\d{4}$/.test(YEAR)) {
    console.error(`FATAL: --year must be a single 4-digit year, got ${JSON.stringify(YEAR)}.`);
    process.exit(2);
  }

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  const scopeLine = [
    SET_KEY && `setKey=${SET_KEY}`,
    SETKEY_LIKE && `setKey^=${SETKEY_LIKE}`,
    YEAR && `year=${YEAR}`,
    SPORT && `sport=${SPORT}`,
    PARALLEL && `parallel=${JSON.stringify(PARALLEL)}`,
    SOURCE_PREFIX && `source^=${SOURCE_PREFIX}`,
  ].filter(Boolean).join(" ");

  console.log(`[repair-missing-search-fields] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope:  ${scopeLine}`);
  console.log(`  shard:  slot ${SLOT} of ${SLOTS}   page=${PAGE_SIZE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget: ${RUN_MINUTES} min${LIMIT ? `   limit=${num(LIMIT)} rows` : ""}\n`);

  const params = [];
  const where = [];
  if (SET_KEY) { where.push("c.setKey = @sk"); params.push({ name: "@sk", value: SET_KEY }); }
  if (SETKEY_LIKE) { where.push("STARTSWITH(c.setKey, @skl)"); params.push({ name: "@skl", value: SETKEY_LIKE }); }
  if (YEAR) { where.push("c.cardYear = @yr"); params.push({ name: "@yr", value: Number(YEAR) }); }
  if (SPORT) { where.push("c.sport = @sp"); params.push({ name: "@sp", value: SPORT }); }
  if (PARALLEL) { where.push("c.parallel = @par"); params.push({ name: "@par", value: PARALLEL }); }
  if (SOURCE_PREFIX) { where.push("STARTSWITH(c.source ?? '', @src)"); params.push({ name: "@src", value: SOURCE_PREFIX }); }
  // The heal predicate IS the resume cursor: a row already healed stops
  // matching, so a relaunch picks up exactly where the last run stopped.
  where.push(`(
      NOT IS_DEFINED(c.searchTokens) OR ARRAY_LENGTH(c.searchTokens) = 0
      OR NOT IS_DEFINED(c.searchText) OR c.searchText = ''
      OR NOT IS_DEFINED(c.displayName) OR c.displayName = ''
      OR NOT IS_DEFINED(c.setName) OR c.setName = ''
    )`);

  const query = `SELECT * FROM c WHERE ${where.join(" AND ")}`;

  // EXPECT is a guard on the SCOPE, so it counts before the shard split.
  if (EXPECT !== "") {
    const { resources: cnt } = await cat.items.query(
      { query: `SELECT VALUE COUNT(1) FROM c WHERE ${where.join(" AND ")}`, parameters: params },
      { enableCrossPartitionQuery: true },
    ).fetchAll();
    const got = cnt[0] ?? 0;
    console.log(`scope carries ${num(got)} rows missing at least one derived field`);
    if (got !== Number(EXPECT)) {
      console.error(`\nFATAL: expected ${EXPECT}, matched ${got}. Refusing.`);
      process.exit(3);
    }
  }

  // RECONCILED COUNTERS. `scanned` counts every row the query returned;
  // `mine` is this slot's share; `intended` is counted at the same place
  // `written` is, so the two can never drift apart silently.
  const c = {
    scanned: 0,      // rows returned by the paged query (all slots)
    mine: 0,         // rows in THIS slot
    intended: 0,     // rows this slot decided to patch
    written: 0,      // patches that succeeded (APPLY) or would run (DRY-RUN)
    failed: 0,       // patches that threw
    alreadyOk: 0,    // matched the query but nothing was actually blank
    notReached: 0,   // rows in scope this run never looked at — set on every break
    pages: 0,
  };
  const miss = { searchTokens: 0, searchText: 0, displayName: 0, setName: 0 };

  const startedAt = Date.now();
  const budgetMs = RUN_MINUTES * 60_000;
  let stopped = null;   // 'budget' | 'limit' | null
  let shown = 0;

  const iterator = cat.items.query(
    { query, parameters: params },
    { enableCrossPartitionQuery: true, maxItemCount: PAGE_SIZE },
  );

  while (iterator.hasMoreResults()) {
    if (Date.now() - startedAt > budgetMs) { stopped = "budget"; break; }
    if (LIMIT && c.intended >= LIMIT) { stopped = "limit"; break; }

    const { resources: page } = await iterator.fetchNext();
    // AN EMPTY PAGE IS NOT THE END. A cross-partition query returns an empty
    // page for every physical partition that holds no matching row, with
    // hasMoreResults() still true — measured on 2025 topps-chrome, where the
    // first THREE pages came back empty and page 4 held 1,000 rows. Breaking
    // on the first empty page reported "swept to completion, 0 rows" against a
    // 215,597-row gap. `hasMoreResults()` is the only end-of-stream authority.
    c.pages++;
    if (!page || !page.length) continue;
    c.scanned += page.length;

    // Shard, then decide. Both happen before any write so the patch list for
    // this page is known and countable.
    const work = [];
    for (const r of page) {
      if (SLOTS > 1 && shardOf(r.id) !== SLOT) continue;
      c.mine++;

      for (const f of Object.keys(miss)) if (blank(r[f])) miss[f]++;

      // setName is what the search text leads with. These rows were ingested
      // without one, so derive the display spelling from the key rather than
      // leaving the tokens without the product in them.
      const setName = r.setName
        || `${r.cardYear} ${String(r.setKey || "").replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}`;
      const fields = rebuildSearchFields({
        sport: r.sport, year: r.cardYear ?? r.year, setKey: r.setKey, setName,
        cardNumber: r.cardNumber, playerName: r.playerName, parallel: r.parallel,
        parallelSlug: r.parallelSlug, printRun: r.printRun, subsetName: r.subsetName ?? null,
      });

      // Fill ONLY what is missing. A row with a good displayName keeps it —
      // this is a heal, not a rewrite, and overwriting is how a better row's
      // index gets clobbered by a worse one.
      const patch = {};
      if (blank(r.searchTokens)) patch.searchTokens = fields.searchTokens;
      if (blank(r.searchText)) patch.searchText = fields.searchText;
      if (blank(r.displayName)) patch.displayName = fields.displayName;
      if (blank(r.setName)) patch.setName = setName;
      if (!Object.keys(patch).length) { c.alreadyOk++; continue; }

      if (shown < 5) {
        console.log(`  ${r.hobbyiqCardId}`);
        console.log(`     fills        = ${Object.keys(patch).join(", ")}`);
        console.log(`     displayName  = ${JSON.stringify(fields.displayName)}`);
        shown++;
      }
      work.push({ r, patch });
      if (LIMIT && c.intended + work.length >= LIMIT) break;
    }

    // `intended` is incremented here, in the same block that runs the writes,
    // so a page can never be counted as intended without being attempted.
    c.intended += work.length;
    if (!APPLY) {
      c.written += work.length;
    } else {
      await pool(work, CONCURRENCY, async ({ r, patch }) => {
        try {
          // Derived index fields: the previous value is absent by definition,
          // so no shadow copy is worth keeping.
          await patchCatalogRowFields(cat, r.id, r.cardId, patch, { noShadow: true });
          c.written++;
        } catch (e) {
          c.failed++;
          if (c.failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 140)}`);
        }
      });
    }

    if (c.pages % 10 === 0) {
      const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log(`  ... page ${c.pages}  scanned=${num(c.scanned)}  intended=${num(c.intended)}  written=${num(c.written)}  ${mins}m`);
    }
  }

  // NOT-REACHED ON EVERY BREAK PATH. Whatever is still in scope and still
  // missing a field when we stop is what the next relaunch will pick up.
  if (stopped) {
    const { resources: left } = await cat.items.query(
      { query: `SELECT VALUE COUNT(1) FROM c WHERE ${where.join(" AND ")}`, parameters: params },
      { enableCrossPartitionQuery: true },
    ).fetchAll();
    // In DRY-RUN nothing was written, so everything past the cursor is
    // unreached; in APPLY the remaining count already excludes what we healed.
    c.notReached = APPLY ? (left[0] ?? 0) : Math.max(0, (left[0] ?? 0) - c.intended);
  }

  console.log("");
  console.log(`missing by field (this slot): ${Object.entries(miss).map(([k, v]) => `${k}=${num(v)}`).join("  ")}`);
  console.log("");
  console.log(`[counters] pages=${num(c.pages)}  scanned=${num(c.scanned)}  slot_rows=${num(c.mine)}`);
  console.log(`           intended=${num(c.intended)}  ${APPLY ? "healed" : "would heal"}=${num(c.written)}  failed=${num(c.failed)}  alreadyOk=${num(c.alreadyOk)}`);
  console.log(`           notReached=${num(c.notReached)}`);

  // RECONCILIATION, through the one helper. `intended` counts only rows this
  // slot decided to patch, so there is nothing skipped to declare: every
  // intended row was attempted and landed in written or failed. A shortfall
  // (or an over-count) sets process.exitCode = 4 — red, not green — and the
  // budget marker below still prints, so the runner can still re-dispatch.
  reportWrites({
    job: `repair-missing-search-fields slot ${SLOT}/${SLOTS}`,
    intended: c.intended,
    written: c.written,
    failed: c.failed,
  });

  if (stopped === "budget") {
    // The exact phrase the runner greps to re-dispatch (#1361).
    console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — ${num(c.notReached)} rows still unhealed; re-dispatch to continue.`);
  } else if (stopped === "limit") {
    console.log(`\nstopped at the ${num(LIMIT)}-row limit — ${num(c.notReached)} rows still unhealed.`);
  } else {
    console.log(`\n[done] scope swept to completion for slot ${SLOT}/${SLOTS}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
