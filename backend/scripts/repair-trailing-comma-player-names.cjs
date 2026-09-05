#!/usr/bin/env node
/**
 * repair-trailing-comma-player-names.cjs -- a player's name does not end in a
 * comma.
 *
 * CF-A-NAME-DOES-NOT-END-IN-A-COMMA (Drew, 2026-08-29, the 2025 Bowman Draft
 * CPA-MWI picker: "Max Williams,"). Beckett's workbook writes the player cell
 * with a trailing comma, the xlsx converter carried it into the one checklist
 * CSV, and the CSV ingest trimmed whitespace but not punctuation -- so 9,199
 * beckett-checklist rows carry "Name," as playerName, in displayName and in
 * searchText (plus 507 catalog-explode-actuals, 97 tcdb-scrape, 19 cardhedge,
 * 8 bcp, 6 ingest-auto-seed, 1 checklistcenter by other routes). Measured
 * 2026-08-29, read-only: 9,837 rows end in ",", 2 in ";", 148 in " "
 * (cardhedge-graded "Chase Utley "); 1,715 of the comma rows are graded
 * children, which spread their parent's fields. Every sampled row is
 * "Full Name," -- no "Last, First" shape exists in the data, and an EMBEDDED
 * comma is not this defect, so only the trailing run of [,;whitespace] goes.
 * A trailing "." is a suffix ("Jr.", 656,452 rows) and is not touched.
 *
 * THE ID DOES NOT CHANGE. The slug carries no player segment, so this is a
 * patch, not a move: playerName cleaned by the builder's own cleanPlayerName,
 * playerSlug recomputed the way the checklist ingest computes it
 * (hobbyIqCardId.slugify -- the same function the matcher keys the sale side
 * with, so "Moisés" meets "moises"), searchText / displayName rebuilt by
 * catalogRowOps.rebuildSearchFields, and searchTokens UNIONED with the rebuilt
 * set: the comma never reached a token (the tokenizer splits on punctuation),
 * the nightly builder adds fold passes the src builder lacks (O'Neal ->
 * oneal), and a graded row's tokens carry its grade -- a union loses none of
 * that. The old value is kept on `playerNameRepairedFrom`.
 *
 * The root cause is closed in the same PR: cleanPlayerName at
 * deriveCatalogEntry and at the CSV ingest's row parse.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write
 *      (report only by default); SOURCES (comma list; default every source);
 *      SLOT/SLOTS (sha1(id) shards); RUN_MINUTES=140; CONCURRENCY=16; LIMIT=0.
 */
