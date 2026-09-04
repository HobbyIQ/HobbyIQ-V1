/**
 * CF-WEEKLY-EBAY-PURCHASE-SYNC (Drew, 2026-08-03).
 *
 * Sunday-morning scheduled job: walk every user with an eBay connection
 * and pull their last 7 days of purchases via importEbayPurchaseHistory.
 * With EBAY_IMPORT_FORCE_REVIEW=true, each imported purchase lands in
 * the review queue for user confirmation instead of auto-creating a
 * holding.
 *
 * Cadence: fires when the hourly tick lands in the WEEKLY_EBAY_SYNC_HOUR_UTC
 * window (default 06:00-07:00 UTC = 2-3 AM ET) on Sunday, and today's
 * run hasn't fired yet.
 *
 * Idempotent: importEbayPurchaseHistory dedupes on
 * ebayOrderLineItemId, so multiple invocations on the same Sunday are
 * safe (though only the first should fire in practice).
 *
 * Env:
 *   WEEKLY_EBAY_PURCHASE_SYNC_ENABLED  "true" to run (default off)
 *   WEEKLY_EBAY_SYNC_HOUR_UTC          fire hour (0-23, default 6)
 *   WEEKLY_EBAY_SYNC_DAYS              days back to import (default 7)
 *
 * Same scheduler shell pattern as ebayOrderPoll.job.ts: overlap guard,
 * fire-and-forget error catch.
 */

import { importEbayPurchaseHistory } from "../services/ebay/ebayBuyerHistory.service.js";
import { isTerminalTokenError } from "../services/ebay/ebayAuth.service.js";
import { listConnectedUserIds, markReconnectRequired } from "../services/ebay/ebayTokenStore.service.js";
import { runSingleFlight } from "./_singleFlight.js";

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PER_USER_DELAY_MS = 1000; // polite spacing (eBay Trading API caps)

let _running = false;
let _lastRunDay: string | null = null; // yyyy-mm-dd of last successful run
let _intervalTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFireWindow(now: Date): boolean {
  const fireHour = Number(process.env.WEEKLY_EBAY_SYNC_HOUR_UTC ?? "6");
  const day = now.getUTCDay(); // 0 = Sunday
  return day === 0 && now.getUTCHours() === fireHour;
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface WeeklyPurchaseSyncSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  daysWindow: number;
  usersAttempted: number;
  usersFetched: number;
  purchasesImported: number;
  purchasesReplayed: number;
  purchasesSkipped: number;
  /** Users whose eBay grant is dead (invalid_grant / invalid_scope / expired
   *  refresh). A per-user CONDITION, not a data failure: nothing was written
   *  for them, nothing was lost, and the user has to reconnect. Counted in
   *  USERS, never in purchases. */
  usersNeedingReconnect: number;
  /** Who they are and why, so the run reports the condition per user instead
   *  of leaving it in a stack trace. */
  reconnectRequired: Array<{ userId: string; error: string }>;
  /** Users whose import failed for a reason that is NOT a dead grant -- an
   *  eBay 5xx, a parse failure, a Cosmos write. These are DATA failures and
   *  are the only thing that may fail the job. Counted in USERS. */
  usersFailed: number;
  dataFailures: Array<{ userId: string; error: string }>;
  /** Back-compat: total errored users (reconnect + data). Kept so existing
   *  readers of the summary event do not break. NOT a purchase count -- the
   *  reconciliation must never charge this against purchases (see below). */
  errors: number;
}

