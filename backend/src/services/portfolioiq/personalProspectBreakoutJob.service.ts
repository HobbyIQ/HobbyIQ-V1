// CF-PERSONAL-PROSPECT-BREAKOUT (Drew, 2026-07-20). Nightly job that
// pushes an APNS notification to any user whose HOLDING appears in the
// sub-raw inversion list. Turns the prospects feed from a public
// browse surface into a personal alert: "Your Jared Jones raw is
// breaking out — raw sales just topped Blue X-Fractor medians."
//
// Rate limits:
//   - Per-holding: max 1 breakout push per 7 days
//   - Per-user: max 2 breakout pushes per day
//
// Uses computeSubRawInversions() from the sub-raw scan service so this
// job + the prospects endpoint + the nightly telemetry scan all share
// one detection implementation.

import { listAllPortfolioUserIds, readUserDoc, writeUserDoc } from "./portfolioStore.service.js";
import { computeSubRawInversions, type SubRawInversion } from "../signals/subRawInversionScan.service.js";
import { sendPriceAlertNotification } from "../notification.service.js";

interface HoldingWithProspectState {
  id: string;
  cardId?: string;
  playerName?: string;
  parallel?: string;
  cardYear?: number | null;
  product?: string | null;
  sport?: string | null;
  // Personal-breakout notify state
  personalProspectNotifyLastAt?: string | null;
  personalProspectNotifyDismissedAt?: string | null;
}

export interface PersonalProspectBreakoutOptions {
  sport?: string;                     // default baseball
  windowDays?: number;                // default 30
  minMarginPct?: number;              // default 5
  perUserDailyCap?: number;           // default 2
  perHoldingCooldownDays?: number;    // default 7
  dryRun?: boolean;
}

export interface PersonalProspectBreakoutSummary {
  usersScanned: number;
  holdingsScanned: number;
  inversionsInSport: number;
  matches: number;
  pushesSent: number;
  pushesSkipped: {
    holdingCooldownActive: number;
    userDailyCapHit: number;
  };
  sport: string;
  dryRun: boolean;
}

const DAY_MS = 86_400_000;

export async function runPersonalProspectBreakoutJob(
  opts: PersonalProspectBreakoutOptions = {},
): Promise<PersonalProspectBreakoutSummary> {
  const sport = opts.sport ?? "baseball";
  const windowDays = opts.windowDays ?? 30;
  const minMarginPct = opts.minMarginPct ?? 5;
  const perUserDailyCap = opts.perUserDailyCap ?? 2;
  const holdingCooldownMs = (opts.perHoldingCooldownDays ?? 7) * DAY_MS;
  const dryRun = opts.dryRun === true;
  const nowMs = Date.now();

  const summary: PersonalProspectBreakoutSummary = {
    usersScanned: 0,
    holdingsScanned: 0,
    inversionsInSport: 0,
    matches: 0,
    pushesSent: 0,
    pushesSkipped: { holdingCooldownActive: 0, userDailyCapHit: 0 },
    sport,
    dryRun,
  };

  // Get the inversion list ONCE for this sport (pool-wide scan).
  const inversions = await computeSubRawInversions({ sport, windowDays, minMarginPct });
  summary.inversionsInSport = inversions.length;
  if (inversions.length === 0) {
    console.log(JSON.stringify({ event: "personal_prospect_breakout.no_inversions", sport }));
    return summary;
  }

  // Index by cardId for O(1) lookup as we walk users.
  const byCardId = new Map<string, SubRawInversion[]>();
  for (const inv of inversions) {
    const arr = byCardId.get(inv.cardId) ?? [];
    arr.push(inv);
    byCardId.set(inv.cardId, arr);
  }

  const userIds = await listAllPortfolioUserIds();
  for (const userId of userIds) {
    summary.usersScanned++;
    let doc;
    try { doc = await readUserDoc(userId); } catch { continue; }
    const holdings = Object.values(doc.holdings ?? {}) as HoldingWithProspectState[];
    if (holdings.length === 0) continue;

    // Per-user daily cap: count pushes in last 24h.
    let userPushesToday = 0;
    for (const h of holdings) {
      const lastAt = h.personalProspectNotifyLastAt ? Date.parse(h.personalProspectNotifyLastAt) : NaN;
      if (Number.isFinite(lastAt) && (nowMs - lastAt) < DAY_MS) userPushesToday++;
    }

    for (const h of holdings) {
      summary.holdingsScanned++;
      if (!h.cardId) continue;
      const matchesForCard = byCardId.get(h.cardId);
      if (!matchesForCard || matchesForCard.length === 0) continue;
      // Filter to inversions on the same parallel (or base when null)
      const relevant = matchesForCard.filter((inv) => {
        const invPar = (inv.parallel ?? "").toLowerCase().trim();
        const holdingPar = (h.parallel ?? "").toLowerCase().trim();
        return invPar === holdingPar;
      });
      if (relevant.length === 0) continue;
      summary.matches++;

      const lastAt = h.personalProspectNotifyLastAt ? Date.parse(h.personalProspectNotifyLastAt) : NaN;
      if (Number.isFinite(lastAt) && (nowMs - lastAt) < holdingCooldownMs) {
        summary.pushesSkipped.holdingCooldownActive++;
        continue;
      }
      if (userPushesToday >= perUserDailyCap) {
        summary.pushesSkipped.userDailyCapHit++;
        continue;
      }

      // Pick the strongest inversion (biggest margin %) for the push copy
      const strongest = relevant.slice().sort((a, b) => b.marginPct - a.marginPct)[0];
      const title = `${h.playerName ?? "Your card"} raw is breaking out`;
      const body = `Raw sales ($${Math.round(strongest.rawMax)}) topped ${strongest.grader} med ($${Math.round(strongest.gradedMedian)}) +${Math.round(strongest.marginPct)}%. Sell now?`;

      if (dryRun) {
        summary.pushesSent++;
        userPushesToday++;
        continue;
      }
      try {
        const result = await sendPriceAlertNotification(userId, {
          title, body, cardId: h.cardId,
        });
        if (result.sent > 0) {
          summary.pushesSent++;
          userPushesToday++;
          h.personalProspectNotifyLastAt = new Date(nowMs).toISOString();
        }
      } catch { /* per-holding errors don't halt the job */ }
    }

    if (!dryRun) {
      try { await writeUserDoc(userId, doc); } catch { /* silent */ }
    }
  }

  console.log(JSON.stringify({
    event: "personal_prospect_breakout.job_complete",
    source: "personalProspectBreakoutJob.service",
    ...summary,
  }));
  return summary;
}
