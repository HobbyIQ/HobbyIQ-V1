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
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";
import type { LedgerFeeAdjustment, ReconciledVia } from "./portfolioStore.service.js";

// ─── Aging ─────────────────────────────────────────────────────────────────

export type AgingBucket = "0-7d" | "8-30d" | ">30d";

export interface AgingResponse {
  asOf: string;
  buckets: Array<{ bucket: AgingBucket; count: number; entryIds: string[] }>;
  totalUnreconciled: number;
}

export function buildAging(
  ledger: ReadonlyArray<LedgerEntryForErp>,
  nowMs: number,
): AgingResponse {
  const unreconciled = ledger.filter((e) => !isReconciled(e));
  const b0_7: string[] = [];
  const b8_30: string[] = [];
  const b30: string[] = [];
  for (const e of unreconciled) {
    const t = Date.parse(e.soldAt);
    if (!Number.isFinite(t)) { b30.push(e.id); continue; }
    const days = Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
    if (days <= 7) b0_7.push(e.id);
    else if (days <= 30) b8_30.push(e.id);
    else b30.push(e.id);
  }
  return {
    asOf: new Date(nowMs).toISOString(),
    buckets: [
      { bucket: "0-7d", count: b0_7.length, entryIds: b0_7 },
      { bucket: "8-30d", count: b8_30.length, entryIds: b8_30 },
      { bucket: ">30d", count: b30.length, entryIds: b30 },
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

  const merged: LedgerEntryForErp = {
    ...entry,
    finalValueFee: override.fees.finalValueFee !== undefined ? override.fees.finalValueFee : entry.finalValueFee ?? null,
    paymentProcessingFee: override.fees.paymentProcessingFee !== undefined ? override.fees.paymentProcessingFee : entry.paymentProcessingFee ?? null,
    promotedListingFee: override.fees.promotedListingFee !== undefined ? override.fees.promotedListingFee : entry.promotedListingFee ?? null,
    adFee: override.fees.adFee !== undefined ? override.fees.adFee : entry.adFee ?? null,
    otherFees: override.fees.otherFees !== undefined ? override.fees.otherFees : entry.otherFees ?? null,
    netPayout: override.fees.netPayout !== undefined ? override.fees.netPayout : entry.netPayout ?? null,
    actualShippingCost: override.fees.actualShippingCost !== undefined ? override.fees.actualShippingCost : entry.actualShippingCost ?? null,
    needsReconciliation: false,
    reconciledVia: "manual_override" as ReconciledVia,
  };

  const newValues: LedgerFeeAdjustment["newValues"] = {
    finalValueFee: merged.finalValueFee ?? null,
    paymentProcessingFee: merged.paymentProcessingFee ?? null,
    promotedListingFee: merged.promotedListingFee ?? null,
    adFee: merged.adFee ?? null,
    otherFees: merged.otherFees ?? null,
    netPayout: merged.netPayout ?? null,
    actualShippingCost: merged.actualShippingCost ?? null,
    needsReconciliation: false,
    reconciledVia: "manual_override",
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
