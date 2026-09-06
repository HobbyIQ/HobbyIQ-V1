// CF-THE-YEAR-IS-THE-CARDS-YEAR-NOT-THE-SALES (Drew, 2026-09-06).
//
// A 1952 Topps Mickey Mantle #311 that sold for $54,000 was filed at
//
//     hiq:baseball:2015:topps:311:base:no-auto
//
// and a 1951 Bowman Mantle rookie at hiq:baseball:2015:bowman:253:base:no-auto.
// The year segment of both slugs is 2015 because that is the year the card
// SOLD. The title says 1952. It said 1952 the whole time.
//
// HOW A SALE YEAR BECAME A CARD YEAR
//
// The rows are auction-house archives arriving through the TCA firehose
// (collectrea, Goldin), where the vendor's `year` field is the year of the
// AUCTION, not the year of the card. The ingest wrote
//
//     identity.cardYear ?? guessCardYearFromTitle(title)
//
// and `??` means the vendor's field wins whenever it is present -- the same
// shape, on a third field, that CF-THE-TITLE-OUTRANKS-THE-VENDOR-PLAYER found
// on the player and CF-A-PRODUCT-QUALIFIER-IS-IDENTITY found on the product.
//
// The title could not contradict it even in principle. `guessCardYearFromTitle`
// matched `/\b(20\d{2})\b/` -- TWENTY-hundreds ONLY. Every vintage year in the
// hobby, 1909 through 1999, was invisible to it. MEASURED over the 930 verified
// entries of the #1890 census: the shipped guess returns null on 929 of them,
// and the slug year equals the sale year on 929 of them. It was never a
// contest between two readings; only one reading could speak.
//
// THE RULE
//
// The year segment comes from the year the CARD is stated to be, in this
// order:
//
//   1. the title, which is what the seller wrote about the card in front of
//      them, read positionally (see extractYearFromTitle: the FIRST year in
//      title order is the product year, so a 2023 Topps Heritage card
//      homaging a 1954 design stays a 2023 card);
//   2. the vendor's card-year field, when the title states no year at all;
//   3. nothing. When neither states a year the identity is UNDERIVABLE and
//      the row is not keyed.
//
// NEVER the sale date. A sale date is a fact about a transaction, not about a
// card, and no arithmetic turns one into the other.
//
// WHY A DISAGREEMENT IS NOT AUTOMATICALLY THE TITLE'S WIN
//
// It nearly is, and for the vintage class it always is. But the honest reading
// of "the two sources disagree" is the one playerTheTitleAllows already
// encodes: when both speak and they name different things, we do not know
// which is right from the row alone. The asymmetry that saves us here is that
// the two disagreements are not alike:
//
//   - vendor says 2015, title says 1952: the vendor is describing the auction.
//     A card year in the past relative to the vendor's is the vintage class,
//     and the title is right -- a seller does not write "1952" on a 2015 card
//     by accident, whereas an auction archive supplies its own year by design.
//   - vendor says 1952, title says 2015: the title leads with a modern year
//     and the vendor claims vintage. This is the retro/reprint shape and the
//     title still leads, because the FIRST year in a title is the product
//     year by the convention every seller follows.
//
// In both directions the title's positional reading is the better evidence, so
// the title wins a stated disagreement outright. What we refuse to do is
// invent a year when the title is silent AND the vendor's value is
// indistinguishable from the sale year -- that is the one case where adopting
// the vendor would recreate exactly the defect this module exists to remove.

export type YearDecision = {
  /** The card year to use, or null when the identity is UNDERIVABLE. */
  cardYear: number | null;
  outcome:
    | "agree"              // both speak and they match
    | "title-wins"         // both speak and they differ — the title's year stands
    | "title-only"         // the vendor said nothing
    | "vendor-only"        // the title said nothing and the vendor is usable
    | "vendor-is-sale-year" // the title said nothing and the vendor's value IS the sale year — refused
    | "neither";           // nobody stated a year
  /** True when a vendor-supplied year was discarded. */
  vendorOverruled: boolean;
  vendorYear: number | null;
  titleYear: number | null;
};

/** A year that could plausibly be printed on a trading card. The floor is the
 *  tobacco era; the ceiling allows next season's product to arrive early. */
function isPlausibleCardYear(y: unknown): y is number {
  return typeof y === "number" && Number.isFinite(y) && Number.isInteger(y) && y >= 1900 && y <= 2049;
}

/**
 * Decide the card's year from the title's reading and the vendor's field.
 *
 * Replaces `identity.cardYear ?? guessCardYearFromTitle(title)`. The `??` was
 * the bug: it never compared them, and the title parse it deferred to could
 * not see a vintage year at all.
 *
 * @param vendorYear the vendor's structured card-year field, if any
 * @param titleYear  the year the title states, from extractYearFromTitle
 * @param saleYear   the calendar year of the sale, used ONLY to recognise a
 *                   vendor value that is the auction year in disguise. It is
 *                   never adopted as a card year.
 */
export function yearTheTitleAllows(
  vendorYear: number | null | undefined,
  titleYear: number | null | undefined,
  saleYear: number | null | undefined,
): YearDecision {
  const v = isPlausibleCardYear(vendorYear) ? vendorYear : null;
  const t = isPlausibleCardYear(titleYear) ? titleYear : null;
  const s = isPlausibleCardYear(saleYear) ? saleYear : null;

  if (t === null && v === null) {
    return { cardYear: null, outcome: "neither", vendorOverruled: false, vendorYear: null, titleYear: null };
  }

  // The title states a year. It is the primary source and it wins, whether or
  // not the vendor agrees.
  if (t !== null) {
    if (v === null) {
      return { cardYear: t, outcome: "title-only", vendorOverruled: false, vendorYear: null, titleYear: t };
    }
    if (v === t) {
      return { cardYear: t, outcome: "agree", vendorOverruled: false, vendorYear: v, titleYear: t };
    }
    return { cardYear: t, outcome: "title-wins", vendorOverruled: true, vendorYear: v, titleYear: t };
  }

  // The title is silent. The vendor is all we have -- but if the vendor's
  // value is the sale year, we cannot tell a genuine current-year card from an
  // auction archive stamping its own year, and adopting it is precisely how a
  // 1952 Mantle became a 2015 card. Refuse. Absent beats wrong: an unkeyed row
  // can be re-derived tomorrow, a row in the wrong pool prices two cards badly.
  if (s !== null && v === s) {
    return { cardYear: null, outcome: "vendor-is-sale-year", vendorOverruled: true, vendorYear: v, titleYear: null };
  }
  return { cardYear: v, outcome: "vendor-only", vendorOverruled: false, vendorYear: v, titleYear: null };
}
