#!/usr/bin/env node
/**
 * repair-select-subbrand-misslug.cjs -- LANE 4 (a), 2026-08-31.
 *
 * WHAT THE BRIEF SAID, AND WHAT THE DATA SAYS. The lane was dispatched as
 * "basketball 2025 panini-select MISSLUG: 15,339 comps + 507 card numbers on a
 * product releasing 2026-10-14 (hobbymonitor id=744); sales cannot precede
 * release; probe titles/years -- likely earlier Select years". Measured
 * read-only 2026-08-31, none of that is the defect:
 *
 *   - sold_comps holds ZERO rows with setKey 'panini-select'. The population
 *     is in card_catalog, and it is 1,525 rows across 261 card numbers -- not
 *     15,339 / 507. There are no comps to re-date.
 *   - release_calendar has no hobbymonitor id=744 and no basketball Select
 *     row, so the "sales precede release" premise has nothing behind it.
 *   - The rows are not misdated. Their own setName says what they are:
 *
 *       2025 Panini Select WNBA Basketball          1,347
 *       2025 Panini Select EuroLeague Basketball      160
 *       2025 Panini Select Basketball                   8
 *       2025 panini-select Basketball                  10
 *
 * THE ACTUAL DEFECT is normalizeSetKey collapsing two SEPARATE PRODUCTS into
 * the flagship. `normalizeSetKey("2025 Panini Select WNBA Basketball")` returns
 * `panini-select`, and so does the EuroLeague spelling -- while the exactly
 * analogous Prizm products are registered and resolve correctly
 * (`panini-prizm-wnba`). Both Select destinations already exist and are
 * populated: panini-select-wnba 6,576 rows, panini-select-euroleague 10,917.
 * So 1,507 rows of two real products are sitting in the flagship's pool, which
 * is the split-pool / wrong-FMV shape from the other side: not one card in two
 * rows, but two products in one key.
 *
 * WHY THIS PASS DOES NOT TOUCH normalizeSetKey. Adding Select WNBA and
 * EuroLeague to the product table is a VOCABULARY DECISION -- it is Drew's
 * ruling which products exist and what they are named, and the memory on
 * normalizeSetKey collapsing products says exactly that. This script repairs
 * STORED ROWS against evidence those rows already carry, and carries no
 * opinion the catalog does not already hold. The root cause stays open and is
 * reported at the end of this run so the ruling has the numbers it needs.
 *
 * THE EVIDENCE IS THE ROW'S OWN setName. A row moves only when its stored
 * setName names the sub-brand, and only to a setKey that ALREADY EXISTS with
 * rows in it. Nothing is minted, nothing is inferred from a title, and the 18
 * rows whose setName names no sub-brand ("2025 Panini Select Basketball") are
 * REPORTED and left exactly where they are -- they may well be the flagship,
 * and this pass does not get to guess.
 *
 * WHITELIST, not a pattern match. DESTINATIONS below is the closed set of
 * (marker -> setKey) this script will ever write. A setName that matches no
 * marker is left alone; a destination that is not in the whitelist cannot be
 * written even if some row's setName suggests it.
 *
 * SCOPE is required and has no default (SPORT + YEAR + SETKEY), so a
 * whole-container write cannot happen by omission -- the shape that once
 * reported 13.14M rows for the wrong source.
 *
 * Every move goes through moveCatalogRow, which writes the survivor first,
 * re-points the sales, retires the old slug's graded children and deletes the
 * old row LAST. This file never upserts or deletes a catalog row itself.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      BACKFILL_APPLY / APPLY   actually write (default: REPORT ONLY)
 *      SPORT=basketball  YEAR=2025  SETKEY=panini-select   (all required)
 *      LIMIT=0  RUN_MINUTES=140  CONCURRENCY=8  SLOT/SLOTS
 */
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const SPORT = String(process.env.SPORT || "").trim().toLowerCase();
const YEAR = Number(process.env.YEAR || 0);
const SETKEY = String(process.env.SETKEY || "").trim().toLowerCase();
const LIMIT = Number(process.env.LIMIT || 0);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "repair-select-subbrand-misslug" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MS - (Date.now() - started);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const retry = async (fn, tries = 10) => {
  let wait = 700;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30000);
    }
  }
};
const backend = path.resolve(__dirname, "..");

