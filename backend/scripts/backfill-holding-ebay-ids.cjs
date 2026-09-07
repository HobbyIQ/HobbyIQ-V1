#!/usr/bin/env node
/**
 * backfill-holding-ebay-ids.cjs -- the eBay ids belong on the holding too.
 *
 * CF-A-REAL-SALE-IS-IN-THE-POOL-ONCE (Drew, 2026-08-29, checklist D7b). Until
 * #1388 the eBay item id and order line item id lived only on the purchase
 * entry; every comp path that read `holding.ebayItemId` fell back to a
 * "holding::<id>" key, so the pool could never dedupe those sales by eBay id.
 * New imports stamp the ids at import time. This stamps them onto the holdings
 * that already exist, from the purchase entry each one was created from
 * (holding.sourcePurchaseId -> doc.purchases[].id), and nothing else.
 *
 * Idempotent: a holding that already carries the ids is left alone. The user
 * doc is written back with an if-match on its etag, so a concurrent app write
 * wins and the doc is simply retried on the next run.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; SLOT/SLOTS (hash of
 *      userId); LIMIT.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
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
const SHARD_SCOPE = runnerShardScope({ label: "backfill-holding-ebay-ids" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const LIMIT = Number(process.env.LIMIT || 0);
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes `portfolio` -- user
// documents -- and declared no budget at all, so a slot with more docs than one
// 150-minute step holds could only end by being KILLED at the ceiling: no
// marker, no reconcile, no finishLane line, and #1913's KILLED branch then
// withholding the re-dispatch with the sweep half done.
//
// THE UNIT IS ONE PAGE of 20 user documents, and its cost is dominated by the
// WRITES it fans out: up to 20 whole-document `replace` calls under an IfMatch,
// on documents this repo tracks against the 2 MB Cosmos ceiling. Twenty
// near-ceiling replaces against a throttled container is the worst case a page
// can produce, and 90 seconds is that with room -- checked BEFORE the page is
// fetched rather than after it is written.
//
// The post-loop report reads nothing, so VERIFY_MS is nominal and only sizes
// the pin's worst case (110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling).
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // NAMED so finishLane() can dispose it (#1809): an undisposed SDK holds
  // keep-alive sockets, and a live handle is what held four reconciled-clean
  // runs to the ceiling.
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");
  console.log(`slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);

  let docs = 0, otherShards = 0, holdingsSeen = 0, stamped = 0, alreadyStamped = 0, noPurchase = 0, purchaseHasNoIds = 0, docsWritten = 0, conflicts = 0, failed = 0;
  // Set when the budget stopped the page walk. There is no `not reached` count
  // to print here and inventing one would be a lie: this lane discovers its
  // population page by page, so the holdings it never fetched were never seen
  // and are not part of `intended`. What the operator needs instead is the
  // MARKER plus an honest statement that the slot is UNFINISHED.
  let stoppedAtBudget = false;
  let token;
  do {
    // THE PRE-CHECK: before the page is fetched, never after it is written.
    // `outOfClock()` is true when less than the reserve remains, so the page
    // whose 20 replaces would overrun is never STARTED. Checking after the
    // page admits one more whole page of unbounded write cost past expiry --
    // the loop-top defect #1799 named.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const page = await portfolio.items.query({ query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)" }, { maxItemCount: 20, continuationToken: token }).fetchNext();
    token = page.continuationToken;
    for (const doc of page.resources) {
      const userId = String(doc.userId ?? doc.id);
      if (shardOf(userId) !== SLOT) { otherShards++; continue; }
      docs++;
      const purchases = new Map((Array.isArray(doc.purchases) ? doc.purchases : []).map((p) => [String(p.id), p]));
      let changed = 0;
      for (const h of Object.values(doc.holdings ?? {})) {
        if (!h || typeof h !== "object") continue;
        holdingsSeen++;
        if (h.ebayItemId || h.ebayOrderId) { alreadyStamped++; continue; }
        const pid = h.sourcePurchaseId ? String(h.sourcePurchaseId) : null;
        const p = pid ? purchases.get(pid) : null;
        if (!p) { noPurchase++; continue; }
        if (!p.ebayItemId && !p.ebayOrderId) { purchaseHasNoIds++; continue; }
        if (p.ebayItemId) h.ebayItemId = String(p.ebayItemId);
        if (p.ebayOrderId) h.ebayOrderId = String(p.ebayOrderId);
        h.ebayIdsBackfilledAt = new Date().toISOString();
        changed++; stamped++;
        if (LIMIT && stamped >= LIMIT) break;
      }
      if (changed && APPLY) {
        try {
          await portfolio.item(String(doc.id), userId).replace(doc, { accessCondition: { type: "IfMatch", condition: doc._etag } });
          docsWritten++;
        } catch (e) {
          if (e?.code === 412) { conflicts++; stamped -= changed; }
          else { failed++; stamped -= changed; if (failed <= 5) console.error(`  failed ${userId}: ${String(e?.message ?? e).slice(0, 80)}`); }
        }
      }
      if (LIMIT && stamped >= LIMIT) { token = undefined; break; }
    }
  } while (token);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  user docs (this slot)        ${f(docs)}   (+${f(otherShards)} belonging to other slots)`);
  console.log(`  holdings seen                ${f(holdingsSeen)}`);
  console.log(`  STAMPED with eBay ids        ${f(stamped)}`);
  console.log(`  already carried the ids      ${f(alreadyStamped)}`);
  console.log(`  no linked purchase           ${f(noPurchase)}   <- not an eBay import, or the link was lost`);
  console.log(`  purchase carries no ids      ${f(purchaseHasNoIds)}`);
  console.log(`  docs written                 ${f(docsWritten)}   etag conflicts ${f(conflicts)}   failed ${f(failed)}`);
  // RECONCILE OVER WHAT WAS SEEN. `holdingsSeen` counts only holdings this run
  // actually read, so the identity below holds whether the loop finished or the
  // budget stopped it -- a budget stop shrinks BOTH sides rather than opening a
  // gap that reads as loss.
  const skipped = alreadyStamped + noPurchase + purchaseHasNoIds + conflicts;
  console.log(`  reconciled: seen ${f(holdingsSeen)} = stamped ${f(stamped)} + skipped ${f(skipped)} + failed ${f(failed)}`);
  if (stamped + skipped + failed !== holdingsSeen) {
    console.error("  !! RECONCILE MISMATCH -- a holding was neither stamped, skipped nor failed");
    process.exitCode = 4;
  }
  if (APPLY) reportWrites({ job: "backfill-holding-ebay-ids", intended: holdingsSeen, written: stamped, skipped, failed });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this slot is UNFINISHED; the relaunch continues from here`);
    console.log("  the sweep is IDEMPOTENT: a holding already carrying its eBay ids counts as"
      + " `already carried the ids` and is never re-stamped, so the continuation re-walks"
      + " cheaply and writes only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message);
    await finishLane(3, { budget: CLOCK });
  });
