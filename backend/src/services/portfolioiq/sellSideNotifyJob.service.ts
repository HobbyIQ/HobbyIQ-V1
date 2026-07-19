// CF-SELL-SIDE-NOTIFY (Drew, 2026-07-18). Nightly job that walks every
// user's holdings, compares canonical FMV against the last
// notification snapshot, and emits a push when a holding lifts
// materially. Turns HobbyIQ into a daily-open app: "your Hartman
// True Blue projected next sale $1,420, +8.8% in 10 days. List now?"
//
// Rate limits:
//   - Per-user: max 3 sell-side pushes / day
//   - Per-holding: max 1 push / 48 hours
//   - Cool-off after user dismisses/ignores: 7 days on same holding
//
// Trigger threshold: |delta| >= LIFT_THRESHOLD_PCT (default 5%). Only
// emits when the delta EXCEEDS this AND the delta is UP (falls are
// noise for a sell-side push — a Sell-Side Alert user cares about
// upside, not being told their card cratered while they slept).

import {
  listAllPortfolioUserIds,
  readUserDoc,
  writeUserDoc,
} from "./portfolioStore.service.js";
import { computeCanonicalFmv } from "../compiq/canonicalFmv.service.js";
import { sendPriceAlertNotification } from "../notification.service.js";

interface HoldingWithNotifyState {
  id: string;
  cardId?: string;
  playerName?: string;
  parallel?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  cardYear?: number | null;
  product?: string | null;
  cardNumber?: string | null;
  // Sell-side notify persistence
  sellSideProjectedAtLastNotify?: number | null;
  sellSideNotifyLastAt?: string | null;
  sellSideNotifyDismissedAt?: string | null;
}

export interface SellSideNotifyJobOptions {
  liftThresholdPct?: number;         // default 5
  perUserDailyCap?: number;          // default 3
  perHoldingCooldownHours?: number;  // default 48
  dismissCooldownDays?: number;      // default 7
  dryRun?: boolean;                  // when true, doesn't send OR persist
}

export interface SellSideNotifyJobSummary {
  usersScanned: number;
  holdingsScanned: number;
  candidatesForNotify: number;
  pushesSent: number;
  pushesSkipped: {
    belowThreshold: number;
    userDailyCapHit: number;
    holdingCooldownActive: number;
    dismissCooldownActive: number;
    canonicalFmvUnavailable: number;
    noProjectionChange: number;
  };
  dryRun: boolean;
}

const DEFAULT_THRESHOLD_PCT = 5;
const DEFAULT_USER_DAILY_CAP = 3;
const DEFAULT_HOLDING_COOLDOWN_HOURS = 48;
const DEFAULT_DISMISS_COOLDOWN_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Run the sell-side notify job for every user. Idempotent — persisting
 * lastNotify state prevents re-firing the same push on repeated runs.
 */