export async function runWeeklyEbayPurchaseSync(): Promise<WeeklyPurchaseSyncSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[ebay.weekly.purchase.sync] already running; skipping overlap");
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      daysWindow: 0,
      usersAttempted: 0,
      usersFetched: 0,
      purchasesImported: 0,
      purchasesReplayed: 0,
      purchasesSkipped: 0,
      usersNeedingReconnect: 0,
      reconnectRequired: [],
      usersFailed: 0,
      dataFailures: [],
      errors: 0,
    };
  }
  _running = true;

  const daysWindow = Math.max(1, Math.min(90, Number(process.env.WEEKLY_EBAY_SYNC_DAYS ?? "7")));
  let usersAttempted = 0;
  let usersFetched = 0;
  let purchasesImported = 0;
  let purchasesReplayed = 0;
  let purchasesSkipped = 0;
  let errors = 0;
  const reconnectRequired: Array<{ userId: string; error: string }> = [];
  const dataFailures: Array<{ userId: string; error: string }> = [];

  try {
    const userIds = await listConnectedUserIds();
    console.log(`[ebay.weekly.purchase.sync] start users=${userIds.length} days=${daysWindow}`);
    for (const userId of userIds) {
      usersAttempted++;
      try {
        const summary = await importEbayPurchaseHistory(userId, daysWindow);
        usersFetched++;
        purchasesImported += summary.imported;
        purchasesReplayed += summary.replayHits;
        purchasesSkipped += summary.skipped;
        console.log(JSON.stringify({
          event: "weekly_ebay_purchase_sync_user",
          source: "ebayPurchaseSync.job",
          userId,
          days: daysWindow,
          fetched: summary.fetched,
          imported: summary.imported,
          replayed: summary.replayHits,
          skipped: summary.skipped,
        }));
      } catch (err) {
        // A dead eBay grant is a PER-USER CONDITION, not a job failure. The
        // run that found this (33848620910) went red on two users whose
        // refresh tokens eBay had already refused -- one `invalid_scope`
        // (the grant predates the scope set the client now asks for), one
        // `invalid_grant` (revoked/expired). Neither lost a single purchase:
        // nothing was fetched, so nothing could go missing. Reporting them
        // as errors and failing the job hides the seven users who synced
        // fine, and tells nobody the two need to reconnect.
        const msg = String((err as Error)?.message ?? err);
        errors++;
        if (isTerminalTokenError(msg)) {
          reconnectRequired.push({ userId, error: msg.slice(0, 300) });
          // Belt: `getAccessToken` already marks on this path, and the mark
          // is idempotent, so a second call is free. This is the ONLY thing
          // that makes the condition visible to the user -- GET /api/ebay/
          // status reads it back as `status: "reconnect-required"`.
          await markReconnectRequired(userId, msg.slice(0, 200)).catch(() => false);
          console.warn(JSON.stringify({
            event: "weekly_ebay_purchase_sync_reconnect_required",
            source: "ebayPurchaseSync.job",
            userId,
            error: msg.slice(0, 300),
          }));
        } else {
          dataFailures.push({ userId, error: msg.slice(0, 300) });
          console.error(`[ebay.weekly.purchase.sync] user=${userId} DATA failure:`, msg);
        }
      }
      if (PER_USER_DELAY_MS > 0) await sleep(PER_USER_DELAY_MS);
    }
  } catch (err) {
    // The whole run died (listConnectedUserIds threw, etc.). That IS a data
    // failure: work that was intended never happened.
    const msg = String((err as Error)?.message ?? err);
    errors++;
    dataFailures.push({ userId: "(job)", error: msg.slice(0, 300) });
    console.error("[ebay.weekly.purchase.sync] fatal:", msg);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  const summary: WeeklyPurchaseSyncSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    daysWindow,
    usersAttempted,
    usersFetched,
    purchasesImported,
    purchasesReplayed,
    purchasesSkipped,
    usersNeedingReconnect: reconnectRequired.length,
    reconnectRequired,
    usersFailed: dataFailures.length,
    dataFailures,
    errors,
  };
  console.log(JSON.stringify({
    event: "weekly_ebay_purchase_sync_summary",
    source: "ebayPurchaseSync.job",
    ...summary,
  }));
  return summary;
}

async function tick(): Promise<void> {
  if (process.env.WEEKLY_EBAY_PURCHASE_SYNC_ENABLED !== "true") return;
  const now = new Date();
  if (!isFireWindow(now)) return;
  const key = todayKey(now);
  if (_lastRunDay === key) return; // already ran today
  _lastRunDay = key;
  try {
    await runWeeklyEbayPurchaseSync();
  } catch (err) {
    console.error("[ebay.weekly.purchase.sync] tick error:", (err as Error)?.message ?? err);
  }
}

export function startWeeklyEbayPurchaseSyncJob(): void {
  if (_intervalTimer) return;
  console.log(`[ebay.weekly.purchase.sync] scheduler armed (enabled=${process.env.WEEKLY_EBAY_PURCHASE_SYNC_ENABLED === "true"}, fireHourUTC=${process.env.WEEKLY_EBAY_SYNC_HOUR_UTC ?? "6"}, days=${process.env.WEEKLY_EBAY_SYNC_DAYS ?? "7"})`);
  // Fire once shortly after boot to catch the case where the process
  // restarted inside the fire window on Sunday.
  setTimeout(() => { void runSingleFlight("ebay.weekly.purchase.sync", TICK_INTERVAL_MS, tick); }, 90_000);
  _intervalTimer = setInterval(() => { void runSingleFlight("ebay.weekly.purchase.sync", TICK_INTERVAL_MS, tick); }, TICK_INTERVAL_MS);
}

export function stopWeeklyEbayPurchaseSyncJob(): void {
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
