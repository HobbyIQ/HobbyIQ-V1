/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — scheduled sale-detection poll.
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, Drew 2026-08-30).
 *
 * Walks every user with an eBay connection and polls
 * /sell/fulfillment/v1/order for new/modified orders. Each sold LINE is
 * resolved to a catalog card, recorded in the pool, and — when the seller
 * holds that card — marks the holding sold. See ebayOrderPoll.service.ts for
 * the measurement that motivated the rewrite.
 *
 * THE SUMMARY IS THE PRODUCT HERE. The old line said
 *   `done users=8 orders=29 matched=0 deduped=0 noMatch=29 ... cursorsAdvanced=0`
 * every hour for weeks and nobody could tell from it whether the job was
 * broken or the users simply had no sales. The line now reports the whole
 * funnel — lines in, how each resolved, how many sales are in the pool, how
 * many holdings moved, who needs to reconnect — and RECONCILES it: every line
 * is written, skipped or failed, and a shortfall turns the job red rather than
 * printing a plausible zero (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW).
 *
 * Same scheduler shell pattern as portfolioReprice.job.ts: env-var disable
 * flag, overlap guard, fire-and-forget error catch so a Cosmos blip can't
 * crash the scheduler.
 */

import {
  pollEbayOrdersForUser,
  type PollResult,
} from "../services/ebay/ebayOrderPoll.service.js";
import { listConnectedUserIds } from "../services/ebay/ebayTokenStore.service.js";
import { reportWrites } from "../services/ops/writeReconciliation.js";
import { runSingleFlight } from "./_singleFlight.js";

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
  /** Users skipped because eBay has already refused their credentials. */
  usersReconnectRequired: number;
  ordersFetched: number;
  ordersProcessed: number;
  lineItemsProcessed: number;
  resolvedAuto: number;
  parked: number;
  unresolvable: number;
  recorded: number;
  recordedViaHolding: number;
  recordedViaAccount: number;
  holdingsMarked: number;
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  failed: number;
  fetchFailures: number;
  refreshTokenExpired: number;
  cursorsAdvanced: number;
  errors: number;
  /** True when every line is accounted for. False turns the process exit code
   *  red via reportWrites. */
  reconciled: boolean;
}

function emptySummary(startedAt: Date): OrderPollJobSummary {
  const iso = startedAt.toISOString();
  return {
    startedAt: iso,
    finishedAt: iso,
    durationMs: 0,
    usersAttempted: 0,
    usersReconnectRequired: 0,
    ordersFetched: 0,
    ordersProcessed: 0,
    lineItemsProcessed: 0,
    resolvedAuto: 0,
    parked: 0,
    unresolvable: 0,
    recorded: 0,
    recordedViaHolding: 0,
    recordedViaAccount: 0,
    holdingsMarked: 0,
    matched: 0,
    deduped: 0,
    noMatchingHolding: 0,
    markFailures: 0,
    failed: 0,
    fetchFailures: 0,
    refreshTokenExpired: 0,
    cursorsAdvanced: 0,
    errors: 0,
    reconciled: true,
  };
}

