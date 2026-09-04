#!/usr/bin/env node
/**
 * backfill-ebay-purchase-comps.cjs -- put the BUY side of every eBay-origin
 * holding into the pool, under the identity the holding is pinned to.
 *
 * CF-THE-BUY-SIDE-IS-A-COMP-TOO (D37, Drew 2026-08-30): "How does the gold max
 * williams FROM ebay directly on the checklist NOT have the comp to drive the
 * right price". It is a real transaction on a checklist-backed card, and the
 * pool did not have it.
 *
 * WHAT WAS ACTUALLY WRONG. The buy-side emit is NOT missing -- D7a/D9/D12
 * built it, and it fires from four places (the import's create path, the
 * review-queue confirm, and addHolding / updateHolding via
 * emitUserEbayPurchaseComp). Every one of them keys the row through the ONE
 * shared derivation, `purchaseSaleIdentity` (D9): the purchase's eBay ORDER
 * LINE ITEM id, else the item id, else `holding::<id>`.
 *
 * What is missing is a pass for the holdings that were created BEFORE the
 * emit existed, or whose identity was pinned after their emit already ran.
 * Measured on prod 2026-08-30, Drew's user (89 purchases / 38 eBay-origin
 * holdings): 37 clear every emit gate, 27 have a pool row at their D9 key,
 * and the rest sit at a STALE key -- their row was written under the bare
 * `ebayItemId` by the pre-D9 admin batch-backfill, or under `holding::<id>`
 * before the ids travelled onto the holding. The Gold Max Williams
 * (aff3236a, $301.43, hiq:...:cpa-mwi:gold-refractor:auto:num-50 -- a
 * checklistcenter row) has no row at ANY of the three keys.
 *
 * This script replays those holdings through the same writer. It does not
 * re-derive identity and it does not re-parse a title: the holding's pinned
 * slug is the answer, and a holding without one is PARKED, counted, and left
 * alone -- it emits when the pin lands, through the pin path, not from here.
 *
 * ONE KEY, SO A REPLAY CANNOT DOUBLE-BOOK. The key comes from
 * `purchaseSaleIdentity`, imported from the service -- not re-implemented
 * here -- so this pass converges on the SAME doc the live paths write.
 * `recordSoldComp` is idempotent on `{source}::{sourceExternalId}` and on the
 * content hash, so a row already in the pool comes back deduped, is counted
 * as alreadyPresent, and nothing is written twice.
 *
 * STALE-KEY ROWS ARE COUNTED, NOT DELETED. Where a pre-D9 row exists at the
 * bare item id, this pass writes the D9-keyed row and leaves the stale one in
 * place. Deleting a pool row is a separate, deliberate pass with its own
 * dispatch -- a backfill that quietly deletes comps is how a pool loses sales.
 *
 * PRICE is the purchase SUBTOTAL, never the all-in cost. Shipping and tax are
 * the buyer's basis, not the market's price for the card; every vendor feed in
 * the pool reports the item price the same way. That derivation also lives in
 * `purchaseSaleIdentity` and is not repeated here.
 *
 * THE VENDOR ROW WINS ON CONTENT. When tca-ebay or cardhedge already carries
 * the same listing, recordSoldComp's existing content-hash dedup collapses the
 * pair -- the buy-side row does not get a special case, and it is weighted like
 * any other sale in the pool. Pinned in tests/ebayPurchaseCompBackfill.test.ts.
 *
 * SHARDING is by portfolio USER (sha1(userId) % SLOTS), and the run PRINTS the
 * whole distribution before it starts (#1361: a shard axis nobody measured put
 * 89% of a retire on one worker).
 *
 * REPORT ONLY unless BACKFILL_APPLY=true. The runner exports BACKFILL_APPLY,
 * not APPLY. A report-only run resolves every holding and prints the rows it
 * WOULD write -- including the per-holding emit list -- and touches nothing.
 *
 * Env: COSMOS_CONNECTION_STRING (required, via the runner's Azure step);
 *      BACKFILL_APPLY=true to write; USER_IDS (comma list; empty = every
 *      portfolio user); SLOT/SLOTS (shard by userId); RUN_MINUTES=140 (prints
 *      the budget marker the runner relaunches on); LIMIT (users processed; a
 *      LIMIT stop is NOT a budget stop); PER_USER_DELAY_MS=100.
 *
 * Requires dist/ (portfolioStore.service, ebayAutoHolding.service,
 * soldCompsStore.service, writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const backend = path.resolve(__dirname, "..");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const USER_IDS = String(process.env.USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
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
const SHARD_SCOPE = runnerShardScope({ label: "backfill-ebay-purchase-comps" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const PER_USER_DELAY_MS = Math.max(0, Number(process.env.PER_USER_DELAY_MS || 100));
const STARTED = Date.now();

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => String(v ?? "").trim();

// CF-SCOPE-REFUSAL-BEFORE-THE-REQUIRE (#1565). A stale dist/ must never be
// able to fake a scope check, so the refusals run before anything is loaded.
if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("FATAL: COSMOS_CONNECTION_STRING is required.");
  process.exit(2);
}
if (!Number.isFinite(SLOT) || SLOT < 0 || SLOT >= SLOTS) {
  console.error(`FATAL: SLOT must be within 0..${SLOTS - 1}; got ${process.env.SLOT}.`);
  process.exit(2);
}

const { readUserDoc, listAllPortfolioUserIds, poolIdentityForHolding } =
  require(path.join(backend, "dist/services/portfolioiq/portfolioStore.service.js"));
const { purchaseSaleIdentity, sourcePurchaseFor } =
  require(path.join(backend, "dist/services/portfolioiq/ebayAutoHolding.service.js"));
const { recordSoldComp } = require(path.join(backend, "dist/services/portfolioiq/soldCompsStore.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

/** An eBay-origin holding: the ids the import wrote, its marker source, or an
 *  eBay purchaseSource. Anything else is somebody's manual add and is not this
 *  pass's business. */