/**
 * The closed set of destinations. A marker is looked for in the row's OWN
 * setName; `setKey` is where such a row belongs. Both destinations were
 * verified populated on 2026-08-31 (wnba 6,576 rows, euroleague 10,917), which
 * is what makes this a MOVE onto an existing product rather than minting one.
 */
const DESTINATIONS = [
  { marker: /\bwnba\b/i, setKey: "panini-select-wnba", label: "Select WNBA" },
  { marker: /\beuro\s*league\b/i, setKey: "panini-select-euroleague", label: "Select EuroLeague" },
];
const WHITELIST = new Set(DESTINATIONS.map((d) => d.setKey));

/** The destination for a row, from its own setName. null = leave it alone. */
function destinationFor(setName) {
  const s = String(setName ?? "");
  if (!s.trim()) return null; // blank means unknown, never "the flagship"
  const hits = DESTINATIONS.filter((d) => d.marker.test(s));
  // A setName naming BOTH sub-brands is not a thing we understand: refuse it
  // rather than picking the first match.
  if (hits.length !== 1) return null;
  return hits[0];
}

/**
 * A graded child row -- `${parentSlug}:${tier}`, e.g. ...:no-auto:psa-6.
 * These are carried by their parent's move (moveCatalogRow retires them), so
 * this pass never addresses one directly. Mirrors catalogRowOps' own rule: a
 * tier is ONE trailing segment and is never the print-run segment, so
 * `:num-75` is a numbered sibling (a real card, movable) and `:psa-6` is not.
 */
function isGradedChildId(row) {
  if (row && row.gradeTier != null && String(row.gradeTier) !== "") return true;
  const parts = String(row?.id ?? "").split(":");
  const last = parts[parts.length - 1] ?? "";
  // hiq:<sport>:<year>:<setKey>:<num>:<parallel>:<auto> is 7 segments; a tier
  // (or a print run) makes 8, and only the tier disqualifies the row.
  if (parts.length <= 7) return false;
  return !last.startsWith("num-");
}

/** Swap exactly the setKey segment of a hiq: id, leaving every other segment. */
function rekeyId(id, fromKey, toKey) {
  const s = String(id);
  const from = `:${fromKey}:`;
  const at = s.indexOf(from);
  if (at < 0) return null;
  return s.slice(0, at) + `:${toKey}:` + s.slice(at + from.length);
}

function reconcile(job, s) {
  const candidates = s.candidates ?? 0, written = s.written ?? 0;
  const skipped = s.skipped ?? 0, failed = s.failed ?? 0, notReached = s.notReached ?? 0;
  return {
    job, candidates, written, skipped, failed, notReached,
    intended: candidates + notReached,
    balances: written + skipped + failed === candidates,
    accountsForAll: written + skipped + failed + notReached === candidates + notReached,
  };
}

