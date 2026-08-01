// CF-EBAY-USER-PURCHASE-CLEANER (Drew, 2026-08-01). Cleaning for
// rows that come from a user's own eBay purchase history import.
// Highest trust — the user confirmed the purchase via OAuth-linked
// eBay account.

import { parseListingIdentity } from "../portfolioiq/parseTitleIdentity.service.js";
import type { CleaningResult, VendorCleaner } from "./types.js";

export interface EbayUserPurchaseRaw {
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
  ebayItemId: string;
  contributorUserId: string;
  title?: string | null;
  imageUrl?: string | null;
  sellerHandle?: string | null;
}

export const ebayUserPurchaseCleaner: VendorCleaner<EbayUserPurchaseRaw> = {
  vendorName: "ebay-user-purchase",

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

    // Title-parsed identity if available; fall back to caller values
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
        source: "ebay-user-purchase",
        sourceExternalId: raw.ebayItemId,
        contributorUserId: raw.contributorUserId,
        title: raw.title ?? null,
        imageUrl: raw.imageUrl ?? null,
        sellerHandle: raw.sellerHandle ?? null,
        verifiedByUser: true,
        confidence: 0.95,
      },
      flags: [],
    };
  },
};
