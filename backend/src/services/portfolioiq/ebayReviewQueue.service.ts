// CF-EBAY-REVIEW-QUEUE (2026-07-12).
//
// User-facing gate that turns auto-import from "silent commit + hope for
// the best" into "propose + confirm." Every eBay auto-created holding
// lands in cardStatus="pending-review" and waits until the user hits
// confirm — with any field corrections layered in. Corrections are logged
// so the parser + engine can improve.
//
// Flow:
//   1. importEbayPurchaseHistory → runAutoHoldingBatch → creates holdings
//      with cardStatus="pending-review", excluded from /holdings /pnl
//      /reprice.
//   2. User pulls GET /erp/holdings/pending-review, sees N cards with
//      parsed fields + Browse aspects + photos.
//   3. User taps Confirm (optionally editing any field) →
//      confirmHoldingReview promotes to cardStatus="active" and logs
//      the (autoParsed → userCorrected) deltas as a correction record.
//   4. User taps Reject → rejectHoldingReview deletes the holding and
//      unlinks from the source purchase, leaving the purchase available
//      for manual re-attribution.

import { randomUUID } from "crypto";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import {
  readUserDoc,
  writeUserDoc,
} from "./portfolioStore.service.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Fields the user can edit during confirm. Superset of the fields the
 *  parser/Browse enrich. Every field is optional; only present fields
 *  patch the holding. */
export interface ConfirmHoldingEdits {
  playerName?: string;
  cardYear?: number;
  setName?: string;
  parallel?: string;
  cardNumber?: string;
  gradeCompany?: "PSA" | "BGS" | "SGC" | "CGC" | string;
  gradeValue?: number;
  isAuto?: boolean;
  team?: string;
  sport?: string;
  cardId?: string;
  // Purchase-side corrections don't belong here — the user edits the
  // linked purchase separately. Cost basis stays untouched by confirm.
}

export type ConfirmHoldingResult =
  | { status: "confirmed"; holding: PortfolioHolding; correctionCount: number }
  | { status: "not-found" }
  | { status: "not-pending" }   // already active or in a different state
  | { status: "error"; reason: string };

export type RejectHoldingResult =
  | { status: "rejected"; unlinkedPurchaseId: string | null }
  | { status: "not-found" }
  | { status: "not-pending" }
  | { status: "error"; reason: string };

/** One user-corrected field. Fed to the corrections corpus so the parser
 *  can be improved (e.g. "Baseball Owen Carey" → "Owen Carey" seen N times
 *  → add "Baseball" to IGNORE_TOKENS). */
export interface FieldCorrection {
  field: string;
  before: unknown;
  after: unknown;
}

/** Correction record — one per confirm-with-edits. Stored on the doc
 *  under `doc.ebayCorrections[]` for now (single container, no new Cosmos
 *  container). Feeds a future ops route or offline parser retrain. */
export interface EbayCorrectionRecord {
  id: string;
  userId: string;
  holdingId: string;
  sourcePurchaseId?: string;
  ebayItemId?: string;
  ebayTitle?: string;
  autoParsed: {
    playerName?: string;
    cardYear?: number;
    setName?: string;
    parallel?: string;
    cardNumber?: string;
    gradeCompany?: string;
    gradeValue?: number;
    isAuto?: boolean;
    parseConfidence?: number;
  };
  browseAspects?: Record<string, string>;
  corrections: FieldCorrection[];
  confirmedAt: string;
}

// ─── Confirm ───────────────────────────────────────────────────────────────

/**
 * Promote a pending-review holding to active. Optional field edits are
 * applied first; deltas are logged as a correction record so the parser
 * + engine can improve from user ground truth.
 */
