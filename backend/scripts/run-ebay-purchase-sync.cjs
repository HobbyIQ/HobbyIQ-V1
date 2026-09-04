#!/usr/bin/env node
/**
 * run-ebay-purchase-sync.cjs — the eBay purchase (buyer-history) sync, run on
 * the backfill runner instead of inside the API process.
 *
 * Why (Drew, 2026-08-30 12:58Z: "we have A LIVE ebay purchase from import why
 * is that not included there?"): the in-process weekly job (fire hour 06 UTC,
 * hourly tick) sat behind the same single-flight lock as the order poll and
 * the fee enrichment — a lock that survives App Service restarts and is never
 * released, so after every deploy both workers skip until it expires and the
 * weekly window is missed. Telemetry: "cycle skipped — another worker holds
 * the lock" on both workers, no "start users=" line in 7 days.
 *
 * Same code as the job: runWeeklyEbayPurchaseSync → importEbayPurchaseHistory
 * per connected user over WEEKLY_EBAY_SYNC_DAYS (default 7; DAYS env here).
 * The import writes holdings/purchases — there is no dry mode in it, so
 * REPORT ONLY lists the connected users and the window and stops without
 * calling eBay; APPLY runs the import.
 *
 * Reconciliation: intended = purchases fetched; written = imported; skipped =
 * replayed (already known) + skipped; failed = errors. Exit 1 on errors.
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET; BACKFILL_APPLY; DAYS (1–90, default 7).
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const DAYS = Math.max(1, Math.min(90, Number(process.env.DAYS || process.env.WEEKLY_EBAY_SYNC_DAYS || 7)));
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  process.env.WEEKLY_EBAY_SYNC_DAYS = String(DAYS);
  process.env.WEEKLY_EBAY_PURCHASE_SYNC_ENABLED = "true";
  console.log(`run-ebay-purchase-sync  ${APPLY ? "APPLY (imports purchases into holdings)" : "REPORT ONLY -- lists users, calls nothing"}  days=${DAYS}  env=${process.env.EBAY_ENV || "(default)"}`);
  const { listConnectedUserIds } = require(path.join(backend, "dist/services/ebay/ebayTokenStore.service.js"));
  const users = [...new Set((await listConnectedUserIds()).filter(Boolean))].sort();
  console.log(`connected users: ${users.length}`);
  if (!APPLY) { console.log(`\nREPORT ONLY -- nothing written\n  users ${users.length}  window ${DAYS} day(s)  (the import has no dry mode; APPLY runs it)`); return; }
  const { runWeeklyEbayPurchaseSync } = require(path.join(backend, "dist/jobs/ebayPurchaseSync.job.js"));
  const s = await runWeeklyEbayPurchaseSync();
  const imported = Number(s.purchasesImported ?? 0);
  const replayed = Number(s.purchasesReplayed ?? 0);
  const skipped  = Number(s.purchasesSkipped ?? 0);
  const fetched  = imported + replayed + skipped;
  const reconnect = Array.isArray(s.reconnectRequired) ? s.reconnectRequired : [];
  const dataFailures = Array.isArray(s.dataFailures) ? s.dataFailures : [];

  console.log(`\nAPPLIED`);
  console.log(`  users attempted     ${f(s.usersAttempted)}   fetched ok ${f(s.usersFetched)}`);
  console.log(`  purchases           ${f(fetched)}   IMPORTED ${f(imported)}   replayed ${f(replayed)}   skipped ${f(skipped)}`);
  console.log(`  needs reconnect     ${f(reconnect.length)}   data failures ${f(dataFailures.length)}   (${f(s.durationMs)} ms, window ${s.daysWindow} d)`);

  // A dead grant is a condition to REPORT, per user, by name. It is the
  // difference between "two users must reconnect eBay" and a red X.
  if (reconnect.length > 0) {
    console.log(`\n  ${reconnect.length} user(s) must reconnect eBay -- marked reconnect-required, skipped:`);
    for (const r of reconnect) console.log(`    ${r.userId}  ${r.error}`);
  }
  if (dataFailures.length > 0) {
    console.error(`\n  ${dataFailures.length} DATA failure(s):`);
    for (const r of dataFailures) console.error(`    ${r.userId}  ${r.error}`);
  }

  // Units: every number here is PURCHASES. `s.errors` counts USERS and must
  // never appear in this equation -- that is what made the banner read OVER.
  reportWrites({
    job: "run-ebay-purchase-sync",
    intended: fetched,
    written: imported,
    skipped: replayed + skipped,
    failed: 0,
  });

  // DATA failures fail the job. Token failures do not: nothing was lost, and
  // the affected users are named above and flagged on their connection doc.
  if (dataFailures.length > 0) {
    console.error(`FATAL: ${dataFailures.length} data failure(s)`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || e); process.exit(3); });
