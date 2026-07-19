// CF-GRADE-ARBITRAGE (Drew, 2026-07-19). Nightly job that walks every
// user's RAW holdings, reads the canonical FMV response's gradeLadder,
// and pushes an alert when the top graded tier's fmv exceeds the raw
// fmv by more than a configurable multiple. Turns "you have $150 raw
// Bobby Witt sitting in a box" into "PSA 10 sells for $1,600, grade it."
//
// Rate limits:
//   - Per-user: max 2 grade-arb pushes / day (higher-signal than sell-side)
//   - Per-holding: max 1 push / 30 days
//   - Cool-off after user dismisses: 60 days
//
// Trigger: uplift >= GRADE_ARB_MIN_UPLIFT_X (default 3× the raw fmv).
// PSA 10 uplift is what iOS displays, but the job walks BGS 10 and
// SGC 10 too and picks the highest — user gets the max-value option.
//
// Sport-scoped: only runs on `sport = args.sport` holdings so we can
// stagger baseball vs football workflows and cap RU pressure.

import {
  listAllPortfolioUserIds,
  readUserDoc,
  writeUserDoc,
} from "./portfolioStore.service.js";
import { computeCanonicalFmv } from "../compiq/canonicalFmv.service.js";
import { sendPriceAlertNotification } from "../notification.service.js";

interface HoldingWithGradeArbState {
  id: string;
  cardId?: string;
  playerName?: string;
  parallel?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  cardYear?: number | null;
  product?: string | null;
  cardNumber?: string | null;
  sport?: string | null;
  // Grade-arb notify persistence
  gradeArbNotifyLastAt?: string | null;
  gradeArbNotifyDismissedAt?: string | null;
  gradeArbLastTopTier?: string | null;
  gradeArbLastUpliftX?: number | null;
}

export interface GradeArbitrageNotifyJobOptions {
  minUpliftX?: number;               // default 3 (top-tier fmv / raw fmv)
  minRawFmvUSD?: number;             // default 20 (skip low-dollar cards where grading fees dominate)
  perUserDailyCap?: number;          // default 2
  perHoldingCooldownDays?: number;   // default 30
  dismissCooldownDays?: number;      // default 60
  sport?: string | null;             // when set, only scan holdings tagged with this sport
  dryRun?: boolean;
}

export interface GradeArbitrageNotifyJobSummary {
  usersScanned: number;
  holdingsScanned: number;
  candidatesForNotify: number;
  pushesSent: number;
  pushesSkipped: {
    belowThreshold: number;
    userDailyCapHit: number;
    holdingCooldownActive: number;
    dismissCooldownActive: number;
    gradeLadderUnavailable: number;
    rawFmvUnavailable: number;
    rawFmvTooLow: number;
    holdingAlreadyGraded: number;
    sportMismatch: number;
  };
  dryRun: boolean;
  sport: string | null;
}

