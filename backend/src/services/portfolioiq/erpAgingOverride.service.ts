// CF-ERP-EXPANSION-#6 (2026-06-03): unreconciled-aging + manual fee-override
// audit. Pure functions over ledger entries.
//
// Override audit pattern: financial fields ARE mutated in place (so reports
// pick up the new values), but the prior state is preserved in an
// append-only `feeAdjustments[]` array on the entry — the audit trail is
// the array itself. Never overwrite a prior adjustment row.

import { randomUUID } from "crypto";
import {
  isReconciled,
  tryFinalizeReconciliation,
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";
import type { LedgerFeeAdjustment, ReconciledVia } from "./portfolioStore.service.js";

// ─── Aging ─────────────────────────────────────────────────────────────────

// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): added 31-60d + >60d
// buckets. >60d carries cutoffWarning=true — the eBay Finances API
// restricts lookups to the last 90 days, so an unreconciled eBay entry
// past day 60 is approaching the auto-enrichment cutoff. iOS surfaces
// this with a "ACT NOW: 90-day cutoff approaching" banner. Past day 90
// only manual override works; the Finances job filters those out.
export type AgingBucket = "0-7d" | "8-30d" | "31-60d" | ">60d";

export interface AgingBucketRow {
  bucket: AgingBucket;
  count: number;
  entryIds: string[];
  cutoffWarning?: true;
}

export interface AgingResponse {
  asOf: string;
  buckets: AgingBucketRow[];
  totalUnreconciled: number;
}

export function buildAging(
  ledger: ReadonlyArray<LedgerEntryForErp>,
  nowMs: number,
): AgingResponse {
  const unreconciled = ledger.filter((e) => !isReconciled(e));
  const b0_7: string[] = [];
  const b8_30: string[] = [];
  const b31_60: string[] = [];
  const b60: string[] = [];
  for (const e of unreconciled) {
    const t = Date.parse(e.soldAt);
    if (!Number.isFinite(t)) { b60.push(e.id); continue; }
    const days = Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
    if (days <= 7) b0_7.push(e.id);
    else if (days <= 30) b8_30.push(e.id);
    else if (days <= 60) b31_60.push(e.id);
    else b60.push(e.id);
  }
  return {
    asOf: new Date(nowMs).toISOString(),
    buckets: [
      { bucket: "0-7d", count: b0_7.length, entryIds: b0_7 },
      { bucket: "8-30d", count: b8_30.length, entryIds: b8_30 },
      { bucket: "31-60d", count: b31_60.length, entryIds: b31_60 },
      { bucket: ">60d", count: b60.length, entryIds: b60, cutoffWarning: true },
    ],
    totalUnreconciled: unreconciled.length,
  };
}

// ─── Override ─────────────────────────────────────────────────────────────

export interface FeeOverrideInput {
  finalValueFee?: number | null;
  paymentProcessingFee?: number | null;
  promotedListingFee?: number | null;
  adFee?: number | null;
  otherFees?: number | null;
  netPayout?: number | null;
  actualShippingCost?: number | null;
}

export interface ValidatedFeeOverride {
  fees: FeeOverrideInput;
  reason: string;
}

export function validateFeeOverride(body: unknown):
  | { ok: ValidatedFeeOverride }
  | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.reason !== "string" || !b.reason.trim()) {
    return { error: "reason is required" };
  }
  const reason = b.reason.trim();
  if (reason.length > 500) return { error: "reason must be ≤ 500 chars" };
  if (!b.fees || typeof b.fees !== "object") return { error: "fees object is required" };
  const fRaw = b.fees as Record<string, unknown>;
  const fields = [
    "finalValueFee",
    "paymentProcessingFee",
    "promotedListingFee",
    "adFee",
    "otherFees",
    "netPayout",
    "actualShippingCost",
  ] as const;
  const fees: FeeOverrideInput = {};
  let anyProvided = false;
  for (const k of fields) {
    if (!(k in fRaw)) continue;
    const raw = fRaw[k];
    if (raw === null) { fees[k] = null; anyProvided = true; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `fees.${k} must be a non-negative number or null` };
    }
    fees[k] = n;
    anyProvided = true;
  }
  if (!anyProvided) return { error: "fees object must include at least one fee field" };
  return { ok: { fees, reason } };
}

export interface AppliedOverride {
  entry: LedgerEntryForErp;
  adjustment: LedgerFeeAdjustment;
}