function querySpec() {
  return {
    query: "SELECT * FROM c WHERE c.setKey = @sk AND c.sport = @sp AND c.cardYear = @y",
    parameters: [{ name: "@sk", value: SETKEY }, { name: "@sp", value: SPORT }, { name: "@y", value: YEAR }],
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  // REFUSALS BEFORE REQUIRES: a scope this script guessed for itself is the
  // failure mode, so it refuses to start rather than defaulting.
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!SPORT || !YEAR || !SETKEY) {
    console.error("FATAL: SPORT, YEAR and SETKEY are all required -- this job never derives its own scope.");
    console.error("  e.g. SPORT=basketball YEAR=2025 SETKEY=panini-select");
    process.exit(2);
  }

  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  const dryRun = !APPLY;
  console.log(`repair-select-subbrand-misslug   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing will be written"}`);
  console.log(`scope: sport=${SPORT} cardYear=${YEAR} setKey=${SETKEY}   slot ${SLOT}/${SLOTS}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`whitelisted destinations: ${[...WHITELIST].join(", ")}\n`);

  const stats = { candidates: 0, written: 0, skipped: 0, failed: 0, notReached: 0, otherShard: 0 };
  const reasons = new Map();
  const byDest = new Map();
  const examples = [];
  const note = (k) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
  const example = (s) => { if (examples.length < 12) examples.push("    " + s); };

  let stopReason = null;
  const it = cat.items.query(querySpec(), { maxItemCount: 200 });
  let token = null;
  do {
    const page = await retry(() => it.fetchNext());
    token = page.continuationToken;
    const batch = page.resources ?? [];
    if (!batch.length) continue;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      if (budgetLeft() <= 0) { stopReason = "budget"; break; }
      if (LIMIT && stats.candidates >= LIMIT) { stopReason = "limit"; break; }
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (row) => {
        if (SLOTS > 1 && shardOf(row.id) !== SLOT) { stats.otherShard++; return; }
        if (LIMIT && stats.candidates >= LIMIT) { stats.notReached++; return; }
        stats.candidates++;
        try {
          const dest = destinationFor(row.setName);
          if (!dest) {
            stats.skipped++;
            note(`setName names no whitelisted sub-brand -- REPORTED, left in ${SETKEY}`);
            example(`left alone: ${String(row.setName ?? "(blank)")}  (${row.id})`);
            return;
          }
          // Belt and braces: the destination must be on the whitelist.
          if (!WHITELIST.has(dest.setKey)) {
            stats.skipped++; note("destination not whitelisted -- refused");
            return;
          }
          // A GRADED CHILD is not moved by this pass, and must not be: its id
          // is `${parentSlug}:${tier}`, which is not a hiq slug in its own
          // right, and moveCatalogRow RETIRES the graded children of the
          // parent it moves. Attempting the child directly is both a
          // double-move and a hard failure ("newSlug is not a hiq slug"),
          // which is exactly what the first bounded dry run reported on 4
          // rows. The parent's move is what carries them.
          if (isGradedChildId(row)) {
            stats.skipped++;
            note("graded child -- retired by its parent's move, never moved directly");
            example(`graded child left to its parent: ${row.id}`);
            return;
          }
          const newSlug = rekeyId(row.id, SETKEY, dest.setKey);
          if (!newSlug) {
            stats.skipped++;
            note("id does not carry the scoped setKey segment -- refused rather than rebuilt");
            example(`no setKey segment: ${row.id}`);
            return;
          }
          const res = await moveCatalogRow(cat, row, newSlug, {
            setKey: dest.setKey,
          }, {
            reason: `the row's own setName says ${dest.label}; normalizeSetKey collapsed the sub-brand into the ${SETKEY} flagship`,
            salesContainer: sold,
            dryRun,
            retry,
          });
          if (res.action === "noop") { stats.skipped++; note("already at the destination slug"); return; }
          stats.written++;
          byDest.set(dest.setKey, (byDest.get(dest.setKey) ?? 0) + 1);
          example(`${res.action} ${row.id}\n      -> ${newSlug}  (${res.salesRepointed} sale(s))`);
        } catch (e) {
          stats.failed++;
          if (stats.failed <= 6) console.log(`  failed ${String(row.id).slice(0, 90)}: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }));
      if (stopReason) break;
    }
    if (stopReason) break;
  } while (token);

  const verb = APPLY ? "APPLIED" : "REPORT ONLY -- nothing written";
  console.log(`\n${verb}`);
  console.log(`  candidates (this slot)   ${f(stats.candidates)}   (${f(stats.otherShard)} belong to other slots)`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"}                ${f(stats.written)}`);
  console.log(`  left alone               ${f(stats.skipped)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (byDest.size) {
    console.log(`  by destination:`);
    for (const [k, n] of [...byDest].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(34)} ${f(n)}`);
  }
  if (reasons.size) {
    console.log(`  why a row was left alone:`);
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(66)} ${f(n)}`);
  }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }

  const rec = reconcile("repair-select-subbrand-misslug", stats);
  if (!rec.balances) console.log(`\n  NOTE: the rows examined do not partition (${f(rec.written)} + ${f(rec.skipped)} + ${f(rec.failed)} != ${f(rec.candidates)})`);
  if (APPLY) reportWrites({ job: rec.job, intended: rec.intended, written: rec.written, skipped: rec.skipped + rec.notReached, failed: rec.failed });

  console.log(`\nROOT CAUSE STILL OPEN: normalizeSetKey("2025 Panini Select WNBA Basketball") -> "panini-select".`);
  console.log(`  This pass repairs stored rows from their own setName. Registering Select WNBA /`);
  console.log(`  EuroLeague in the product table is a VOCABULARY RULING for Drew, and until it lands`);
  console.log(`  the next ingest of these set names re-mints the same collapse.`);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget -- the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} -- a bounded run`);
}

module.exports = { DESTINATIONS, WHITELIST, destinationFor, rekeyId, isGradedChildId, reconcile, querySpec };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
