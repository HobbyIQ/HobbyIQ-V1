/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — scheduled sale-detection poll.
 *
 * Periodically (every PORTFOLIO_EBAY_POLL_INTERVAL_HOURS, default 1h)
 * walks every user with an eBay connection and polls
 * /sell/fulfillment/v1/order for new/modified orders. Each line item is
 * matched to a HobbyIQ holding by ebayListingId and written to the
 * ledger via the existing markHoldingSoldFromEbay path.
 *
 * Separate logical job from the 6h Finances enrichment sweep (Track 1
 * Slice C) — they read different eBay resources, have different cadence,
 * and have independent failure modes.
 *
 * Same scheduler shell pattern as portfolioReprice.job.ts: env-var
 * disable flag, overlap guard, fire-and-forget error catch so a Cosmos
 * blip can't crash the scheduler.
 */

import {
  pollEbayOrdersForUser,
  type PollResult,
} from "../services/ebay/ebayOrderPoll.service.js";
import { listConnectedUserIds } from "../services/ebay/ebayTokenStore.service.js";

const DEFAULT_INTERVAL_HOURS = 1;
const DEFAULT_FIRST_DELAY_MS = 60_000;       // 60s after process boot
const PER_USER_DELAY_MS = 100;               // polite spacing between users

let _running = false;
let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OrderPollJobSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  usersAttempted: number;
  ordersFetched: number;
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  fetchFailures: number;
  refreshTokenExpired: number;
  cursorsAdvanced: number;
  errors: number;
}

export async function runEbayOrderPollJob(): Promise<OrderPollJobSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[ebay.order.poll.job] already running; skipping overlap");
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      usersAttempted: 0,
      ordersFetched: 0,
      matched: 0,
      deduped: 0,
      noMatchingHolding: 0,
      markFailures: 0,
      fetchFailures: 0,
      refreshTokenExpired: 0,
      cursorsAdvanced: 0,
      errors: 0,
    };
  }
  _running = true;

  let usersAttempted = 0;
  let ordersFetched = 0;
  let matched = 0;
  let deduped = 0;
  let noMatchingHolding = 0;
  let markFailures = 0;
  let fetchFailures = 0;
  let refreshTokenExpired = 0;
  let cursorsAdvanced = 0;
  let errors = 0;

  try {
    const userIds = await listConnectedUserIds();
    console.log(`[ebay.order.poll.job] start users=${userIds.length}`);

    for (const userId of userIds) {
      usersAttempted++;
      try {
        const r: PollResult = await pollEbayOrdersForUser(userId);
        ordersFetched += r.ordersFetched;
        matched += r.matched;
        deduped += r.deduped;
        noMatchingHolding += r.noMatchingHolding;
        markFailures += r.markFailures;
        if (r.cursorAdvanced) cursorsAdvanced += 1;
        if (r.status === "fetch-failed") fetchFailures += 1;
        if (r.status === "refresh-token-expired") refreshTokenExpired += 1;
      } catch (err: any) {
        errors += 1;
        console.error(
          `[ebay.order.poll.job] user=${userId} threw:`,
          err?.message ?? err,
        );
      }
      if (PER_USER_DELAY_MS > 0) await sleep(PER_USER_DELAY_MS);
    }
  } catch (err: any) {
    errors += 1;
    console.error("[ebay.order.poll.job] fatal:", err?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  const summary: OrderPollJobSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    usersAttempted,
    ordersFetched,
    matched,
    deduped,
    noMatchingHolding,
    markFailures,
    fetchFailures,
    refreshTokenExpired,
    cursorsAdvanced,
    errors,
  };
  console.log(
    `[ebay.order.poll.job] done users=${usersAttempted} orders=${ordersFetched} ` +
      `matched=${matched} deduped=${deduped} noMatch=${noMatchingHolding} ` +
      `markFail=${markFailures} fetchFail=${fetchFailures} ` +
      `refreshExpired=${refreshTokenExpired} cursorsAdvanced=${cursorsAdvanced} ` +
      `errors=${errors} durationMs=${summary.durationMs}`,
  );
  return summary;
}

export function startEbayOrderPollJob(): void {
  if (process.env.EBAY_ORDER_POLL_DISABLE_SCHEDULER === "true") {
    console.log("[ebay.order.poll.job] scheduler disabled via EBAY_ORDER_POLL_DISABLE_SCHEDULER");
    return;
  }
  if (_firstRunTimer || _intervalTimer) {
    console.warn("[ebay.order.poll.job] scheduler already running; ignoring duplicate start");
    return;
  }

  const hours = Number(process.env.EBAY_ORDER_POLL_INTERVAL_HOURS ?? DEFAULT_INTERVAL_HOURS);
  const intervalMs = Math.max(15 * 60 * 1000, hours * 60 * 60 * 1000);  // floor at 15 min
  const firstDelayMs = Math.max(
    0,
    Number(process.env.EBAY_ORDER_POLL_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS),
  );

  console.log(
    `[ebay.order.poll.job] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60 / 60).toFixed(2)}h`,
  );

  _firstRunTimer = setTimeout(() => {
    runEbayOrderPollJob().catch((err) => {
      console.error("[ebay.order.poll.job] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runEbayOrderPollJob().catch((err) => {
        console.error("[ebay.order.poll.job] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopEbayOrderPollJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}
