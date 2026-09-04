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

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const portfolio = db.container("portfolio");
  console.log(`slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let docs = 0, otherShards = 0, holdingsSeen = 0, stamped = 0, alreadyStamped = 0, noPurchase = 0, purchaseHasNoIds = 0, docsWritten = 0, conflicts = 0, failed = 0;
  let token;
  do {
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
  if (APPLY) reportWrites({ job: "backfill-holding-ebay-ids", intended: holdingsSeen, written: stamped, skipped: alreadyStamped + noPurchase + purchaseHasNoIds + conflicts, failed });
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
