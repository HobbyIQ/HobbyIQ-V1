// CF-IMPORT-BE (2026-06-21) — collision (dedup) detector.
//
// The #2 guard: detect when an incoming row collides with an existing
// holding on (cardId + parallel + grade + serial). This is the
// Hartman-4× scenario — same physical card across multiple holdings.
// The preview returns per-row actions {skip / add-copy / update-cost};
// the user picks per-row, with skip-default for safety.
//
// "Update-cost on holdingId match" refinement (4-prime, banked):
// when both cardId AND holdingId match an existing row, that signals
// "re-importing the same exported row" (a round-trip) — default flips
// to update-cost rather than skip. Skip-default stays only for the
// arbitrary-path case where cardId matches but holdingId is missing/new.

import type { PortfolioHolding } from "../../../types/portfolioiq.types.js";

export type CollisionAction = "skip" | "add-as-copy" | "update-cost";

export interface CollisionRow {
  cardId: string | null;
  holdingId: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  serialNumber: string | null;
}

export interface CollisionDetection {
  /** True when the row collides with at least one existing holding. */
  collides: boolean;
  /** Matching existing holdingIds (most relevant first by specificity). */
  existingHoldingIds: string[];
  /** "skip" | "add-as-copy" | "update-cost" — the default action; user can override. */
  defaultAction: CollisionAction;
  /** Reason the defaultAction was selected; surfaces in the preview. */
  reason: string;
}

/**
 * Find collisions for one incoming row against the user's existing holdings.
 * Returns no-collision when nothing matches the (cardId + parallel + grade + serial) key.
 */
export function detectCollision(
  row: CollisionRow,
  existingHoldings: Record<string, PortfolioHolding>,
): CollisionDetection {
  // No cardId on the incoming row → no collision detection possible
  // via the canonical key. Fall through to NEW lane (no collision).
  if (!row.cardId) {
    return {
      collides: false,
      existingHoldingIds: [],
      defaultAction: "skip",
      reason: "no cardId on incoming row; no collision check possible",
    };
  }

  const matches: string[] = [];
  for (const [hid, h] of Object.entries(existingHoldings)) {
    if (!h || h.cardId !== row.cardId) continue;
    // Match on the canonical key: cardId + parallel + grade + serial.
    const parallelMatch = norm(h.parallel) === norm(row.parallel);
    const gradeCompanyMatch = norm(h.gradeCompany) === norm(row.gradeCompany);
    const gradeValueMatch = (h.gradeValue ?? null) === (row.gradeValue ?? null);
    const serialMatch = norm(h.serialNumber) === norm(row.serialNumber);
    if (parallelMatch && gradeCompanyMatch && gradeValueMatch && serialMatch) {
      matches.push(hid);
    }
  }

  if (matches.length === 0) {
    return {
      collides: false,
      existingHoldingIds: [],
      defaultAction: "skip",
      reason: "no existing holding matches the (cardId + parallel + grade + serial) key",
    };
  }

  // 4-prime: when holdingId on the incoming row matches one of the
  // matches, that signals "re-importing the same exported row" → default
  // to update-cost rather than skip.
  if (row.holdingId && matches.includes(row.holdingId)) {
    return {
      collides: true,
      existingHoldingIds: matches,
      defaultAction: "update-cost",
      reason: "holdingId + cardId match an existing row — round-trip update default",
    };
  }

  return {
    collides: true,
    existingHoldingIds: matches,
    defaultAction: "skip",
    reason: `collision on cardId ${row.cardId.slice(0, 8)}… (parallel/grade/serial match); skip-default applied`,
  };
}

function norm(v: string | null | undefined): string {
  return (v ?? "").toString().trim().toLowerCase();
}