/**
 * Apply a fee override to an entry. Snapshots prior values into
 * feeAdjustments[] (append-only) and returns the mutated entry + the
 * adjustment record. CALLER is responsible for re-running
 * computeLedgerFinancials and persisting.
 */
export function applyFeeOverride(
  entry: LedgerEntryForErp,
  override: ValidatedFeeOverride,
  userId: string,
  nowIso: string = new Date().toISOString(),
): AppliedOverride {
  const prior: LedgerFeeAdjustment["priorValues"] = {
    finalValueFee: entry.finalValueFee ?? null,
    paymentProcessingFee: entry.paymentProcessingFee ?? null,
    promotedListingFee: entry.promotedListingFee ?? null,
    adFee: entry.adFee ?? null,
    otherFees: entry.otherFees ?? null,
    netPayout: entry.netPayout ?? null,
    actualShippingCost: entry.actualShippingCost ?? null,
    needsReconciliation: entry.needsReconciliation === true,
    reconciledVia: entry.reconciledVia,
  };

  // CF-PR-E-TWO-AXIS-RECONCILIATION: write fees + feeSource provenance, then
  // delegate finalize to tryFinalizeReconciliation. Override no longer
  // unconditionally clears needsReconciliation — axis 2 (user costs) must
  // also be addressed. Pre-Model-A this path hardcoded the flip; now an
  // override on an entry without userCostsProvidedAt leaves the flag true.
  const withFees: LedgerEntryForErp = {
    ...entry,
    finalValueFee: override.fees.finalValueFee !== undefined ? override.fees.finalValueFee : entry.finalValueFee ?? null,
    paymentProcessingFee: override.fees.paymentProcessingFee !== undefined ? override.fees.paymentProcessingFee : entry.paymentProcessingFee ?? null,
    promotedListingFee: override.fees.promotedListingFee !== undefined ? override.fees.promotedListingFee : entry.promotedListingFee ?? null,
    adFee: override.fees.adFee !== undefined ? override.fees.adFee : entry.adFee ?? null,
    otherFees: override.fees.otherFees !== undefined ? override.fees.otherFees : entry.otherFees ?? null,
    netPayout: override.fees.netPayout !== undefined ? override.fees.netPayout : entry.netPayout ?? null,
    actualShippingCost: override.fees.actualShippingCost !== undefined ? override.fees.actualShippingCost : entry.actualShippingCost ?? null,
    feeSource: "manual_override" as ReconciledVia,
  };
  const merged: LedgerEntryForErp = tryFinalizeReconciliation(withFees);

  const newValues: LedgerFeeAdjustment["newValues"] = {
    finalValueFee: merged.finalValueFee ?? null,
    paymentProcessingFee: merged.paymentProcessingFee ?? null,
    promotedListingFee: merged.promotedListingFee ?? null,
    adFee: merged.adFee ?? null,
    otherFees: merged.otherFees ?? null,
    netPayout: merged.netPayout ?? null,
    actualShippingCost: merged.actualShippingCost ?? null,
    needsReconciliation: merged.needsReconciliation === true,
    reconciledVia: merged.reconciledVia,
  };

  const adjustment: LedgerFeeAdjustment = {
    adjustmentId: randomUUID(),
    adjustedAt: nowIso,
    adjustedBy: userId,
    reason: override.reason,
    priorValues: prior,
    newValues,
  };

  merged.feeAdjustments = [...(entry.feeAdjustments ?? []), adjustment];

  return { entry: merged, adjustment };
}

// ─── CF-EBAY-FINANCES-ENRICHMENT (Group D) ─────────────────────────────────
//
// applyFeeEnrichment mirrors applyFeeOverride but takes a pre-mapped
// Finances result as the fee source instead of operator-supplied values,
// and sets reconciledVia="ebay_finances" with adjustedBy="system:
// ebay_finances".
//
// Net-basis: when netPayout is provided (Finances always provides it for
// settled orders), the authoritative formula fires in computeLedgerFinancials:
//   netProceeds = netPayout - gradingCost - suppliesCost
// gradingCost + suppliesCost are NOT in the Finances response (they're
// pre-sale + supply costs eBay never sees); they stay sourced from the
// holding's existing values.
//
// Idempotency: a re-run with the same Finances input appends a SECOND
// adjustment row (the audit array is append-only by design). The job
// layer is responsible for filtering already-reconciled entries OUT of
// the candidate set; this helper trusts its inputs.

