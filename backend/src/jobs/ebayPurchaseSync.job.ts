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
import { listConnectedUserIds } from "../services/ebay/ebayTokenStore.service.js";
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
        errors++;
        console.error(`[ebay.weekly.purchase.sync] user=${userId} threw:`, (err as Error)?.message ?? err);
      }
      if (PER_USER_DELAY_MS > 0) await sleep(PER_USER_DELAY_MS);
    }
  } catch (err) {
    errors++;
    console.error("[ebay.weekly.purchase.sync] fatal:", (err as Error)?.message ?? err);
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
