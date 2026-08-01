// CF-CARDHEDGE-CLEANER (Drew, 2026-08-01). CardHedge-specific cleaning.
// CH is our most-trusted source (authoritative catalog + tracked sales)
// but their catalog occasionally has:
//   - Empty year on some cards (catalog rows without year metadata)
//   - Card_set text where the SET NAME differs from the actual product
//   - Mis-tagged parallels on autograph subsets (e.g. "Base" tagged on
//     a CPA-XXX autograph)
//
// This cleaner:
//   1. REJECTS rows with no price/date (invalid).
//   2. Uses TITLE-parsed identity (same rule as Cardsight: title is the
//      most reliable signal) when title present.
//   3. Trusts CH's playerName + cardId — those are catalog-authoritative.
//   4. High default confidence (0.85) — CH is trusted.

import { parseListingIdentity } from "../portfolioiq/parseTitleIdentity.service.js";
import type { CleaningResult, VendorCleaner } from "./types.js";

export interface CardHedgeRawRow {
  cardId: string;
  playerName: string;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
  sourceExternalId?: string | null;
  title?: string | null;
  imageUrl?: string | null;
  sellerHandle?: string | null;
}

export const cardhedgeCleaner: VendorCleaner<CardHedgeRawRow> = {
  vendorName: "cardhedge",

  async clean(raw): Promise<CleaningResult> {
    const flags: CleaningResult["flags"] = [];

    if (typeof raw.price !== "number" || raw.price <= 0) {
      return { rejected: { category: "invalid", reason: "no valid price" }, flags: [] };
    }
    if (!raw.soldAt) {
      return { rejected: { category: "invalid", reason: "no soldAt date" }, flags: [] };
    }
    if (!raw.cardId || !raw.playerName) {
      return { rejected: { category: "invalid", reason: "missing cardId or playerName" }, flags: [] };
    }

    // Title-parsed identity (title-first for the same reasons as Cardsight)
    const parsedFromTitle = raw.title ? parseListingIdentity(String(raw.title)) : null;
    const cardNumber = parsedFromTitle?.cardNumber ?? raw.cardNumber ?? null;
    const parallel = parsedFromTitle?.parallel ?? raw.parallel ?? "Base";
    const isAuto =
      parsedFromTitle?.isAuto !== undefined
        ? parsedFromTitle.isAuto
        : raw.isAuto ?? /^CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-/i.test(String(cardNumber ?? ""));

    return {
      cleaned: {
        cardId: raw.cardId,
        playerName: raw.playerName,
        cardYear: raw.cardYear ?? null,
        setName: raw.setName ?? null,
        parallel,
        cardNumber,
        isAuto,
        gradeCompany: raw.gradeCompany ?? null,
        gradeValue: raw.gradeValue ?? null,
        price: raw.price,
        soldAt: raw.soldAt,
        source: "cardhedge",
        sourceExternalId: raw.sourceExternalId ?? null,
        contributorUserId: null,
        title: raw.title ?? null,
        imageUrl: raw.imageUrl ?? null,
        sellerHandle: raw.sellerHandle ?? null,
        verifiedByUser: false,
        confidence: 0.85,
      },
      flags,
    };
  },
};