export interface FeeEnrichmentInput {
  finalValueFee: number | null;
  paymentProcessingFee: number | null;
  promotedListingFee: number | null;
  adFee: number | null;
  otherFees: number | null;
  netPayout: number | null;
  actualShippingCost: number | null;
}

export interface AppliedEnrichment {
  entry: LedgerEntryForErp;
  adjustment: LedgerFeeAdjustment;
}

const ENRICHMENT_ADJUSTED_BY = "system:ebay_finances";
const ENRICHMENT_REASON = "Auto-enriched from eBay Finances API";

/**
 * Apply a Finances-derived fee enrichment to an entry. Snapshots prior
 * values into feeAdjustments[] (append-only) and returns the mutated
 * entry + the adjustment record. CALLER is responsible for re-running
 * computeLedgerFinancials and persisting (mirrors applyFeeOverride).
 */
export function applyFeeEnrichment(
  entry: LedgerEntryForErp,
  enrichment: FeeEnrichmentInput,
  nowIso: string = new Date().toISOString(),
): AppliedEnrichment {
  const prior: LedgerFeeAdjustment["priorValues"] = {
    finalValueFee: entry.finalValueFee ?? null,
    paymentProcessingFee: entry.paymentProcessingFee ?? null,
    promotedListingFee: entry.promotedListingFee ?? null,
    adFee: entry.adFee ?? null,
    otherFees: entry.otherFees ?? null,
    netPayout: entry.netPayout ?? null,
    actualShippingCost: entry.actualShippingCost ?? null,
    needsReconciliation: entry.needsReconciliation === true,
    reconciledVia: entry.reconciledVia,
  };

  // CF-PR-E-TWO-AXIS-RECONCILIATION: write fees + feeSource, then delegate
  // finalize to tryFinalizeReconciliation. Enrichment no longer
  // unconditionally clears needsReconciliation — axis 2 (user costs) must
  // also be addressed. An enrichment on an entry where the user hasn't yet
  // saved costs writes the fees but leaves the flag true; the next
  // save-costs call closes axis 2 and finalizes.
  const withFees: LedgerEntryForErp = {
    ...entry,
    finalValueFee: enrichment.finalValueFee,
    paymentProcessingFee: enrichment.paymentProcessingFee,
    promotedListingFee: enrichment.promotedListingFee,
    adFee: enrichment.adFee,
    otherFees: enrichment.otherFees,
    netPayout: enrichment.netPayout,
    actualShippingCost: enrichment.actualShippingCost,
    feeSource: "ebay_finances" as ReconciledVia,
  };
  const merged: LedgerEntryForErp = tryFinalizeReconciliation(withFees);

  const newValues: LedgerFeeAdjustment["newValues"] = {
    finalValueFee: merged.finalValueFee ?? null,
    paymentProcessingFee: merged.paymentProcessingFee ?? null,
    promotedListingFee: merged.promotedListingFee ?? null,
    adFee: merged.adFee ?? null,
    otherFees: merged.otherFees ?? null,
    netPayout: merged.netPayout ?? null,
    actualShippingCost: merged.actualShippingCost ?? null,
    needsReconciliation: merged.needsReconciliation === true,
    reconciledVia: merged.reconciledVia,
  };

  const adjustment: LedgerFeeAdjustment = {
    adjustmentId: randomUUID(),
    adjustedAt: nowIso,
    adjustedBy: ENRICHMENT_ADJUSTED_BY,
    reason: ENRICHMENT_REASON,
    priorValues: prior,
    newValues,
  };

  merged.feeAdjustments = [...(entry.feeAdjustments ?? []), adjustment];

  return { entry: merged, adjustment };
}

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): save-costs ──────────────
//
// User-supplied gradingCost / suppliesCost. Sets userCostsProvidedAt +
// userCostsProvidedBy (axis-2 marker). Costs themselves persist in the
// existing gradingCost / suppliesCost fields. Pure function — caller
// persists and is responsible for re-running computeLedgerFinancials.

export interface ValidatedSaveCosts {
  gradingCost?: number | null;
  suppliesCost?: number | null;
}

