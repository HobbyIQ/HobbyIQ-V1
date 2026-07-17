// CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Orchestration layer for the
// grade-worthy push. Iterates every opted-in user, scans their
// holdings, runs the grade-worthy analyzer per holding, and dispatches
// one push per fired holding.
//
// This module owns policy (per-holding gate, best-effort semantics) but
// not the compute (pure math in gradeWorthyPushCompute.service.ts) or
// the APNs wire (in notification.service.ts).

import { listUsersWithGradeWorthyOptIn } from "./portfolioStore.service.js";
import { analyzeHoldingGradeWorthy } from "./gradeWorthyAnalyze.service.js";
import { sendGradeWorthyNotification } from "../notification.service.js";
import { shouldFireGradeWorthyPush } from "./gradeWorthyPushCompute.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

export interface GradeWorthyNotifyResult {
  usersScanned: number;
  holdingsScanned: number;
  holdingsFired: number;
  sent: number;
  failed: number;
}

/**
 * Fan-out worker: scan every opted-in user's holdings, per-holding
 * grade-worthy analysis, and dispatch a push per firing holding.
 * Individual failures are swallowed after logging so a single
 * holding's analysis error can't cost later users their alerts.
 */
export async function sendGradeWorthyPushesForOptedInUsers(): Promise<GradeWorthyNotifyResult> {
  let usersScanned = 0;
  let holdingsScanned = 0;
  let holdingsFired = 0;
  let sent = 0;
  let failed = 0;

  let users: Array<{
    userId: string;
    apnsDeviceToken: string | null;
    holdings: Record<string, PortfolioHolding>;
  }> = [];
  try {
    users = await listUsersWithGradeWorthyOptIn();
  } catch (err: any) {
    console.error(
      `[gradeWorthyPushNotify] listUsersWithGradeWorthyOptIn failed: ${err?.message ?? err}`,
    );
    return { usersScanned: 0, holdingsScanned: 0, holdingsFired: 0, sent: 0, failed: 0 };
  }

  for (const user of users) {
    usersScanned += 1;
    const holdings = Object.values(user.holdings ?? {});
    for (const holding of holdings) {
      holdingsScanned += 1;
      let verdict;
      try {
        const { analysis } = await analyzeHoldingGradeWorthy(holding);
        verdict = shouldFireGradeWorthyPush(analysis);
      } catch (err: any) {
        failed += 1;
        console.error(
          `[gradeWorthyPushNotify] analyze failed user=${user.userId} holding=${holding.id}: ${err?.message ?? err}`,
        );
        continue;
      }
      if (!verdict.fire || !verdict.tier) continue;
      holdingsFired += 1;

      try {
        const r = await sendGradeWorthyNotification(user.userId, {
          holdingId: holding.id,
          player: (holding.playerName ?? "").trim() || "unknown player",
          cardTitle: buildCardTitle(holding),
          expectedGain: verdict.tier.expectedGain,
          graderTier: verdict.tier.graderTier,
        });
        sent += r.sent;
        failed += r.failed;
      } catch (err: any) {
        failed += 1;
        console.error(
          `[gradeWorthyPushNotify] send failed user=${user.userId} holding=${holding.id}: ${err?.message ?? err}`,
        );
      }
    }
  }

  return { usersScanned, holdingsScanned, holdingsFired, sent, failed };
}

/**
 * Compose a display-friendly card title for the push body. Prefers the
 * stored `cardTitle`; falls back to a "YYYY Set #NUM" synth so the
 * body isn't blank when iOS didn't populate cardTitle at import time.
 * Exported for direct test coverage.
 */
export function buildCardTitle(holding: PortfolioHolding): string {
  const explicit = String(holding.cardTitle ?? "").trim();
  if (explicit) return explicit;
  const parts: string[] = [];
  if (typeof holding.cardYear === "number" && Number.isFinite(holding.cardYear)) {
    parts.push(String(holding.cardYear));
  }
  const setName = String(holding.setName ?? "").trim();
  if (setName) parts.push(setName);
  const number = String(holding.cardNumber ?? "").trim();
  if (number) parts.push(`#${number}`);
  if (parts.length === 0) return "card";
  return parts.join(" ");
}
