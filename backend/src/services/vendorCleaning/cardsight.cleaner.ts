// CF-CARDSIGHT-CLEANER (Drew, 2026-08-01). Cardsight-specific cleaning.
// Cardsight's `/v1/pricing` returns marketplace data where the fuzzy
// matcher sometimes associates the wrong physical card. This cleaner:
//   1. REJECTS rows whose title mentions neither the queried player
//      nor the queried cardNumber (fuzzy-match error signature).
//   2. Uses TITLE-derived identity (cardNumber, parallel, isAuto) as
//      authoritative — Cardsight's parallel_name is unreliable.
//   3. Flags all Cardsight rows as `unverified` since they aren't
//      user-attested and don't come from CH's authoritative catalog.

import type { CardsightSaleRecord } from "../compiq/cardsightSlim.client.js";
import { parseListingIdentity } from "../portfolioiq/parseTitleIdentity.service.js";
import type { CleaningContext, CleaningResult, VendorCleaner } from "./types.js";

export const cardsightCleaner: VendorCleaner<{
  raw: CardsightSaleRecord;
  cardId: string;
  playerName: string;
  setName?: string | null;
  releaseName?: string | null;
  year?: number | null;
  numberVal?: string | null;
  isAutoCatalogFallback?: boolean;
}> = {
  vendorName: "cardsight",

  async clean(input, _context): Promise<CleaningResult> {
    const { raw, cardId, playerName, setName, releaseName, year, numberVal } = input;
    const flags: CleaningResult["flags"] = [];

    // Basic invalid rejects
    if (typeof raw.price !== "number" || raw.price <= 0) {
      return { rejected: { category: "invalid", reason: "no valid price" }, flags: [] };
    }
    if (!raw.date) {
      return { rejected: { category: "invalid", reason: "no soldAt date" }, flags: [] };
    }

    // Fuzzy-match rejection: title must mention EITHER the queried
    // player's last name OR the queried cardNumber. If neither, this
    // is a mis-associated sale for a completely different card.
    const titleLower = String(raw.title ?? "").toLowerCase();
    const lastName = playerName.toLowerCase().split(/\s+/).slice(-1)[0] ?? "";
    const hasLastName = lastName.length >= 4;
    const numberLower = String(numberVal ?? "").toLowerCase();
    if (titleLower) {
      const mentionsPlayer = hasLastName && titleLower.includes(lastName);
      const mentionsNumber = numberLower && titleLower.includes(numberLower);
      if (!mentionsPlayer && !mentionsNumber) {
        return {
          rejected: {
            category: "fuzzy-match",
            reason: `title mentions neither player "${lastName}" nor cardNumber "${numberLower}"`,
          },
          flags: [],
        };
      }
      if (!mentionsPlayer) flags.push({ kind: "titleMismatch", detail: "title lacks player name" });
    }

    // Title-derived identity
    const parsedFromTitle = raw.title
      ? parseListingIdentity(String(raw.title))
      : { parallel: raw.parallel_name ?? "Base", cardNumber: null, isAuto: undefined };

    const cardNumberFromTitle = parsedFromTitle.cardNumber ?? numberVal ?? null;
    const parallelFromTitle = parsedFromTitle.parallel ?? "Base";
    const isAutoFromParsed =
      parsedFromTitle.isAuto !== undefined
        ? parsedFromTitle.isAuto
        : /(auto|autograph)/i.test(String(setName ?? "")) ||
          /^CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-/i.test(String(cardNumberFromTitle ?? ""));

    // Every Cardsight row is unverified by default (not user-attested,
    // not from CH's authoritative catalog).
    flags.push({ kind: "unverified", detail: "cardsight-source" });

    return {
      cleaned: {
        cardId,
        playerName,
        cardYear: year ?? null,
        setName: releaseName ?? setName ?? null,
        parallel: parallelFromTitle,
        cardNumber: cardNumberFromTitle,
        isAuto: isAutoFromParsed,
        price: raw.price,
        soldAt: raw.date,
        source: "cardsight",
        sourceExternalId: raw.url ?? null,
        contributorUserId: null,
        title: raw.title ?? null,
        imageUrl: raw.image_url ?? null,
        sellerHandle: null,
        verifiedByUser: false,
        confidence: 0.6,
      },
      flags,
    };
  },
};