export function validateSaveCosts(body: unknown):
  | { ok: ValidatedSaveCosts }
  | { error: string; code: string } {
  if (!body || typeof body !== "object") {
    return { error: "body must be an object", code: "INVALID_VALUE" };
  }
  const b = body as Record<string, unknown>;
  const out: ValidatedSaveCosts = {};
  let anyProvided = false;
  for (const k of ["gradingCost", "suppliesCost"] as const) {
    if (!(k in b)) continue;
    anyProvided = true;
    const raw = b[k];
    if (raw === null) { out[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return {
        error: `${k} must be a non-negative number or null`,
        code: "INVALID_VALUE",
      };
    }
    out[k] = n;
  }
  if (!anyProvided) {
    return {
      error: "body must include gradingCost and/or suppliesCost",
      code: "MISSING_BODY",
    };
  }
  return { ok: out };
}

export interface AppliedSaveCosts {
  entry: LedgerEntryForErp;
  adjustment: LedgerFeeAdjustment;
}

const SAVE_COSTS_REASON = "User-provided cost basis";

/**
 * Apply user-provided cost basis to an UNRECONCILED eBay entry. Sets the
 * axis-2 marker (userCostsProvidedAt + userCostsProvidedBy), persists costs,
 * appends an audit row, and runs tryFinalizeReconciliation. If axis 1
 * (fees) is also satisfied the entry finalizes; otherwise it stays flagged
 * and costsStatus flips to "saved_pending_fees".
 *
 * Caller MUST re-run computeLedgerFinancials and persist. Idempotent
 * re-save while still flagged: each call refreshes the marker timestamp and
 * appends a fresh audit row. Once finalized the route returns 409 instead
 * of calling this helper again.
 *
 * Pure function. Throws nothing.
 */
export function applySaveCosts(
  entry: LedgerEntryForErp,
  costs: ValidatedSaveCosts,
  userId: string,
  nowIso: string = new Date().toISOString(),
): AppliedSaveCosts {
  const prior: LedgerFeeAdjustment["priorValues"] = {
    finalValueFee: entry.finalValueFee ?? null,
    paymentProcessingFee: entry.paymentProcessingFee ?? null,
    promotedListingFee: entry.promotedListingFee ?? null,
    adFee: entry.adFee ?? null,
    otherFees: entry.otherFees ?? null,
    netPayout: entry.netPayout ?? null,
    actualShippingCost: entry.actualShippingCost ?? null,
    needsReconciliation: entry.needsReconciliation === true,
    reconciledVia: entry.reconciledVia,
    gradingCost: entry.gradingCost ?? null,
    suppliesCost: entry.suppliesCost ?? null,
    userCostsProvidedAt: entry.userCostsProvidedAt ?? null,
  };

  // Partial-update semantics: only overwrite fields actually present in the
  // validated body (matches the override path).
  const withCosts: LedgerEntryForErp = {
    ...entry,
    gradingCost: "gradingCost" in costs ? costs.gradingCost ?? null : entry.gradingCost ?? null,
    suppliesCost: "suppliesCost" in costs ? costs.suppliesCost ?? null : entry.suppliesCost ?? null,
    userCostsProvidedAt: nowIso,
    userCostsProvidedBy: userId,
  };
  const merged: LedgerEntryForErp = tryFinalizeReconciliation(withCosts);

  const newValues: LedgerFeeAdjustment["newValues"] = {
    finalValueFee: merged.finalValueFee ?? null,
    paymentProcessingFee: merged.paymentProcessingFee ?? null,
    promotedListingFee: merged.promotedListingFee ?? null,
    adFee: merged.adFee ?? null,
    otherFees: merged.otherFees ?? null,
    netPayout: merged.netPayout ?? null,
    actualShippingCost: merged.actualShippingCost ?? null,
    needsReconciliation: merged.needsReconciliation === true,
    reconciledVia: merged.reconciledVia,
    gradingCost: merged.gradingCost ?? null,
    suppliesCost: merged.suppliesCost ?? null,
    userCostsProvidedAt: merged.userCostsProvidedAt ?? null,
  };

  const adjustment: LedgerFeeAdjustment = {
    adjustmentId: randomUUID(),
    adjustedAt: nowIso,
    adjustedBy: userId,
    reason: SAVE_COSTS_REASON,
    priorValues: prior,
    newValues,
  };

  merged.feeAdjustments = [...(entry.feeAdjustments ?? []), adjustment];

  return { entry: merged, adjustment };
}