function isEbayOrigin(h) {
  if (!h || typeof h !== "object") return false;
  return Boolean(
    str(h.ebayOrderId) || str(h.ebayItemId)
    || str(h.source) === "ebay-auto"
    || /^ebay/i.test(str(h.purchaseSource)),
  );
}

async function main() {
  console.log("backfill-ebay-purchase-comps -- D37, the BUY side into the pool");
  console.log(`  mode        ${APPLY ? "APPLY (writes pool rows)" : "REPORT ONLY -- nothing written"}`);
  console.log("  key         D9 purchaseSaleIdentity (order line item id > item id > holding::<id>)");
  console.log("  price       the purchase SUBTOTAL -- never the all-in cost");
  console.log("  identity    the holding's PINNED slug only; no re-derivation, no title re-parse");
  console.log(`  slot        ${SLOT}/${SLOTS}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget      ${RUN_MS / 60000} min${LIMIT ? ` - LIMIT ${f(LIMIT)} users` : ""}`);

  let allUsers = USER_IDS.length ? USER_IDS : await listAllPortfolioUserIds();
  allUsers = [...new Set(allUsers.filter(Boolean))].sort();

  const dist = new Map();
  for (const u of allUsers) dist.set(shardOf(u), (dist.get(shardOf(u)) ?? 0) + 1);
  console.log(`\nportfolio users: ${f(allUsers.length)}`);
  console.log(`  shard distribution (sha1(userId) % ${SLOTS}):`);
  for (let i = 0; i < SLOTS; i++) {
    console.log(`    slot ${String(i).padStart(2)}  ${f(dist.get(i) ?? 0).padStart(6)} users${i === SLOT ? "   <- this run" : ""}`);
  }

  const mine = allUsers.filter((u) => shardOf(u) === SLOT);
  console.log(`\nthis slot owns ${f(mine.length)} of ${f(allUsers.length)} users`);
  if (mine.length === 0) { console.log("nothing to do for this slot."); return; }

  const s = {
    usersAttempted: 0, usersNotReached: 0, usersFailed: 0,
    purchasesSeen: 0,
    holdingsEbayOrigin: 0,
    candidates: 0,
    emitted: 0,
    alreadyPresent: 0,
    noIdentity: 0,
    noPrice: 0,
    noDate: 0,
    noPlayer: 0,
    catalogUnmatched: 0,
    failed: 0,
  };
  const emitLines = [];
  let stopReason = null;

  for (let i = 0; i < mine.length; i++) {
    if (LIMIT && s.usersAttempted >= LIMIT) { stopReason = "limit"; s.usersNotReached += mine.length - i; break; }
    if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; s.usersNotReached += mine.length - i; break; }

    const userId = mine[i];
    s.usersAttempted++;

    let doc;
    try { doc = await readUserDoc(userId); }
    catch (e) { s.usersFailed++; console.log(`  ${userId}  READ FAILED -- ${str(e?.message ?? e).slice(0, 160)}`); continue; }

    // holdings is a MAP -- walk Object.values, never an array index.
    const holdings = Object.values(doc?.holdings ?? {});
    const purchases = Array.isArray(doc?.purchases) ? doc.purchases : [];
    s.purchasesSeen += purchases.length;

    let userEmitted = 0;
    for (const h of holdings) {
      if (!isEbayOrigin(h)) continue;
      s.holdingsEbayOrigin++;

      // CF-ONE-IDENTITY-IN-THE-POOL (D12a): the pinned hiq slug, never a
      // vendor id. A holding without one PARKS -- it is emitted when the
      // identity pins, by the pin path, not by a guess made here.
      const identity = poolIdentityForHolding(h);
      if (!identity.cardId) { s.noIdentity++; continue; }

      const purchase = sourcePurchaseFor(doc, h);
      const { sourceExternalId, price, priceBasis } = purchaseSaleIdentity(purchase, h);
      if (!(price > 0)) { s.noPrice++; continue; }

      const purchaseDate = str(h.purchaseDate) || str(purchase?.purchaseDate);
      if (!purchaseDate) { s.noDate++; continue; }
      const playerName = str(h.playerName);
      if (!playerName) { s.noPlayer++; continue; }

      s.candidates++;
      const soldAt = purchaseDate.includes("T") ? purchaseDate : `${purchaseDate}T00:00:00Z`;
      const sport = str(h.sport).toLowerCase() || null;
      const title = str(h.ebayListingTitle) || str(purchase?.notes) || str(h.cardTitle) || null;

      const row = {
        cardId: identity.cardId,
        // D38: the identity the holding was RULED onto. The store verifies it
        // against a checklist-backed catalog row and, on confirmation, uses it
        // instead of recomputing a slug from these free-text fields -- the
        // cpa-jg skip, where a recomputed "bowman-chrome" refused a sale whose
        // holding sat on a checklist "bowman" row.
        pinnedHobbyIqCardId: identity.hobbyiqCardId,
        vendorCardId: identity.vendorCardId,
        playerName,
        cardYear: typeof h.cardYear === "number" ? h.cardYear : null,
        setName: str(h.setName) || str(h.product) || null,
        parallel: str(h.parallel) || null,
        cardNumber: str(h.cardNumber) || null,
        isAuto: h.isAuto === true,
        printRun: identity.printRun,
        sport,
        gradeCompany: str(h.gradeCompany) || null,
        gradeValue: typeof h.gradeValue === "number" ? h.gradeValue : null,
        price,
        priceBasis,
        soldAt,
        source: "ebay-user-purchase",
        sourceExternalId,
        contributorUserId: userId,
        title,
        imageUrl: str(h.ebayImageUrl) || null,
        sellerHandle: null,
        // The user owns the card, but this pass did not watch them confirm it.
        verifiedByUser: false,
        confidence: typeof h.catalogMatchConfidence === "number" ? h.catalogMatchConfidence : 0.8,
      };

      if (!APPLY) {
        s.emitted++; userEmitted++;
        emitLines.push(
          `    WOULD EMIT  ${str(h.id).slice(0, 8)}  ${playerName.padEnd(24).slice(0, 24)}`
          + `  $${String(price.toFixed(2)).padStart(9)}  ${sourceExternalId.padEnd(30).slice(0, 30)}  ${identity.cardId}`,
        );
        continue;
      }

      try {
        const res = await recordSoldComp(row);
        if (res?.written) {
          if (res.deduped) { s.alreadyPresent++; }
          else { s.emitted++; userEmitted++; }
        } else if (res?.reason === "catalog-unmatched") {
          // Retryable by design: the sale waits for its checklist to land.
          s.catalogUnmatched++;
        } else {
          s.failed++;
          console.log(`    FAILED  ${str(h.id).slice(0, 8)}  ${str(res?.reason ?? "unknown")}`);
        }
      } catch (e) {
        s.failed++;
        console.log(`    THREW  ${str(h.id).slice(0, 8)} -- ${str(e?.message ?? e).slice(0, 160)}`);
      }
    }

    if (userEmitted) console.log(`  ${userId}  ${APPLY ? "emitted" : "would emit"} ${f(userEmitted)}`);
    if (PER_USER_DELAY_MS) await sleep(PER_USER_DELAY_MS);
  }

  if (!APPLY && emitLines.length) {
    console.log("\nrows this run would write:");
    for (const line of emitLines) console.log(line);
  }

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget - the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} - a bounded run`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users attempted            ${f(s.usersAttempted)}`);
  console.log(`    read failed              ${f(s.usersFailed)}`);
  console.log(`    not reached              ${f(s.usersNotReached)}`);
  console.log(`  purchases seen             ${f(s.purchasesSeen)}`);
  console.log(`  eBay-origin holdings       ${f(s.holdingsEbayOrigin)}   <- the sub-totals below, which sum to it`);
  console.log(`    no identity (PARKED)     ${f(s.noIdentity)}   <- emits when the pin lands, not from here`);
  console.log(`    no price                 ${f(s.noPrice)}`);
  console.log(`    no purchase date         ${f(s.noDate)}`);
  console.log(`    no player name           ${f(s.noPlayer)}`);
  console.log(`    CANDIDATES               ${f(s.candidates)}   <- cleared every gate`);
  console.log(`  ${APPLY ? "rows written              " : "rows it WOULD attempt     "} ${f(s.emitted)}${APPLY ? "" : "   <- some may dedupe against a row already in the pool"}`);
  if (APPLY) {
    console.log(`  already in the pool        ${f(s.alreadyPresent)}   <- deduped on the D9 key or the content hash`);
  } else {
    // CF-A-DRY-RUN-MUST-NOT-CLAIM-A-NUMBER-IT-CANNOT-KNOW. Dedup is decided by
    // recordSoldComp on write -- on the D9 key AND on the content hash, the
    // latter being what collapses a tca-ebay row for the same listing. A
    // REPORT-ONLY pass performs no write, so it cannot know which of these
    // rows would land and which would come back deduped. Printing a 0 here
    // would read as "none of these are in the pool yet", which is a claim this
    // mode has not earned; the APPLY run is what splits the two.
    console.log(`  already in the pool        (not knowable in REPORT ONLY -- dedup is decided on write)`);
  }
  console.log(`  catalog-unmatched          ${f(s.catalogUnmatched)}   <- retryable; waiting on a checklist`);
  console.log(`  write failures             ${f(s.failed)}`);

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. Every candidate is written, already
  // present, deliberately withheld, or failed. CF-A-SLICE-IS-NOT-A-SIBLING-
  // COUNTER: the gate counters above are sub-totals of eBay-origin holdings
  // and stay on their own lines -- only the CANDIDATES are reconciled here,
  // because they are the rows this job intended to write.
  if (APPLY) {
    const skipped = Math.max(0, s.candidates - s.emitted - s.alreadyPresent - s.catalogUnmatched - s.failed);
    reportWrites({
      job: "backfill-ebay-purchase-comps",
      intended: s.candidates,
      written: s.emitted + s.alreadyPresent,
      skipped: skipped + s.catalogUnmatched,
      failed: s.failed,
      // Tens of rows, not millions: one unaccounted holding has to be red.
      tolerance: 0,
    });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
