// CF-GRADE-ARBITRAGE (Drew, 2026-07-19). Nightly job that walks every
// user's RAW holdings and pushes an alert when a graded tier is worth
// more than a configurable multiple of the raw value.
//
// ── CF-GRADE-ARB-UNIFY (2026-09-02): the engine underneath ────────────
//
// The uplift now comes from the gated grade-arb computation
// (gradeArbCompute, via analyzeHoldingGradeArb), not from the canonical
// FMV response's `gradeLadder`. The alerts, thresholds, cooldowns, caps
// and persisted state are unchanged.
//
// The ladder could not stay the source for a push notification. Its
// tiers carry only {grader, medianRatio, fmv}: every non-Raw row is
// `rawAnchor x calibration multiplier` (canonicalFmv.service.ts,
// buildGradeLadder), and its `sampleSize` is a placeholder
// (`Math.max(n, 5)` — "approximate"). Nothing in it distinguishes a
// tier with forty real sales from one with none. Because the job took
// the MAXIMUM fmv across all tiers, it selected precisely the largest
// multiplier — on an observed $7.89 raw card the live ladder offers
// "PSA 8 = $302.47" at 38.34x, which cleared the 3x threshold and would
// have pushed "PSA 8 sells for $302, grade it" to a phone. A push is
// the most expensive surface we have: it costs the user a $25 cheque
// and a 90-day wait to discover the number was multiplication.
//
// Now a tier must be OBSERVED with >= MIN_GRADED_COMPS real sales of
// that card at that grade, and the alert names the count. Turns "you have $150 raw
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
import { sendPriceAlertNotification } from "../notification.service.js";
import { analyzeHoldingGradeArb } from "./gradeArbAnalyze.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

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

      // CF-GRADE-ARB-UNIFY (2026-09-02): the gated computation on the
      // ONE valuation path. Refuses any tier that is not observed with
      // real graded comps, so the maximum it reports is a maximum over
      // tiers that actually traded.
      const arb = await analyzeHoldingGradeArb(h as unknown as PortfolioHolding)
        .catch(() => null);

      if (!arb || arb.rawValue === null || arb.rawValue <= 0) {
        summary.pushesSkipped.rawFmvUnavailable++;
        continue;
      }
      const rawFmv = arb.rawValue;
      if (rawFmv < minRawFmv) {
        summary.pushesSkipped.rawFmvTooLow++;
        continue;
      }
      // No tier cleared the evidence floor — the same skip bucket the
      // ladder-unavailable case used, so the job's telemetry keeps its
      // shape.
      if (!arb.available || arb.tiers.length === 0) {
        summary.pushesSkipped.gradeLadderUnavailable++;
        continue;
      }

      // Highest graded value among tiers that survived the gate.
      let bestTier: { grader: string; fmv: number; sampleCount: number } | null = null;
      for (const t of arb.tiers) {
        if (!t.gradedValue || t.gradedValue <= 0) continue;
        if (!bestTier || t.gradedValue > bestTier.fmv) {
          bestTier = { grader: t.tier, fmv: t.gradedValue, sampleCount: t.sampleCount };
        }
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
