// CF-SOCIAL-SURFACES (Drew, 2026-07-17): "I Called It" orchestration.
//
// Reads the user's portfolio doc + price alerts, runs the detect layer's
// pure predicates over every holding + alert, and returns a deduped list
// of shareable moments. The detect layer owns all math + copy; this
// layer owns fan-out + dedup + sort.
//
// Dedup rule: an alert_hit on holdingId H suppresses a
// purchase_appreciated on the same H — alert_hit is the more actionable
// event (the user explicitly asked to be notified at that price) and
// firing both would spam the surface with two cards for the same win.
//
// Sort rule: highest gainPct first (biggest brag ranks first).

import { readUserDoc } from "./portfolioStore.service.js";
import { listAlertsForUser } from "../../repositories/priceAlerts.repository.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import {
  detectPurchaseAppreciated,
  detectAlertHit,
  type FlexMoment,
} from "./iCalledItDetect.service.js";

export interface ICalledItResult {
  count: number;
  moments: FlexMoment[];
}

/**
 * Detect flex-worthy moments for a single user.
 *
 * Returns { count, moments[] } sorted by gainPct DESC. Reads Cosmos twice
 * (user doc + alerts container) — both single-partition reads.
 */
export async function detectICalledItMoments(
  userId: string,
  now: Date = new Date(),
): Promise<ICalledItResult> {
  const [doc, alerts] = await Promise.all([
    readUserDoc(userId),
    listAlertsForUser(userId).catch(() => []),
  ]);

  const holdings = Object.values(doc.holdings ?? {}) as PortfolioHolding[];
  const moments: FlexMoment[] = [];
  const alertHitHoldingIds = new Set<string>();

  // ── Alert-driven moments first — they take priority in the dedup ────
  // Alerts store cardId (the canonical catalog id). Match to a holding
  // by the holding's cardId; fall back to a playerName match when the
  // holding predates cardId assignment.
  for (const alert of alerts) {
    if (!alert.triggeredAt) continue;

    const matched = matchAlertToHolding(alert, holdings);
    if (!matched) continue;

    const moment = detectAlertHit(matched, alert, now);
    if (moment) {
      moments.push(moment);
      alertHitHoldingIds.add(String(matched.id ?? ""));
    }
  }

  // ── Purchase-appreciation moments across all holdings ────────────────
  for (const holding of holdings) {
    const id = String(holding.id ?? "");
    if (id && alertHitHoldingIds.has(id)) continue;

    const moment = detectPurchaseAppreciated(holding, now);
    if (moment) moments.push(moment);
  }

  moments.sort((a, b) => b.gainPct - a.gainPct);

  return { count: moments.length, moments };
}

/**
 * Best-effort match of a price alert to a user's holding.
 * Preferred: alert.cardId === holding.cardId.
 * Fallback: playerName exact match (case-insensitive) — surfaces on
 * pre-cardId legacy holdings.
 * Returns null when no candidate is found.
 */
function matchAlertToHolding(
  alert: { cardId?: string | null; playerName?: string | null },
  holdings: PortfolioHolding[],
): PortfolioHolding | null {
  const wantedCardId = String(alert.cardId ?? "").trim();
  if (wantedCardId) {
    const byCard = holdings.find(
      (h) =>
        String((h as { cardId?: string | null }).cardId ?? "").trim() ===
        wantedCardId,
    );
    if (byCard) return byCard;
  }
  const wantedPlayer = String(alert.playerName ?? "").trim().toLowerCase();
  if (wantedPlayer) {
    const byPlayer = holdings.find(
      (h) => String(h.playerName ?? "").trim().toLowerCase() === wantedPlayer,
    );
    if (byPlayer) return byPlayer;
  }
  return null;
}

/**
 * Test-facing pure entrypoint — accepts pre-fetched holdings + alerts so
 * the vitest suite can pin end-to-end dedup + sort behavior without a
 * Cosmos mock. The Cosmos-fanning path above just wraps this.
 */
export function detectMomentsFromInputs(
  holdings: PortfolioHolding[],
  alerts: Array<{
    cardId?: string | null;
    playerName?: string | null;
    targetPrice: number;
    direction: "above" | "below";
    triggeredAt: string | null;
  }>,
  now: Date = new Date(),
): ICalledItResult {
  const moments: FlexMoment[] = [];
  const alertHitHoldingIds = new Set<string>();

  for (const alert of alerts) {
    if (!alert.triggeredAt) continue;
    const matched = matchAlertToHolding(alert, holdings);
    if (!matched) continue;
    const priceAlertShape = {
      alertId: "",
      userId: "",
      cardId: String(alert.cardId ?? ""),
      playerName: String(alert.playerName ?? ""),
      targetPrice: alert.targetPrice,
      direction: alert.direction,
      currentPrice: null,
      createdAt: alert.triggeredAt,
      triggeredAt: alert.triggeredAt,
      isActive: false,
      cardSnapshot: null,
    };
    const moment = detectAlertHit(matched, priceAlertShape, now);
    if (moment) {
      moments.push(moment);
      alertHitHoldingIds.add(String(matched.id ?? ""));
    }
  }

  for (const holding of holdings) {
    const id = String(holding.id ?? "");
    if (id && alertHitHoldingIds.has(id)) continue;
    const moment = detectPurchaseAppreciated(holding, now);
    if (moment) moments.push(moment);
  }

  moments.sort((a, b) => b.gainPct - a.gainPct);
  return { count: moments.length, moments };
}
