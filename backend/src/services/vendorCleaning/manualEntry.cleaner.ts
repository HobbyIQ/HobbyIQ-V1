// CF-MANUAL-ENTRY-CLEANER (Drew, 2026-08-01). Cleaning for manual
// user entries. Strict validation — parallel MUST be explicit (the
// 2026-08-01 Base default incident is why).

import type { CleaningResult, VendorCleaner } from "./types.js";

export interface ManualEntryRaw {
  cardId: string;
  playerName: string;
  cardYear?: number | null;
  setName?: string | null;
  parallel: string;   // REQUIRED — no silent Base default
  cardNumber?: string | null;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
  contributorUserId: string;
  title?: string | null;
  sourceExternalId?: string | null;
  confidence?: number;
  verifiedByUser?: boolean;
}

export const manualEntryCleaner: VendorCleaner<ManualEntryRaw> = {
  vendorName: "manual-user-entry",

  async clean(raw): Promise<CleaningResult> {
    if (typeof raw.price !== "number" || raw.price <= 0) {
      return { rejected: { category: "invalid", reason: "no valid price" }, flags: [] };
    }
    if (!raw.soldAt) {
      return { rejected: { category: "invalid", reason: "no soldAt date" }, flags: [] };
    }
    if (!raw.cardId || !raw.playerName || !raw.contributorUserId) {
      return { rejected: { category: "invalid", reason: "missing required fields" }, flags: [] };
    }
    // Hard rule: parallel is required. Silent Base default caused the
    // 2026-08-01 Hartman $1,526 mis-slug incident.
    if (!raw.parallel || !String(raw.parallel).trim()) {
      return { rejected: { category: "invalid", reason: "parallel required (pass 'Base' explicitly for unnumbered matte)" }, flags: [] };
    }
    // soldAt must be parseable
    const soldAtMs = Date.parse(raw.soldAt);
    if (!Number.isFinite(soldAtMs)) {
      return { rejected: { category: "invalid", reason: "soldAt must be parseable ISO date" }, flags: [] };
    }
    // Reject future sales (>1 day skew)
    if (soldAtMs > Date.now() + 86_400_000) {
      return { rejected: { category: "invalid", reason: "soldAt is in the future" }, flags: [] };
    }

    return {
      cleaned: {
        cardId: raw.cardId,
        playerName: raw.playerName,
        cardYear: raw.cardYear ?? null,
        setName: raw.setName ?? null,
        parallel: String(raw.parallel).trim(),
        cardNumber: raw.cardNumber ?? null,
        isAuto: raw.isAuto ?? false,
        gradeCompany: raw.gradeCompany ?? null,
        gradeValue: raw.gradeValue ?? null,
        price: raw.price,
        soldAt: raw.soldAt,
        source: "manual-user-entry",
        sourceExternalId: raw.sourceExternalId ?? null,
        contributorUserId: raw.contributorUserId,
        title: raw.title ?? null,
        imageUrl: null,
        sellerHandle: null,
        verifiedByUser: raw.verifiedByUser ?? true,
        confidence: raw.confidence ?? 0.9,
      },
      flags: [],
    };
  },
};