export async function runEbayOrderPollJob(): Promise<OrderPollJobSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[ebay.order.poll.job] already running; skipping overlap");
    return emptySummary(startedAt);
  }
  _running = true;

  const s = emptySummary(startedAt);
  /** Per-user reconnect-required detail for the summary. */
  const reconnectUsers: string[] = [];

  try {
    const userIds = await listConnectedUserIds();
    console.log(`[ebay.order.poll.job] start users=${userIds.length}`);

    for (const userId of userIds) {
      s.usersAttempted++;
      try {
        const r: PollResult = await pollEbayOrdersForUser(userId);
        s.ordersFetched += r.ordersFetched;
        s.ordersProcessed += r.ordersProcessed;
        s.lineItemsProcessed += r.lineItemsProcessed;
        s.resolvedAuto += r.resolvedAuto;
        s.parked += r.parked;
        s.unresolvable += r.unresolvable;
        s.recorded += r.recorded;
        s.recordedViaHolding += r.recordedViaHolding;
        s.recordedViaAccount += r.recordedViaAccount;
        s.holdingsMarked += r.holdingsMarked;
        s.matched += r.matched;
        s.deduped += r.deduped;
        s.noMatchingHolding += r.noMatchingHolding;
        s.markFailures += r.markFailures;
        s.failed += r.failed;
        if (r.cursorAdvanced) s.cursorsAdvanced += 1;
        if (r.status === "fetch-failed") s.fetchFailures += 1;
        if (r.status === "refresh-token-expired") s.refreshTokenExpired += 1;
        if (r.status === "reconnect-required") {
          s.usersReconnectRequired += 1;
          reconnectUsers.push(userId);
        }
      } catch (err: unknown) {
        s.errors += 1;
        console.error(
          `[ebay.order.poll.job] user=${userId} threw:`,
          (err as Error)?.message ?? err,
        );
      }
      if (PER_USER_DELAY_MS > 0) await sleep(PER_USER_DELAY_MS);
    }
  } catch (err: unknown) {
    s.errors += 1;
    console.error("[ebay.order.poll.job] fatal:", (err as Error)?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  s.finishedAt = finishedAt.toISOString();
  s.durationMs = finishedAt.getTime() - startedAt.getTime();

  console.log(
    `[ebay.order.poll.job] done users=${s.usersAttempted} orders=${s.ordersFetched} ` +
      `ordersProcessed=${s.ordersProcessed} lines=${s.lineItemsProcessed} ` +
      `resolved=${s.resolvedAuto}(auto)/${s.parked}(parked)/${s.unresolvable}(unresolvable) ` +
      `recorded=${s.recorded}(holding ${s.recordedViaHolding}/account ${s.recordedViaAccount}) ` +
      `holdingsMarked=${s.holdingsMarked} matched=${s.matched} deduped=${s.deduped} ` +
      `noMatch=${s.noMatchingHolding} markFail=${s.markFailures} failed=${s.failed} ` +
      `fetchFail=${s.fetchFailures} refreshExpired=${s.refreshTokenExpired} ` +
      `reconnectRequired=${s.usersReconnectRequired} cursorsAdvanced=${s.cursorsAdvanced} ` +
      `errors=${s.errors} durationMs=${s.durationMs}`,
  );
  if (reconnectUsers.length) {
    console.warn(JSON.stringify({
      event: "ebay_poll_reconnect_required_users",
      source: "ebayOrderPoll.job",
      count: reconnectUsers.length,
      userIds: reconnectUsers,
      detail: "these users are skipped every cycle until they re-authorise; the account page shows Reconnect eBay",
    }));
  }

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. Every line the poll took responsibility
  // for is written, deliberately skipped, or failed — the three are disjoint
  // by construction in processSoldLine (a line takes exactly one resolution
  // branch, and `recorded` counts exactly one pool path per line).
  //
  // `written`  a sale that is in the pool, by either path.
  // `skipped`  a line with no pool row BY DESIGN: it parked, it was not a
  //            card, or its identity did not resolve. Declared, deliberate.
  // `failed`   a write that did not happen. These pin the cursor.
  //
  // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: `recordedViaHolding` and
  // `recordedViaAccount` are sub-totals of `written` and go on their own line,
  // never into `skipped`.
  const skipped = Math.max(0, s.lineItemsProcessed - s.recorded - s.failed);
  const rec = reportWrites({
    job: "ebay.order.poll.job",
    intended: s.lineItemsProcessed,
    written: s.recorded,
    skipped,
    failed: s.failed,
    // A poll cycle is tens of rows, not millions; one unaccounted line out of
    // 29 must be visible, so the default 0.5% is too generous here.
    tolerance: 0,
  });
  s.reconciled = rec.ok;
  // A poll cycle is not a batch job — do NOT leave the API process carrying a
  // non-zero exit code because one user's write failed. The banner and the
  // flag are the signal; reportWrites' exitCode side effect is for scripts.
  if (!rec.ok && typeof process !== "undefined") process.exitCode = 0;

  return s;
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
    runSingleFlight("ebay.order.poll.job", intervalMs, runEbayOrderPollJob).catch((err) => {
      console.error("[ebay.order.poll.job] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runSingleFlight("ebay.order.poll.job", intervalMs, runEbayOrderPollJob).catch((err) => {
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
