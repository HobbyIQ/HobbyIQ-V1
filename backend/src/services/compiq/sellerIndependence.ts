/**
 * CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04).
 *
 * Drew's standing ruling (2026-09-01) is that a published FMV needs three
 * INDEPENDENT sellers behind it on every path. The engine has never been
 * able to evaluate that sentence, and did not say so.
 *
 * What was actually there. `SELF_COMP_MIN_OTHER_SAMPLES = 3` in
 * unifiedPricing counts ROWS — `others.length >= 3` — where `others` is the
 * tier's rows minus the viewer's own contributions. Three rows is not three
 * sellers. One consignor listing the same card three times, or one eBay
 * seller's three sales of a parallel they hold in depth, satisfies it
 * exactly as well as three unrelated people do. The threshold was never
 * about seller identity; it only ever read a count.
 *
 * Why it could not have been. Measured read-only in prod 2026-09-04, over
 * the last 90 days of `soldAt` in sold_comps:
 *
 *     cardhedge            4,492,670 rows    0 with a seller handle
 *     tca-ebay             2,116,858 rows    0
 *     cardsight              261,713 rows    0
 *     ebay-user-purchase         140 rows   24
 *     ebay-account                22 rows    0
 *     ebay-user-sale              13 rows    0
 *     manual-user-entry            3 rows    0
 *
 * The container's field is `sellerHandle` (not `sellerId` / `sellerName`,
 * which do not exist on it). It is declared on the write input and
 * persisted by soldCompsStore, and then every ingest call site but one
 * passes the literal `null` — chRowToSoldComp:223, ebayOrderPoll:608,
 * persistVendorSalesToPool (cardsight / cardhedge / tca-ebay),
 * ebayImportRematch at four sites, compiq.routes:5571, cardsight.router,
 * ebayAutoHolding, autoTriageJob. 24 rows out of 6.87 million carry one.
 *
 * And the pool reader never asked for it regardless: readExactPoolRows
 * projects `price, soldAt, gradeCompany, gradeValue, priceAnomaly,
 * contributorUserId, source`. Even the 24 populated rows arrived at the
 * engine with no seller on them.
 *
 * So the defect is not that the number was wrong. It is that the engine
 * asserted a property it had no evidence for: nothing downstream could tell
 * "three different people bought this card" from "three rows survived a
 * filter", and the labels said nothing either way.
 *
 * The rule this module encodes. Independence is answered on seller identity
 * WHEN seller identity is visible, and when it is not, the answer names
 * itself `row-count` and the caller must not claim otherwise. There is no
 * third option where an unverifiable claim is published as a verified one.
 * `basis` is not decoration — `unifiedPricing` gates the self-comp reprieve
 * on `meets`, and `labelsForResult` refuses to say "independent" unless
 * `basis === "seller-identity"`.
 *
 * Deliberately NOT here: any inference of a seller from a listing url, an
 * item id, or a price+date coincidence. Two rows from one eBay item id are
 * one sale (dedupeSoldComps already removes those); they are not evidence
 * of one SELLER across different sales, and guessing would re-create the
 * exact overclaim this module exists to end.
 */

/** The minimum number of independent sellers a published value needs behind
 *  it (Drew, 2026-09-01). Also the row-count floor the legacy self-comp
 *  reprieve used, so the unverified path's behaviour is unchanged. */
export const MIN_INDEPENDENT_SELLERS = 3;

/**
 * What a seller-independence answer was actually computed from.
 *
 * `seller-identity` — every row carried a usable seller handle, so the
 *   count IS a count of distinct sellers and the threshold means what the
 *   ruling says it means.
 * `row-count` — at least one row had no seller handle, so distinctness
 *   could not be established. The count is a count of ROWS and any claim of
 *   independence made from it would be unverified.
 * `no-rows` — nothing to count.
 */
export type IndependenceBasis = "seller-identity" | "row-count" | "no-rows";

export interface IndependenceVerdict {
  /** How the verdict was reached. Never omit this when reporting a count. */
  basis: IndependenceBasis;
  /** Distinct sellers under `seller-identity`; row count otherwise. */
  count: number;
  /** `count >= MIN_INDEPENDENT_SELLERS`. True under `row-count` means the
   *  rows cleared the floor, NOT that three sellers were seen — read
   *  `basis` before saying "independent" anywhere a user can read it. */
  meets: boolean;
  /** Rows that carried no usable seller handle. Zero is what makes the
   *  basis `seller-identity`; anything else is why it is not. */
  rowsMissingSeller: number;
  /** Total rows considered. */
  rowsConsidered: number;
}

/** A row this test can read. Only the seller matters; every caller holds a
 *  different row type and all of them have (or lack) this one field. */
export interface SellerBearingRow {
  sellerHandle?: string | null;
}

/** The handle, normalized, or null when the row carries nothing usable.
 *  eBay handles are case-insensitive, so two spellings of one seller must
 *  not read as two sellers. */
export function normalizeSellerHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * How many INDEPENDENT sellers stand behind these rows, and on what basis.
 *
 * Pure. The caller decides what to do with a `row-count` verdict; this
 * function's only job is to refuse to conflate it with a verified one.
 */
