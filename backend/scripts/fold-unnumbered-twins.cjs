#!/usr/bin/env node
/**
 * fold-unnumbered-twins.cjs -- a key needs both halves: an UN-NUMBERED catalog
 * row minted by a sale, a vendor or a user folds into the ONE numbered
 * checklist row that is the same card.
 *
 * CF-A-KEY-NEEDS-BOTH-HALVES (Drew, 2026-08-29, holding ca7a150b). The 2026
 * Bowman Chrome CPA-MG Marconi German Gold Refractor holding sits at
 * `…:gold-refractor:auto` -- a user-seeded catalog row with printRun null --
 * while the checklist row is `…:gold-refractor:auto:num-50`. Because the
 * un-numbered twin EXISTS, exact matching finds it first: the holding never
 * reaches the checklist card, its three real sales pool under the twin, and
 * the cross-setkey rung was free to admit a paper-Bowman /75 comp. The
 * numbered checklist row is the identity; the un-numbered twin is the seller
 * omitting "/50".
 *
 * THE RULE (the same one merge-unambiguous-printrun applies to the pool):
 *   exactly ONE numbered CHECKLIST-source row at `<id>:num-N`, and NO
 *   un-numbered checklist row at `<id>`  -> FOLD the twin into it
 *   two or more numbered variants        -> LEAVE ALONE (which /N was it? --
 *                                           guessing is worse than the split)
 *   the un-numbered row is itself checklist-source -> LEAVE ALONE in the
 *                                           default mode -- EXCEPT a SuperFractor
 *                                           or printing plate (1/1 by definition:
 *                                           Drew, 2026-08-29 "superfractors are
 *                                           1/1"), which folds into its /1
 *   MODE=cross-source: a checklist twin whose SOURCE lists no numbered
 *                      variant folds too -- one source omitted the print run
 *                      another lists (only-improve); a source that lists both
 *                      is describing two cards and is left alone.
 * The decision itself lives in src/services/catalog/foldTwinRule.ts (tested).
 *
 * The fold goes through moveCatalogRow (#1417): the checklist row survives by
 * authority, vendorIds union, sales re-pointed BEFORE the twin is deleted,
 * the twin's graded children retired (numbered-sibling-safe). Holdings are
 * NOT touched here -- conform-holdings-to-catalog re-derives them once the
 * twin is gone (the exact un-numbered id no longer exists to "agree" with).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (report only
 *      by default); SLOT/SLOTS (hash shards on the twin id); RUN_MINUTES=140;
 *      SPORT (optional filter); LIMIT=0.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { moveCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { catalogAuthorityOf, isDedicatedChecklist } = require(path.join(backend, "dist", "services", "catalog", "catalogAuthority.service.js"));
const { decideTwinFold } = require(path.join(backend, "dist", "services", "catalog", "foldTwinRule.js"));
const { reportWrites } = require(path.join(backend, "dist", "services", "ops", "writeReconciliation.js"));

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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "fold-unnumbered-twins" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
// The runner exports SPORTS as a COMMA LIST; taking only the first element
// silently scoped a multi-sport dispatch to one sport.
const SPORT_LIST = String(process.env.SPORT || process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SPORT = SPORT_LIST[0] || ""; // kept for the banner

const MODE = String(process.env.MODE || "vendor").trim().toLowerCase() === "cross-source" ? "cross-source" : "vendor";
const LIMIT = Number(process.env.LIMIT || 0);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };
const isChecklist = (source) => catalogAuthorityOf(String(source ?? "")) === "checklist";
const NUM_SEG = /:num-\d+(?::|$)/;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  console.log(`fold-unnumbered-twins  ${APPLY ? "APPLY" : "REPORT ONLY"}  mode=${MODE}  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m${SPORT_LIST.length ? `  sports=${SPORT_LIST.join(",")}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // Pass 1: every NUMBERED checklist identity row, grouped by its un-numbered
  // base id. Only groups with exactly one /N are candidates.
  const numberedByBase = new Map(); // baseId -> [{ id, printRun, source }]
  {
    const q = { query: `SELECT c.id, c.printRun, c.source FROM c WHERE STARTSWITH(c.id, "hiq:") AND NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.printRun) AND c.printRun != null${SPORT_LIST.length ? " AND ARRAY_CONTAINS(@sports, c.sport)" : ""}`, parameters: SPORT_LIST.length ? [{ name: "@sports", value: SPORT_LIST }] : [] };
    const it = cat.items.query(q, { maxItemCount: 1000 });
    let n = 0;
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        n++;
        if (!isChecklist(r.source)) continue;
        const m = String(r.id).match(/^(.*):num-(\d+)$/);
        if (!m) continue;
        const list = numberedByBase.get(m[1]) ?? [];
        list.push({ id: r.id, printRun: Number(m[2]), source: r.source });
        numberedByBase.set(m[1], list);
      }
    }
    console.log(`  pass 1: ${f(n)} numbered identity rows read; ${f(numberedByBase.size)} base ids carry a checklist /N`);
  }
  let uniqueCount = 0;
  for (const list of numberedByBase.values()) if (new Set(list.map((x) => x.printRun)).size === 1) uniqueCount++;
  console.log(`  ${f(uniqueCount)} of them have exactly ONE numbered variant (ambiguous groups fold only when the parallel is 1/1 by definition)`);
  const unique = numberedByBase;

  // Pass 2: for each candidate, does an un-numbered twin exist, and is it
  // NOT itself a checklist row? Point reads on the twin id (partition = id).
  const stats = { candidates: 0, otherShard: 0, noTwin: 0, ambiguous: 0, twinIsChecklist: 0, sameSourceListsBoth: 0, folded: 0, foldedVendor: 0, foldedOneOfOne: 0, foldedCrossSource: 0, salesRepointed: 0, gradedRetired: 0, failed: 0, notReached: 0 };
  const examples = [];
  let stopReason = null;
  let i = 0;
  for (const [base, numberedList] of unique) {
    if (LIMIT && i >= LIMIT) { stats.notReached += unique.size - i; break; }
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget — the relaunch continues from here`; stats.notReached += unique.size - i; break; }
    i++;
    if (SLOTS > 1 && shardOf(base) !== SLOT) { stats.otherShard++; continue; }
    stats.candidates++;
    let twin = null;
    try { twin = (await retry(() => cat.item(base, base).read())).resource ?? null; } catch (e) { if (e?.code !== 404) { stats.failed++; continue; } }
    if (!twin) { stats.noTwin++; continue; }
    const decision = decideTwinFold({ baseId: base, twinSource: String(twin.source ?? ""), twinIsChecklist: isChecklist(twin.source), twinIsDedicated: isDedicatedChecklist(twin.source), numbered: numberedList, mode: MODE });
    if (!decision.fold) {
      if (decision.skip === "ambiguous") stats.ambiguous++;
      else if (decision.skip === "same-source-lists-both") stats.sameSourceListsBoth++;
      else stats.twinIsChecklist++;
      continue;
    }
    const numbered = decision.target;
    if (examples.length < 20) examples.push(`  ${base}  [${twin.source}] -> ${numbered.id}  [${numbered.source}]  (${decision.kind})`);
    try {
      const res = await moveCatalogRow(cat, twin, numbered.id, { printRun: numbered.printRun }, { reason: decision.reason, dryRun: !APPLY, salesContainer: pool, retry });
      stats.folded++;
      if (decision.kind === "vendor") stats.foldedVendor++; else if (decision.kind === "one-of-one") stats.foldedOneOfOne++; else stats.foldedCrossSource++;
      stats.salesRepointed += res?.salesRepointed ?? 0;
      stats.gradedRetired += res?.gradedChildrenRetired ?? 0;
    } catch (e) { stats.failed++; if (stats.failed <= 5) console.log(`  failed ${base}: ${String(e.message).slice(0, 100)}`); }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  candidates (this slot)   ${f(stats.candidates)}   (${f(stats.otherShard)} belonging to other slots)`);
  console.log(`  no un-numbered twin      ${f(stats.noTwin)}`);
  console.log(`  ambiguous /N             ${f(stats.ambiguous)}   <- two print runs, neither 1/1 by definition; left alone`);
  console.log(`  twin is checklist        ${f(stats.twinIsChecklist)}   <- left alone (MODE=cross-source folds these when the twin's source lists no /N)`);
  console.log(`  same source lists both   ${f(stats.sameSourceListsBoth)}   <- two cards by that checklist; left alone`);
  console.log(`  ${APPLY ? "FOLDED" : "WOULD FOLD"}                   ${f(stats.folded)}   <- sales re-pointed ${f(stats.salesRepointed)}, graded children retired ${f(stats.gradedRetired)}`);
  console.log(`    vendor/user twins      ${f(stats.foldedVendor)}   | 1/1 by definition ${f(stats.foldedOneOfOne)}   | cross-source ${f(stats.foldedCrossSource)}`);
  console.log(`  failed                   ${f(stats.failed)}`);
  console.log(`  not reached              ${f(stats.notReached)}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (APPLY) reportWrites({ job: "fold-unnumbered-twins", intended: stats.candidates, written: stats.folded, skipped: stats.noTwin + stats.ambiguous + stats.twinIsChecklist + stats.sameSourceListsBoth, failed: stats.failed });
  if (stopReason) console.log(`\n${stopReason}`);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
main()
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); 
    await finishLane(3);
  });
