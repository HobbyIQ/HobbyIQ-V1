/**
 * CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03: "why are the direct ebay
 * comps that we import NOT showing up in grading curves and as a comp?").
 *
 * THE one definition of "this sale is the viewer's own", shared by every
 * surface that must LABEL such a row rather than hide it.
 *
 * The ruling (2026-09-02, self-comp-publish-labeled) is that an own purchase
 * IS a real sale: someone sold the card to the user at that price on that
 * date. It stays in the pool, appears in comps and curves, and may anchor a
 * value; when it is the sole or dominant anchor the value publishes WITH the
 * label "anchored by your own purchase". SELF_COMP_MIN_OTHER_SAMPLES governs
 * ANCHORING only — it must never hide the row from a curve or a comp list.
 *
 * Why this module exists. The predicate already lived in
 * ebaySellDraft.service as a private helper that tested two things:
 *
 *     c.verifiedByUser === true || c.source.startsWith("holding::")
 *
 * Neither is true of a D38 import. That writer sets
 * `source: "ebay-user-purchase"`, `contributorUserId: <userId>` and,
 * deliberately, `verifiedByUser: false` (the identity came from the matcher,
 * not from Drew confirming it by hand) — see ebayImportRematch.routes.ts:186
 * and :482. So Verlander bba3b7ad* (own PSA 10, $251, 2026-07-28) was a real
 * row in the pool that no surface would ever CALL the user's own. The label
 * never fired, and the row read as an anonymous market sale.
 *
 * Identity, not source class. `ebay-user-purchase` alone does not make a row
 * YOURS — another user's imported purchase is an ordinary independent comp
 * from your point of view, and is exactly the "other sample" the anchoring
 * threshold counts. So ownership is `contributorUserId === viewer` whenever a
 * viewer is known; the source-class and holding:: tests remain as the
 * viewer-less fallback the sell-draft path (which has no session on the row)
 * has always used.
 */

/** The sources whose rows are, by construction, contributed by a user. */
export const USER_CONTRIBUTED_SOURCES: readonly string[] = [
  "ebay-user-purchase",
  "ebay-user-sale",
  "ebay-account",
  "manual-user-entry",
  "user-verified",
];

/** Shape a row must satisfy to be tested. Every field optional: the callers
 *  hold four different row types (pool row, wire comp, provenance comp,
 *  curve sale) and all of them carry some subset of these. */
export interface SelfCompRowLike {
  source?: string | null;
  contributorUserId?: string | null;
  verifiedByUser?: boolean;
}

/**
 * Is this row the given viewer's OWN sale?
 *
 * Ownership is CONTRIBUTION: the row is theirs iff they contributed it. A
 * viewer id is therefore required, and a viewer-less call is FALSE rather
 * than a guess -- on an anonymous read there is no "your" for the label to
 * mean, and answering from the source class alone would stamp "your
 * purchase" on some other user's imported purchase. Source class says a row
 * is SOMEONE's own; only contributorUserId says it is YOURS.
 *
 * The one path that legitimately has no viewer id on the row is the sell
 * draft, whose provenance sample carries no contributor and whose rows all
 * belong to the single user the draft is for. It asks for the source-class
 * test explicitly via `isOwnCompForSingleUserContext`.
 */
export function isOwnComp(row: SelfCompRowLike, viewerUserId?: string | null): boolean {
  if (typeof viewerUserId !== "string" || viewerUserId.length === 0) return false;
  const contributor = typeof row.contributorUserId === "string" ? row.contributorUserId : null;
  return contributor === viewerUserId;
}

/**
 * The source-class test, for a context where every row already belongs to
 * one known user and the rows carry no contributor id -- today that is the
 * eBay sell draft, which builds its labels from a provenance sample.
 *
 * Named apart from `isOwnComp` so that using it is a deliberate statement
 * about the caller's context, never an accident on a shared surface.
 */
export function isOwnCompForSingleUserContext(row: SelfCompRowLike): boolean {
  if (row.verifiedByUser === true) return true;
  const src = typeof row.source === "string" ? row.source : "";
  if (src.startsWith("holding::")) return true;
  return USER_CONTRIBUTED_SOURCES.includes(src);
}


/** The label a comp-list row carries when it is the viewer's own sale. */
export const OWN_COMP_ROW_LABEL = "your purchase";

/** The label a published value carries when own purchases are its sole or
 *  dominant anchor. Wording is the ruling's. */
export const OWN_COMP_ANCHOR_LABEL = "anchored by your own purchase";
