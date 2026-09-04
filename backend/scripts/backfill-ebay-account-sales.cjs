#!/usr/bin/env node
/**
 * backfill-ebay-account-sales.cjs -- replay the connected accounts' last 90
 * days through the D26 path.
 *
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, Drew 2026-08-30). The hourly
 * poll matched a sold line only against a holding carrying OUR listing id, and
 * advanced its cursor only from MATCHED orders. With nothing ever matching,
 * `lastPolledAt` stayed NULL on all eight live connection docs and the same 29
 * orders were re-fetched every hour since 2026-06-01. Every one of those sales
 * is real and none of them is in the pool.
 *
 * The poll now resolves each line to a card and records it. This is the pass
 * for the ones already sold. It calls the SAME `pollEbayOrdersForUser` the
 * hourly job calls -- there is no second implementation of the resolve /
 * record / mark ladder to drift from it -- with the query window widened to
 * DAYS and the cursor left alone.
 *
 * WHY THE CURSOR IS LEFT ALONE. A 90-day replay would otherwise shove
 * `lastPolledAt` forward to the newest order it saw. Every write on the path is
 * idempotent on (ebayOrderId, lineItemId) and on (holdingId, ebayOrderId), so
 * letting the hourly poll advance its own cursor on its own schedule costs one
 * cheap re-walk and keeps exactly one thing responsible for that value.
 *
 * SHARDING is by connected USER (sha1(userId) % SLOTS), and the run PRINTS the
 * per-slot distribution before it starts, because a shard axis nobody measured
 * put 89% of a retire on one worker (#1361). At the current 8 connected users
 * SLOTS=1 is the honest setting; the axis exists for when it is not.
 *
 * REPORT ONLY unless BACKFILL_APPLY=true. A report-only run resolves every
 * line and prints what it WOULD write, touching nothing -- no pool row, no
 * holding, no sale record, no cursor.
 *
 * Env: COSMOS_CONNECTION_STRING (required, via the runner's Azure step);
 *      BACKFILL_APPLY=true to write (the runner exports BACKFILL_APPLY, not
 *      APPLY); DAYS=90 (eBay's own getOrders window is generous but the
 *      Trading-API cap elsewhere is 90, so 90 is the house number);
 *      USER_IDS (comma list; empty = every connected user);
 *      SLOT/SLOTS (shard by userId); RUN_MINUTES=140 (prints the budget
 *      marker the runner relaunches on); LIMIT (users processed; a LIMIT stop
 *      is NOT a budget stop); PER_USER_DELAY_MS=250.
 *
 * Requires dist/ (ebayOrderPoll.service, ebayTokenStore.service,
 * writeReconciliation).
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const backend = path.resolve(__dirname, "..");
const { pollEbayOrdersForUser } = require(path.join(backend, "dist/services/ebay/ebayOrderPoll.service.js"));
const { listConnectedUserIds, readTokenRecord, connectionStatusOf } = require(path.join(backend, "dist/services/ebay/ebayTokenStore.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const DAYS = Math.max(1, Math.min(365, Number(process.env.DAYS || 90)));
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
const SHARD_SCOPE = runnerShardScope({ label: "backfill-ebay-account-sales" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const PER_USER_DELAY_MS = Math.max(0, Number(process.env.PER_USER_DELAY_MS || 250));
const STARTED = Date.now();

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SLOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sinceIso = new Date(Date.now() - DAYS * 86400000).toISOString();

  console.log(`backfill-ebay-account-sales -- D26, replaying ${DAYS} days per connected user`);
  console.log(`  mode        ${APPLY ? "APPLY (writes pool rows, sale records and holdings)" : "REPORT ONLY -- nothing written"}`);
  console.log(`  window      lastmodifieddate >= ${sinceIso}`);
  console.log(`  slot        ${SLOT}/${SLOTS}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  budget      ${RUN_MS / 60000} min${LIMIT ? ` · LIMIT ${f(LIMIT)} users` : ""}`);
  console.log(`  cursor      NOT advanced -- the hourly poll still owns lastPolledAt`);

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING is required.");
    process.exit(2);
  }

  let allUsers = USER_IDS.length ? USER_IDS : await listConnectedUserIds();
  allUsers = [...new Set(allUsers.filter(Boolean))].sort();

  // CF-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED (#1361). Print the whole
  // distribution before doing any work: a slot that owns nothing, or owns
  // everything, has to be visible in the log rather than inferred from a
  // suspiciously short run.
  const dist = new Map();
  for (const u of allUsers) {
    const sl = shardOf(u);
    dist.set(sl, (dist.get(sl) ?? 0) + 1);
  }
  console.log(`\nconnected users: ${f(allUsers.length)}`);
  console.log(`  shard distribution (sha1(userId) % ${SLOTS}):`);
  for (let i = 0; i < SLOTS; i++) {
    console.log(`    slot ${String(i).padStart(2)}  ${f(dist.get(i) ?? 0).padStart(6)} users${i === SLOT ? "   <- this run" : ""}`);
  }

  const mine = allUsers.filter((u) => shardOf(u) === SLOT);
  console.log(`\nthis slot owns ${f(mine.length)} of ${f(allUsers.length)} users`);
  if (mine.length === 0) {
    console.log("nothing to do for this slot.");
    return;
  }

  const s = {
    usersAttempted: 0,
    usersReconnectRequired: 0,
    usersNoToken: 0,
    usersFetchFailed: 0,
    usersNotReached: 0,
    ordersFetched: 0,
    ordersProcessed: 0,
    lines: 0,
    resolvedAuto: 0,
    parked: 0,
    unresolvable: 0,
    recorded: 0,
    recordedViaHolding: 0,
    recordedViaAccount: 0,
    holdingsMarked: 0,
    noMatchingHolding: 0,
    markFailures: 0,
    failed: 0,
  };
  const perUser = [];
  let stopReason = null;

  for (let i = 0; i < mine.length; i++) {
    if (LIMIT && s.usersAttempted >= LIMIT) {
      stopReason = "limit";
      s.usersNotReached += mine.length - i;
      break;
    }
    if (Date.now() - STARTED > RUN_MS) {
      stopReason = "budget";
      s.usersNotReached += mine.length - i;
      break;
    }

    const userId = mine[i];
    s.usersAttempted++;

    // Skip a connection eBay has already refused rather than burning a call.
    // The poll does this too; doing it here as well keeps the log honest about
    // WHY a user contributed nothing.
    try {
      const rec = await readTokenRecord(userId);
      if (rec && connectionStatusOf(rec) === "reconnect-required") {
        s.usersReconnectRequired++;
        perUser.push(`  ${userId}  RECONNECT REQUIRED -- ${rec.connectionStatusReason ?? "no reason stored"}`);
        continue;
      }
    } catch { /* fall through and let the poll report it */ }

    let r;
    try {
      r = await pollEbayOrdersForUser(userId, {
        since: sinceIso,
        dryRun: !APPLY,
        // The hourly poll owns lastPolledAt. See the header.
        advanceCursor: false,
      });
    } catch (e) {
      s.failed++;
      perUser.push(`  ${userId}  THREW -- ${String(e?.message ?? e).slice(0, 160)}`);
      continue;
    }

    if (r.status === "no-token") { s.usersNoToken++; perUser.push(`  ${userId}  no token record`); continue; }
    if (r.status === "reconnect-required") {
      s.usersReconnectRequired++;
      perUser.push(`  ${userId}  RECONNECT REQUIRED -- ${String(r.error ?? "").slice(0, 160)}`);
      continue;
    }
    if (r.status === "fetch-failed" || r.status === "refresh-token-expired") {
      s.usersFetchFailed++;
      perUser.push(`  ${userId}  ${r.status} -- ${String(r.error ?? "").slice(0, 160)}`);
      continue;
    }

    s.ordersFetched += r.ordersFetched;
    s.ordersProcessed += r.ordersProcessed;
    s.lines += r.lineItemsProcessed;
    s.resolvedAuto += r.resolvedAuto;
    s.parked += r.parked;
    s.unresolvable += r.unresolvable;
    s.recorded += r.recorded;
    s.recordedViaHolding += r.recordedViaHolding;
    s.recordedViaAccount += r.recordedViaAccount;
    s.holdingsMarked += r.holdingsMarked;
    s.noMatchingHolding += r.noMatchingHolding;
    s.markFailures += r.markFailures;
    s.failed += r.failed;

    perUser.push(
      `  ${userId}  orders ${String(r.ordersFetched).padStart(4)}  lines ${String(r.lineItemsProcessed).padStart(4)}` +
      `  auto ${String(r.resolvedAuto).padStart(4)}  parked ${String(r.parked).padStart(4)}` +
      `  unresolvable ${String(r.unresolvable).padStart(4)}  recorded ${String(r.recorded).padStart(4)}` +
      `  holdings ${String(r.holdingsMarked).padStart(3)}  failed ${String(r.failed).padStart(3)}`,
    );

    if (PER_USER_DELAY_MS) await sleep(PER_USER_DELAY_MS);
  }

  console.log(`\nper user:`);
  for (const line of perUser) console.log(line);

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users attempted            ${f(s.usersAttempted)}`);
  console.log(`    reconnect required       ${f(s.usersReconnectRequired)}   <- skipped; the account page asks them to re-authorise`);
  console.log(`    no token record          ${f(s.usersNoToken)}`);
  console.log(`    fetch / token failed     ${f(s.usersFetchFailed)}`);
  console.log(`    not reached              ${f(s.usersNotReached)}`);
  console.log(`  orders fetched             ${f(s.ordersFetched)}`);
  console.log(`  orders processed           ${f(s.ordersProcessed)}   <- the cursor would be allowed past these`);
  console.log(`  SOLD LINES                 ${f(s.lines)}   <- the sub-totals below, which sum to it`);
  console.log(`    resolved (auto, >= 0.9)  ${f(s.resolvedAuto)}`);
  console.log(`    PARKED (best candidate)  ${f(s.parked)}   <- awaiting the user's confirm; an ACQUISITION list`);
  console.log(`    unresolvable             ${f(s.unresolvable)}   <- no title, not a card, or no number/year/set`);
  console.log(`  SALES IN THE POOL          ${f(s.recorded)}`);
  console.log(`    via the holding's ledger ${f(s.recordedViaHolding)}   <- source ebay-user-sale, under the holding's pinned slug`);
  console.log(`    via ebay-account         ${f(s.recordedViaAccount)}   <- source ebay-account, under the resolved slug`);
  console.log(`  holdings marked sold       ${f(s.holdingsMarked)}`);
  console.log(`  no holding for the sale    ${f(s.noMatchingHolding)}   <- NOT a failure: the sale is still recorded`);
  console.log(`  mark failures              ${f(s.markFailures)}`);
  console.log(`  write failures             ${f(s.failed)}`);

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. Every sold line is written, skipped by
  // design, or failed. CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: recordedViaHolding
  // and recordedViaAccount are sub-totals of `written` and stay on their own
  // lines above -- folding either into `skipped` would over-account and the
  // equation would read as clean while being arithmetically false.
  //
  // A REPORT-ONLY run reconciles too: it intends nothing, so `intended` is 0
  // and reportWrites is a no-op banner rather than a false green.
  if (APPLY) {
    const skipped = Math.max(0, s.lines - s.recorded - s.failed);
    reportWrites({
      job: "backfill-ebay-account-sales",
      intended: s.lines,
      written: s.recorded,
      skipped,
      failed: s.failed,
      // Tens of rows, not millions: one unaccounted line has to be red.
      tolerance: 0,
    });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
