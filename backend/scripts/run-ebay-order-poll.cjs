#!/usr/bin/env node
/**
 * run-ebay-order-poll.cjs — the hourly eBay order poll, run on the backfill
 * runner instead of inside the API process (Drew, 2026-08-30: "cut over to the
 * GH cron; flip the flag").
 *
 * Why here: the in-process scheduler doubled (64 cycles/24h across 2 workers —
 * an App Service restart re-arms the first-run timer inside the lock TTL) and
 * its reconciliation exit code meant nothing in a web process. On a runner a
 * shortfall goes red.
 *
 * Same code as the API's job: every connected user through
 * pollEbayOrdersForUser (D26: resolve → record → mark → cursor advance), the
 * user's own lastPolledAt cursor. Writes and cursor moves happen only with
 * BACKFILL_APPLY=true; otherwise every user runs dryRun and nothing is written.
 *
 * Reconciliation: intended = line items processed; written = sales recorded;
 * skipped = the rest (parked / unresolvable / already recorded); failed =
 * failed + markFailures. Exit 1 on a thrown per-user error; reconnect-required
 * and fetch-failed users are reported, not counted as failures (they are
 * states the account page shows).
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET (ebayAuth throws at import without it); BACKFILL_APPLY.
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  const { pollEbayOrdersForUser } = require(path.join(backend, "dist/services/ebay/ebayOrderPoll.service.js"));
  const { listConnectedUserIds } = require(path.join(backend, "dist/services/ebay/ebayTokenStore.service.js"));
  console.log(`run-ebay-order-poll  ${APPLY ? "APPLY (records sales, marks holdings, advances cursors)" : "REPORT ONLY -- nothing written, cursors untouched"}  env=${process.env.EBAY_ENV || "(default)"}`);

  const users = [...new Set((await listConnectedUserIds()).filter(Boolean))].sort();
  console.log(`connected users: ${users.length}`);
  const s = { users: 0, reconnect: 0, fetchFailed: 0, ordersFetched: 0, ordersProcessed: 0, cursors: 0, lines: 0, resolved: 0, parked: 0, unresolvable: 0, recorded: 0, viaHolding: 0, viaAccount: 0, marked: 0, failed: 0, errors: 0 };
  for (const userId of users) {
    s.users++;
    try {
      const r = await pollEbayOrdersForUser(userId, { dryRun: !APPLY });
      s.ordersFetched += r.ordersFetched ?? 0; s.ordersProcessed += r.ordersProcessed ?? 0; s.lines += r.lineItemsProcessed ?? 0;
      s.resolved += r.resolvedAuto ?? 0; s.parked += r.parked ?? 0; s.unresolvable += r.unresolvable ?? 0;
      s.recorded += r.recorded ?? 0; s.viaHolding += r.recordedViaHolding ?? 0; s.viaAccount += r.recordedViaAccount ?? 0;
      s.marked += r.holdingsMarked ?? 0; s.failed += (r.failed ?? 0) + (r.markFailures ?? 0);
      if (r.cursorAdvanced) s.cursors++;
      if (r.status === "fetch-failed") s.fetchFailed++;
      if (r.status === "reconnect-required") { s.reconnect++; console.log(`  reconnect-required: ${String(userId).slice(0, 13)}`); }
    } catch (e) {
      s.errors++;
      console.error(`  ERROR ${String(userId).slice(0, 13)}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users attempted       ${f(s.users)}   reconnect-required ${f(s.reconnect)}   fetch-failed ${f(s.fetchFailed)}`);
  console.log(`  orders fetched        ${f(s.ordersFetched)}   processed ${f(s.ordersProcessed)}   cursors advanced ${f(s.cursors)}`);
  console.log(`  line items            ${f(s.lines)}   resolved ${f(s.resolved)}   parked ${f(s.parked)}   unresolvable ${f(s.unresolvable)}`);
  console.log(`  RECORDED              ${f(s.recorded)}   <- via holding ${f(s.viaHolding)} / via account ${f(s.viaAccount)}`);
  console.log(`  holdings marked sold  ${f(s.marked)}`);
  console.log(`  failed                ${f(s.failed)}   per-user errors ${f(s.errors)}`);
  if (APPLY) reportWrites({ job: "run-ebay-order-poll", intended: s.lines, written: s.recorded, skipped: Math.max(0, s.lines - s.recorded - s.failed), failed: s.failed });
  if (s.errors > 0) { console.error(`FATAL: ${s.errors} per-user error(s)`); process.exit(1); }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || e); process.exit(3); });