export async function runSellSideNotifyJob(
  opts: SellSideNotifyJobOptions = {},
): Promise<SellSideNotifyJobSummary> {
  const threshold = opts.liftThresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const userCap = opts.perUserDailyCap ?? DEFAULT_USER_DAILY_CAP;
  const holdingCooldownMs = (opts.perHoldingCooldownHours ?? DEFAULT_HOLDING_COOLDOWN_HOURS) * HOUR_MS;
  const dismissCooldownMs = (opts.dismissCooldownDays ?? DEFAULT_DISMISS_COOLDOWN_DAYS) * DAY_MS;
  const dryRun = opts.dryRun === true;
  const nowMs = Date.now();

  const summary: SellSideNotifyJobSummary = {
    usersScanned: 0,
    holdingsScanned: 0,
    candidatesForNotify: 0,
    pushesSent: 0,
    pushesSkipped: {
      belowThreshold: 0,
      userDailyCapHit: 0,
      holdingCooldownActive: 0,
      dismissCooldownActive: 0,
      canonicalFmvUnavailable: 0,
      noProjectionChange: 0,
    },
    dryRun,
  };

  const userIds = await listAllPortfolioUserIds();

  for (const userId of userIds) {
    summary.usersScanned++;
    let doc;
    try { doc = await readUserDoc(userId); } catch { continue; }
    const holdings = Object.values(doc.holdings ?? {}) as HoldingWithNotifyState[];
    if (holdings.length === 0) continue;

    // Per-user daily cap: count pushes fired in last 24h.
    let userPushesToday = 0;
    for (const h of holdings) {
      const lastAt = h.sellSideNotifyLastAt ? Date.parse(h.sellSideNotifyLastAt) : NaN;
      if (Number.isFinite(lastAt) && (nowMs - lastAt) < DAY_MS) userPushesToday++;
    }

    // Compute + rank candidates by absolute lift $ so the biggest
    // moves get pushed first (respects the daily cap correctly).
    const candidates: Array<{
      holding: HoldingWithNotifyState;
      currentFmv: number;
      previousFmv: number | null;
      deltaAbs: number;
      deltaPct: number;
    }> = [];

    for (const h of holdings) {
      summary.holdingsScanned++;

      // Per-holding cooldown
      const lastNotifyAt = h.sellSideNotifyLastAt ? Date.parse(h.sellSideNotifyLastAt) : NaN;
      if (Number.isFinite(lastNotifyAt) && (nowMs - lastNotifyAt) < holdingCooldownMs) {
        summary.pushesSkipped.holdingCooldownActive++;
        continue;
      }

      // Dismiss cooldown
      const dismissAt = h.sellSideNotifyDismissedAt ? Date.parse(h.sellSideNotifyDismissedAt) : NaN;
      if (Number.isFinite(dismissAt) && (nowMs - dismissAt) < dismissCooldownMs) {
        summary.pushesSkipped.dismissCooldownActive++;
        continue;
      }

      if (!h.cardId || !h.playerName) continue;

      const canonical = await computeCanonicalFmv({
        cardId: h.cardId,
        parallel: h.parallel ?? null,
        gradeCompany: h.gradeCompany ?? null,
        gradeValue: h.gradeValue ?? null,
        cardYear: h.cardYear ?? null,
        product: h.product ?? null,
        player: h.playerName,
        cardNumber: h.cardNumber ?? null,
      }).catch(() => null);

      if (!canonical || canonical.fmv === null || canonical.fmv <= 0) {
        summary.pushesSkipped.canonicalFmvUnavailable++;
        continue;
      }
      const currentFmv = canonical.fmv;
      const previous = typeof h.sellSideProjectedAtLastNotify === "number"
        ? h.sellSideProjectedAtLastNotify
        : null;

      if (previous === null) {
        // First-observation baseline. Persist current as the reference
        // point, don't push yet — need a delta to push.
        if (!dryRun) {
          h.sellSideProjectedAtLastNotify = currentFmv;
        }
        summary.pushesSkipped.noProjectionChange++;
        continue;
      }

      const deltaAbs = currentFmv - previous;
      const deltaPct = (deltaAbs / previous) * 100;

      // Sell-side push: only fires on UP moves above threshold.
      if (deltaPct < threshold) {
        summary.pushesSkipped.belowThreshold++;
        continue;
      }

      candidates.push({
        holding: h,
        currentFmv,
        previousFmv: previous,
        deltaAbs,
        deltaPct,
      });
    }

    // Rank: biggest absolute lift first
    candidates.sort((a, b) => b.deltaAbs - a.deltaAbs);
    summary.candidatesForNotify += candidates.length;

    for (const cand of candidates) {
      if (userPushesToday >= userCap) {
        summary.pushesSkipped.userDailyCapHit++;
        continue;
      }

      const title = pushTitle(cand);
      const body = pushBody(cand);

      if (dryRun) {
        summary.pushesSent++;
        userPushesToday++;
        continue;
      }

      try {
        const result = await sendPriceAlertNotification(userId, {
          title,
          body,
          cardId: cand.holding.cardId,
        });
        if (result.sent > 0) {
          summary.pushesSent++;
          userPushesToday++;
          cand.holding.sellSideNotifyLastAt = new Date(nowMs).toISOString();
          cand.holding.sellSideProjectedAtLastNotify = cand.currentFmv;
        }
      } catch { /* per-holding failure never halts the job */ }
    }

    if (!dryRun) {
      try { await writeUserDoc(userId, doc); } catch { /* silent */ }
    }
  }

  console.log(JSON.stringify({
    event: "sell_side_notify.job_complete",
    source: "sellSideNotifyJob.service",
    ...summary,
  }));

  return summary;
}

function pushTitle(cand: {
  holding: HoldingWithNotifyState;
  deltaPct: number;
}): string {
  const player = cand.holding.playerName ?? "Your card";
  const parallel = cand.holding.parallel ? ` ${cand.holding.parallel}` : "";
  return `${player}${parallel} lifted`;
}

function pushBody(cand: {
  currentFmv: number;
  previousFmv: number | null;
  deltaAbs: number;
  deltaPct: number;
}): string {
  const currency = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const prev = cand.previousFmv !== null ? currency(cand.previousFmv) : "prior FMV";
  const pctSigned = cand.deltaPct >= 0 ? `+${cand.deltaPct.toFixed(1)}` : cand.deltaPct.toFixed(1);
  return `${prev} → ${currency(cand.currentFmv)} projected sale (${pctSigned}%). List now?`;
}