const DEFAULT_MIN_UPLIFT_X = 3;
const DEFAULT_MIN_RAW_FMV = 20;    // below this, grading fees ($15-$25) dominate the math
const DEFAULT_USER_DAILY_CAP = 2;
const DEFAULT_HOLDING_COOLDOWN_DAYS = 30;
const DEFAULT_DISMISS_COOLDOWN_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runGradeArbitrageNotifyJob(
  opts: GradeArbitrageNotifyJobOptions = {},
): Promise<GradeArbitrageNotifyJobSummary> {
  const minUpliftX = opts.minUpliftX ?? DEFAULT_MIN_UPLIFT_X;
  const minRawFmv = opts.minRawFmvUSD ?? DEFAULT_MIN_RAW_FMV;
  const userCap = opts.perUserDailyCap ?? DEFAULT_USER_DAILY_CAP;
  const holdingCooldownMs = (opts.perHoldingCooldownDays ?? DEFAULT_HOLDING_COOLDOWN_DAYS) * DAY_MS;
  const dismissCooldownMs = (opts.dismissCooldownDays ?? DEFAULT_DISMISS_COOLDOWN_DAYS) * DAY_MS;
  const sport = opts.sport ?? null;
  const dryRun = opts.dryRun === true;
  const nowMs = Date.now();

  const summary: GradeArbitrageNotifyJobSummary = {
    usersScanned: 0,
    holdingsScanned: 0,
    candidatesForNotify: 0,
    pushesSent: 0,
    pushesSkipped: {
      belowThreshold: 0,
      userDailyCapHit: 0,
      holdingCooldownActive: 0,
      dismissCooldownActive: 0,
      gradeLadderUnavailable: 0,
      rawFmvUnavailable: 0,
      rawFmvTooLow: 0,
      holdingAlreadyGraded: 0,
      sportMismatch: 0,
    },
    dryRun,
    sport,
  };

  const userIds = await listAllPortfolioUserIds();

  for (const userId of userIds) {
    summary.usersScanned++;
    let doc;
    try { doc = await readUserDoc(userId); } catch { continue; }
    const holdings = Object.values(doc.holdings ?? {}) as HoldingWithGradeArbState[];
    if (holdings.length === 0) continue;

    let userPushesToday = 0;
    for (const h of holdings) {
      const lastAt = h.gradeArbNotifyLastAt ? Date.parse(h.gradeArbNotifyLastAt) : NaN;
      if (Number.isFinite(lastAt) && (nowMs - lastAt) < DAY_MS) userPushesToday++;
    }

    const candidates: Array<{
      holding: HoldingWithGradeArbState;
      rawFmv: number;
      topTier: string;
      topFmv: number;
      upliftX: number;
      upliftUSD: number;
    }> = [];

    for (const h of holdings) {
      summary.holdingsScanned++;

      // Sport filter — when set, only scan matching-sport holdings
      if (sport && h.sport && h.sport !== sport) {
        summary.pushesSkipped.sportMismatch++;
        continue;
      }

      // Already-graded → nothing to arbitrage
      if (h.gradeCompany && String(h.gradeCompany).trim().length > 0) {
        summary.pushesSkipped.holdingAlreadyGraded++;
        continue;
      }

      // Per-holding cooldown (longer than sell-side: grading is a
      // once-per-holding decision, not a market-driven one)
      const lastNotifyAt = h.gradeArbNotifyLastAt ? Date.parse(h.gradeArbNotifyLastAt) : NaN;
      if (Number.isFinite(lastNotifyAt) && (nowMs - lastNotifyAt) < holdingCooldownMs) {
        summary.pushesSkipped.holdingCooldownActive++;
        continue;
      }

      // Dismiss cooldown
      const dismissAt = h.gradeArbNotifyDismissedAt ? Date.parse(h.gradeArbNotifyDismissedAt) : NaN;
      if (Number.isFinite(dismissAt) && (nowMs - dismissAt) < dismissCooldownMs) {
        summary.pushesSkipped.dismissCooldownActive++;
        continue;
      }

      if (!h.cardId || !h.playerName) continue;

      // Get canonical FMV WITH gradeLadder — always request as raw
      // (gradeCompany null) so the ladder anchors on raw fmv.
      const canonical = await computeCanonicalFmv({
        cardId: h.cardId,
        parallel: h.parallel ?? null,
        gradeCompany: null,
        gradeValue: null,
        cardYear: h.cardYear ?? null,
        product: h.product ?? null,
        player: h.playerName,
        cardNumber: h.cardNumber ?? null,
      }).catch(() => null);

      if (!canonical || canonical.fmv === null || canonical.fmv <= 0) {
        summary.pushesSkipped.rawFmvUnavailable++;
        continue;
      }
      const rawFmv = canonical.fmv;
      if (rawFmv < minRawFmv) {
        summary.pushesSkipped.rawFmvTooLow++;
        continue;
      }
      if (!canonical.gradeLadder || canonical.gradeLadder.tiers.length < 2) {
        summary.pushesSkipped.gradeLadderUnavailable++;
        continue;
      }

      // Find the best-uplift tier that isn't Raw. Prefers 10-tier
      // grades (PSA 10, BGS 10, SGC 10) — these are what drive most
      // grade-arb decisions.
      let bestTier: { grader: string; fmv: number } | null = null;
      for (const t of canonical.gradeLadder.tiers) {
        if (t.grader === "Raw" || !t.fmv || t.fmv <= 0) continue;
        if (!bestTier || t.fmv > bestTier.fmv) bestTier = t;
      }
      if (!bestTier) {
        summary.pushesSkipped.gradeLadderUnavailable++;
        continue;
      }
      const upliftX = bestTier.fmv / rawFmv;
      if (upliftX < minUpliftX) {
        summary.pushesSkipped.belowThreshold++;
        continue;
      }
      candidates.push({
        holding: h,
        rawFmv,
        topTier: bestTier.grader,
        topFmv: bestTier.fmv,
        upliftX: Math.round(upliftX * 100) / 100,
        upliftUSD: Math.round((bestTier.fmv - rawFmv) * 100) / 100,
      });
    }

    // Rank: biggest absolute uplift $ first
    candidates.sort((a, b) => b.upliftUSD - a.upliftUSD);
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
          cand.holding.gradeArbNotifyLastAt = new Date(nowMs).toISOString();
          cand.holding.gradeArbLastTopTier = cand.topTier;
          cand.holding.gradeArbLastUpliftX = cand.upliftX;
        }
      } catch { /* per-holding failure never halts the job */ }
    }

    if (!dryRun) {
      try { await writeUserDoc(userId, doc); } catch { /* silent */ }
    }
  }

  console.log(JSON.stringify({
    event: "grade_arbitrage_notify.job_complete",
    source: "gradeArbitrageNotifyJob.service",
    ...summary,
  }));

  return summary;
}

function pushTitle(cand: {
  holding: HoldingWithGradeArbState;
  topTier: string;
  upliftX: number;
}): string {
  const player = cand.holding.playerName ?? "Your card";
  return `Grade this ${player} — ${cand.topTier} pays ${cand.upliftX}×`;
}

function pushBody(cand: {
  rawFmv: number;
  topTier: string;
  topFmv: number;
  upliftUSD: number;
}): string {
  const currency = (n: number) => `$${Math.round(n).toLocaleString()}`;
  return `Raw ${currency(cand.rawFmv)} → ${cand.topTier} ${currency(cand.topFmv)}. +${currency(cand.upliftUSD)} uplift if graded.`;
}