export async function confirmHoldingReview(
  userId: string,
  holdingId: string,
  edits: ConfirmHoldingEdits = {},
): Promise<ConfirmHoldingResult> {
  if (!userId || !holdingId) return { status: "error", reason: "missing userId or holdingId" };
  const doc = await readUserDoc(userId);
  const holding = doc.holdings?.[holdingId] as (PortfolioHolding & Record<string, unknown>) | undefined;
  if (!holding) return { status: "not-found" };
  if ((holding as any).cardStatus !== "pending-review") {
    return { status: "not-pending" };
  }

  // Snapshot the "before" state so corrections can be logged accurately.
  const autoParsed = {
    playerName: holding.playerName,
    cardYear: holding.cardYear,
    setName: holding.setName,
    parallel: holding.parallel,
    cardNumber: holding.cardNumber,
    gradeCompany: holding.gradeCompany,
    gradeValue: holding.gradeValue,
    isAuto: holding.isAuto,
    parseConfidence: (holding as any).parseConfidence,
  };

  const corrections: FieldCorrection[] = [];
  const applyEdit = <K extends keyof ConfirmHoldingEdits>(
    field: K,
    write: (h: PortfolioHolding & Record<string, unknown>, v: NonNullable<ConfirmHoldingEdits[K]>) => void,
  ) => {
    const v = edits[field];
    if (v === undefined) return;
    const before = (autoParsed as any)[field] ?? (holding as any)[field];
    if (before === v) return;
    write(holding, v as any);
    corrections.push({ field: String(field), before: before ?? null, after: v });
  };

  applyEdit("playerName", (h, v) => { h.playerName = v; });
  applyEdit("cardYear", (h, v) => { h.cardYear = v; });
  applyEdit("setName", (h, v) => {
    h.setName = v;
    h.product = v;
  });
  applyEdit("parallel", (h, v) => { h.parallel = v; });
  applyEdit("cardNumber", (h, v) => { h.cardNumber = v; });
  applyEdit("gradeCompany", (h, v) => {
    h.gradeCompany = v as any;
    (h as any).gradingCompany = v;
  });
  applyEdit("gradeValue", (h, v) => { h.gradeValue = v; });
  applyEdit("isAuto", (h, v) => { h.isAuto = v; });
  applyEdit("team", (h, v) => { (h as any).team = v; });
  applyEdit("sport", (h, v) => { (h as any).sport = v; });
  applyEdit("cardId", (h, v) => { (h as any).cardId = v; });

  // Promote to active + clear needsReview.
  (holding as any).cardStatus = "active";
  (holding as any).needsReview = false;
  (holding as any).confirmedAt = new Date().toISOString();
  holding.lastUpdated = new Date().toISOString();

  // Log corrections if any were made. Every confirm gets a record — even
  // if empty — so we track the review rate over time.
  const correctionsList: EbayCorrectionRecord[] = ((doc as any).ebayCorrections ?? []) as EbayCorrectionRecord[];
  correctionsList.push({
    id: randomUUID(),
    userId,
    holdingId,
    sourcePurchaseId: (holding as any).sourcePurchaseId ?? undefined,
    ebayItemId: extractEbayItemIdFromHolding(doc, holdingId),
    ebayTitle: extractEbayTitleFromHolding(doc, holdingId),
    autoParsed,
    browseAspects: (holding as any).ebayItemAspects ?? undefined,
    corrections,
    confirmedAt: (holding as any).confirmedAt,
  });
  (doc as any).ebayCorrections = correctionsList;

  await writeUserDoc(userId, doc);
  return { status: "confirmed", holding, correctionCount: corrections.length };
}

// ─── Reject ────────────────────────────────────────────────────────────────

/**
 * Delete a pending-review holding and unlink it from its source purchase.
 * The purchase itself is preserved (it's a real financial event); only
 * the auto-created holding is removed. User can manually attribute the
 * purchase later.
 */
export async function rejectHoldingReview(
  userId: string,
  holdingId: string,
): Promise<RejectHoldingResult> {
  if (!userId || !holdingId) return { status: "error", reason: "missing userId or holdingId" };
  const doc = await readUserDoc(userId);
  const holding = doc.holdings?.[holdingId] as (PortfolioHolding & Record<string, unknown>) | undefined;
  if (!holding) return { status: "not-found" };
  if ((holding as any).cardStatus !== "pending-review") {
    return { status: "not-pending" };
  }

  const sourcePurchaseId = ((holding as any).sourcePurchaseId as string | undefined) ?? null;

  delete doc.holdings[holdingId];

  if (sourcePurchaseId && Array.isArray((doc as any).purchases)) {
    for (const p of (doc as any).purchases as Array<{ id: string; holdingIds: string[] }>) {
      if (p.id === sourcePurchaseId) {
        p.holdingIds = p.holdingIds.filter((h) => h !== holdingId);
      }
    }
  }

  await writeUserDoc(userId, doc);
  return { status: "rejected", unlinkedPurchaseId: sourcePurchaseId };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractEbayItemIdFromHolding(doc: any, holdingId: string): string | undefined {
  const holding = doc.holdings?.[holdingId];
  const sourcePurchaseId = holding?.sourcePurchaseId;
  if (!sourcePurchaseId) return undefined;
  const purchase = (doc.purchases ?? []).find((p: any) => p.id === sourcePurchaseId);
  return purchase?.ebayItemId ?? undefined;
}

function extractEbayTitleFromHolding(doc: any, holdingId: string): string | undefined {
  const holding = doc.holdings?.[holdingId];
  const sourcePurchaseId = holding?.sourcePurchaseId;
  if (!sourcePurchaseId) return undefined;
  const purchase = (doc.purchases ?? []).find((p: any) => p.id === sourcePurchaseId);
  return purchase?.notes ?? undefined;
}