export function assessSellerIndependence(
  rows: ReadonlyArray<SellerBearingRow>,
): IndependenceVerdict {
  const rowsConsidered = rows.length;
  if (rowsConsidered === 0) {
    return { basis: "no-rows", count: 0, meets: false, rowsMissingSeller: 0, rowsConsidered: 0 };
  }
  const sellers = new Set<string>();
  let rowsMissingSeller = 0;
  for (const r of rows) {
    const h = normalizeSellerHandle(r.sellerHandle);
    if (h === null) rowsMissingSeller++;
    else sellers.add(h);
  }
  // A single missing handle collapses the basis. Counting distinct sellers
  // over the rows that HAVE one and calling that the answer would report
  // "2 sellers" for a pool of forty anonymous rows plus two named ones —
  // an undercount presented with the authority of an identity check.
  if (rowsMissingSeller > 0) {
    return {
      basis: "row-count",
      count: rowsConsidered,
      meets: rowsConsidered >= MIN_INDEPENDENT_SELLERS,
      rowsMissingSeller,
      rowsConsidered,
    };
  }
  const count = sellers.size;
  return { basis: "seller-identity", count, meets: count >= MIN_INDEPENDENT_SELLERS, rowsMissingSeller: 0, rowsConsidered };
}

/**
 * CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
 *
 * #1775 made `independence-unverified` truthful. It did not make it
 * INFORMATIVE. Because `sellerHandle` is absent on all but 24 of 6.87M
 * sold_comps rows, `basis` is `row-count` on essentially every exact-pool
 * result in production, and the label fired on all of them — a sentence
 * that appears on every card tells a reader nothing about any card.
 *
 * Drew's ruling: show it ONLY where it changes the read. On a THIN pool one
 * seller could plausibly be behind every sale, so "we cannot see who sold
 * these" is a live risk the reader should weigh. On a healthy pool — many
 * sales, many dates, spread prices — the same sentence is noise: a single
 * consignor behind forty sales is not a scenario the number is exposed to,
 * and saying so on every healthy card trains the reader to ignore the
 * caveat on the thin ones where it matters.
 *
 * Thin is measured as POOL SIZE, not distinct sale dates. Both were on the
 * table; pool size is the one that can be measured honestly at the label
 * site. `labelsForResult` reads `provenance.comps`, which
 * canonicalFmv.service.ts truncates to the first 8-10 rows for display —
 * counting distinct dates over that sample is counting a rendering
 * artifact, and a healthy 40-sale pool whose 8-row sample happened to land
 * on two dates would be labeled thin. `provenance.compCount` is the pool
 * total and is never truncated (CF-COMP-COUNT-IS-THE-POOL, 2026-09-02), so
 * it is the number the gate reads.
 *
 * The FLOOR is measured, not chosen. Drew's 43 holdings, read-only
 * 2026-09-04 off the last sanctioned reprice: 40 sit on an exact-pool rung,
 * 27 of which #1775 labeled. Their pool sizes cluster at 2 and 3 (eight
 * holdings) and then jump straight to 5, 7, 8, 9, 10, 13, 14, 18, 39, 51,
 * 112, 119, 151, 647 — there is a real gap between "a pool one seller could
 * be behind" and the rest, and 5 sits in it. The choice is also not
 * balanced on a knife edge: a floor of 4 and a floor of 5 label the SAME
 * eight holdings, and only at 6 does the count move (to 12). 27 labels
 * become 8; the 19 silenced are pools of 5 to 647 sales.
 *
 * This gates the UNVERIFIABLE case only. Where sellers ARE visible and too
 * few, the count is a fact about this pool at any size and still publishes
 * ("only 2 independent sellers") — that branch is not a caveat about our
 * sources, it is an observation about the market.
 *
 * Nothing here touches a price or a confidence. `assessSellerIndependence`,
 * `meets`, `MIN_INDEPENDENT_SELLERS` and the self-comp reprieve in
 * unifiedPricing are untouched.
 *
 * And the basis stays READABLE whether or not the label renders. #1775
 * threads each row's `sellerHandle` from the pool reader through the
 * adapter onto `provenance.comps`, so any API caller can run this same
 * function over the wire's comps and recover the verdict for itself — the
 * evidence is published, only the SENTENCE is gated. (There is no named
 * `independenceBasis` field on `pricingSourceMeta` today; the handles are
 * where the basis lives, and that is what a caller reads.)
 */
export const INDEPENDENCE_THIN_POOL_MAX_SALES = 5;

/**
 * Is this pool thin enough that one seller could plausibly be behind all of
 * it? `poolTotal` must be the pool count (`provenance.compCount`), never
 * the length of a truncated display sample.
 */
export function isThinPoolForIndependence(poolTotal: number): boolean {
  if (!Number.isFinite(poolTotal)) return true;
  return poolTotal < INDEPENDENCE_THIN_POOL_MAX_SALES;
}

/** The label code a result carries when its evidence could not be checked
 *  for seller independence. Distinct from `low-confidence`: the number may
 *  be well-supported, we simply cannot see WHO sold. */
export const INDEPENDENCE_UNVERIFIED_CODE = "independence-unverified" as const;

/**
 * The seller handle carried by a HOLDING, when its eBay enrichment saw one.
 *
 * `ebayAutoHolding` stores the Browse API's seller object verbatim on the
 * holding (`ebaySeller = details.seller`), and `responseAssembly` types it
 * as `{ username, feedbackScore }`. Measured read-only in prod 2026-09-04:
 * all 111 eBay-sourced holdings carry it, across 96 distinct sellers — so
 * the identity the pool rows were missing was sitting on the holding those
 * rows were emitted from, one property away from the `sellerHandle: null`
 * the emitters passed.
 *
 * Only the username is taken. `feedbackScore` is a reputation signal, not
 * an identity, and nothing beyond the public storefront name the vendor
 * already exposes should reach the comp pool.
 */
export function sellerHandleFromHolding(holding: unknown): string | null {
  if (holding === null || typeof holding !== "object") return null;
  const s = (holding as { ebaySeller?: unknown }).ebaySeller;
  if (typeof s === "string") return normalizeSellerHandle(s);
  if (s !== null && typeof s === "object") {
    return normalizeSellerHandle((s as { username?: unknown }).username);
  }
  return null;
}