"use strict";
const crypto = require("node:crypto");

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
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
const path = require("path");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "repair-trailing-comma-player-names" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const LIMIT = Number(process.env.LIMIT || 0);
const SOURCES = String(process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** The fields rebuildSearchFields reads, plus what the patch needs. */
const PROJECTION = "c.id, c.cardId, c.source, c.sport, c.year, c.cardYear, c.setKey, c.setName, c.cardNumber, c.playerName, c.playerSlug, c.parallel, c.parallelSlug, c.printRun, c.subsetName, c.gradeTier, c.searchTokens";

/**
 * Pure: the patch a row needs, or null when its name is already clean.
 * `deps` are the canonical helpers -- dist at runtime, src in the test -- so
 * this file never re-spells cleanPlayerName / slugify / rebuildSearchFields.
 */
function planRepair(row, deps) {
  const before = typeof row.playerName === "string" ? row.playerName : null;
  if (before === null) return null;
  const after = deps.cleanPlayerName(before);
  if (!after || after === before) return null;
  const year = typeof row.year === "number" ? row.year : (typeof row.cardYear === "number" ? row.cardYear : null);
  const fields = deps.rebuildSearchFields({ ...row, year, playerName: after });
  const existing = Array.isArray(row.searchTokens) ? row.searchTokens.map((t) => String(t).toLowerCase()).filter(Boolean) : [];
  const searchTokens = [...new Set([...existing, ...fields.searchTokens])];
  const graded = row.gradeTier !== undefined && row.gradeTier !== null;
  const playerSlug = deps.slugify(after);
  return {
    before, after, graded, playerSlug,
    ops: [
      { op: "set", path: "/playerName", value: after },
      { op: "set", path: "/playerSlug", value: playerSlug },
      { op: "set", path: "/searchText", value: fields.searchText },
      { op: "set", path: "/displayName", value: fields.displayName },
      { op: "set", path: "/searchTokens", value: searchTokens },
      { op: "set", path: "/playerNameRepairedFrom", value: before },
    ],
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { CosmosClient } = require("@azure/cosmos");
  const { rebuildSearchFields } = require("../dist/services/catalog/catalogRowOps.service.js");
  const { cleanPlayerName } = require("../dist/services/portfolioiq/cardCatalog.service.js");
  const { slugify } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");
  const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
  const deps = { rebuildSearchFields, cleanPlayerName, slugify };
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog");
  console.log(`repair-trailing-comma-player-names  ${APPLY ? "APPLY" : "REPORT ONLY"}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  sources=${SOURCES.join(",") || "all"}  limit=${LIMIT || "none"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const sourceSql = SOURCES.length ? ` AND c.source IN (${SOURCES.map((_, i) => `@s${i}`).join(",")})` : "";
  const spec = {
    query: `SELECT ${PROJECTION} FROM c WHERE IS_STRING(c.playerName) AND (ENDSWITH(c.playerName, ",") OR ENDSWITH(c.playerName, ";") OR ENDSWITH(c.playerName, " "))${sourceSql}`,
    parameters: SOURCES.map((s, i) => ({ name: `@s${i}`, value: s })),
  };

  const stats = { scanned: 0, otherShard: 0, unchanged: 0, repaired: 0, graded: 0, failed: 0, notReached: 0 };
  const bySource = new Map();
  const examples = [];
  let stopReason = null;
  let token;
  do {
    const page = await retry(() => cat.items.query(spec, { maxItemCount: 500, continuationToken: token }).fetchNext());
    token = page.continuationToken || undefined;
    const rows = page.resources ?? [];
    const mine = SLOTS > 1 ? rows.filter((r) => shardOf(r.id) === SLOT) : rows;
    stats.otherShard += rows.length - mine.length;
    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      if (LIMIT && stats.repaired >= LIMIT) { stopReason = "limit"; stats.notReached += mine.length - i; break; }
      if (budgetLeft() < 90000) { stopReason = "budget"; stats.notReached += mine.length - i; break; }
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (row) => {
        stats.scanned++;
        const plan = planRepair(row, deps);
        if (!plan) { stats.unchanged++; return; }
        try {
          if (APPLY) await retry(() => cat.item(row.id, row.cardId ?? row.id).patch(plan.ops));
          stats.repaired++;
          if (plan.graded) stats.graded++;
          bySource.set(row.source ?? "?", (bySource.get(row.source ?? "?") ?? 0) + 1);
          if (examples.length < 20) examples.push(`  ${JSON.stringify(plan.before)} -> ${JSON.stringify(plan.after)}  slug=${plan.playerSlug}  [${row.source}]  ${row.id}`);
        } catch (e) {
          if (e?.code === 404) { stats.unchanged++; return; }
          stats.failed++;
          if (stats.failed <= 5) console.log(`  failed ${row.id}: ${String(e?.message ?? e).slice(0, 100)}`);
        }
      }));
    }
    if (stopReason) break;
  } while (token);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  candidates (this slot)   ${f(stats.scanned)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  ${APPLY ? "REPAIRED" : "WOULD REPAIR"}             ${f(stats.repaired)}   <- ${f(stats.graded)} of them graded children (tokens kept, name/slug/text healed)`);
  console.log(`  already clean            ${f(stats.unchanged)}   <- the query over-matched (a tab, a NBSP) or a concurrent heal`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (bySource.size) { console.log(`  by source:`); for (const [s, n] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(40)} ${f(n)}`); }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "repair-trailing-comma-player-names", intended: stats.scanned, written: stats.repaired, skipped: stats.unchanged, failed: stats.failed });
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
}

module.exports = { planRepair };

if (require.main === module) {
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
}
