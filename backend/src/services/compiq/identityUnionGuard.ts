/**
 * CF-A-UNION-IS-ONE-CARD, made general (audit 2026-09-03, H-4).
 *
 * A pool built from two identities is a claim that both identities name the
 * SAME CARD. When they do not, the pool is a fiction: whichever half the
 * window happens to reach decides the price, so the projection alternates run
 * to run and matches NEITHER half. That is not a rounding error — live
 * holding c37ead87 carried
 *
 *     cardId          hiq:baseball:2025:bowman-chrome:cpa-kw:refractor:auto
 *     hobbyiqCardId   hiq:baseball:2025:bowman-draft:cpa-kw:base:auto
 *
 * — a Bowman Chrome refractor auto and a Bowman Draft base auto, which the
 * setKey taxonomy ruling says are DIFFERENT CARDS — and priced the holding
 * off whichever side the read reached.
 *
 * WHY THIS MODULE EXISTS RATHER THAN THE ONE CALL IT REPLACES
 * -----------------------------------------------------------
 * The rule was already written (exactPoolSupremacy.mayUnionIdentities) and
 * already correct. It was enforced at ONE of the sites that read across two
 * identities. The other sites — observedGradeCurve.resolveUnionSlug most
 * visibly, which returned the caller's slug with no comparison at all — took
 * the union unguarded, so the same holding was refused on the portfolio path
 * and unioned on the curve path. A rule enforced at one of four doors is not
 * a rule; it is a coincidence at one door.
 *
 * So the decision lives here, once, and every site calls it and RECORDS what
 * it decided. exactPoolSupremacy re-exports `mayUnionIdentities` from this
 * module so its existing callers and pins are unchanged.
 *
 * WHAT COUNTS AS THE SAME CARD
 * ----------------------------
 * The product — `sport:year:setKey`, the first three segments after `hiq:`.
 * The print-run suffix, the parallel and the grade are all WITHIN one product,
 * so a `…:num-499` / bare-stem twin still unions (that is the twin's purpose).
 * A vendor id names no product and is never compared: the cross-vendor union
 * is exactly what the union exists for, and refusing it would narrow every
 * holding whose rows never got a slug.
 *
 * FAIL-OPEN IS DELIBERATE, AND IT IS NARROW. Only an id that parses as an hiq
 * slug carries a product; anything else returns null and unions freely. The
 * guard refuses only when it can NAME both products and they differ.
 */

/** An hiq slug, loosely — the shape check the product parse needs. */
function isHiqSlug(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().startsWith("hiq:");
}

/**
 * The product a slug names: `sport:year:setKey`. Null for anything that is not
 * an hiq slug (a vendor id names no product and is never compared).
 */
export function productIdentityOf(slug: string | null | undefined): string | null {
  if (!isHiqSlug(slug)) return null;
  const seg = slug.trim().split(":");
  // hiq : sport : year : setKey — anything shorter names no product.
  return seg.length >= 4 ? `${seg[1]}:${seg[2]}:${seg[3]}` : null;
}

/**
 * May these two identities be read as ONE pool? Yes when they name the same
 * product, and yes when either names no product at all. Pure.
 */
export function mayUnionIdentities(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = productIdentityOf(a);
  const pb = productIdentityOf(b);
  if (pa === null || pb === null) return true;
  return pa === pb;
}

/** What the guard decided, in a form a caller can put in provenance. */
export interface UnionDecision {
  /** True when the two ids may share a pool. */
  allowed: boolean;
  /** The union partner to actually use: `b` when allowed, else null. */
  partner: string | null;
  /** Set only on a refusal. The sentence that goes on the wire. */
  refusedReason: string | null;
  aProduct: string | null;
  bProduct: string | null;
}

/**
 * The ONE decision, for every site that reads across two identities.
 *
 * `site` names the caller in the refusal log so a refused union is traceable
 * to the door it was refused at, rather than appearing as an unexplained
 * narrowing somewhere in the engine.
 */
export function decideIdentityUnion(
  a: string | null | undefined,
  b: string | null | undefined,
  site: string,
  /** The telemetry shape this site already emits. `exactPoolSupremacy` has an
   *  established event name and field names that ops KQL is written against —
   *  centralizing the DECISION must not silently rename its event. Sites with
   *  no prior contract get the generic shape. */
  wire?: { event?: string; aField?: string; bField?: string; aProductField?: string; bProductField?: string; detail?: string },
): UnionDecision {
  const aProduct = productIdentityOf(a);
  const bProduct = productIdentityOf(b);
  const allowed = mayUnionIdentities(a, b);
  if (allowed) {
    return { allowed: true, partner: typeof b === "string" && b.trim() ? b.trim() : null, refusedReason: null, aProduct, bProduct };
  }
  const aName = wire?.aField ?? "a";
  const bName = wire?.bField ?? "b";
  const refusedReason = wire
    ? `union-refused: ${aName} ${aProduct} != ${bName} ${bProduct} — different products, priced single-sided`
    : `union-refused: ${aProduct} != ${bProduct} — different products, priced single-sided`;
  console.warn(JSON.stringify({
    event: wire?.event ?? "identity_union_refused_cross_product",
    source: site,
    [aName]: a,
    [bName]: b,
    [wire?.aProductField ?? "aProduct"]: aProduct,
    [wire?.bProductField ?? "bProduct"]: bProduct,
    detail: wire?.detail
      ?? "the halves of this union name different products; the read is single-sided",
  }));
  return { allowed: false, partner: null, refusedReason, aProduct, bProduct };
}

/**
 * R71 (owner ruling, 2026-09-19). #2330 (R70) made every reader drop every
 * `identityUnverified: true` row, full stop. That over-corrected: the 2026-
 * 09-07 `relocate-pool-rows-by-list` sport-segment tranche (~87K rows, e.g.
 * every Wembanyama `…:topps:vw3:…` sale) PARKS a row whose `hobbyiqCardId` —
 * the field the pricing engine keys pools on — is the title-plausible side,
 * while only `cardId` (the vendor-derived partition key) names the wrong
 * sport. Before #2330 these rows priced correctly in the `hobbyiqCardId`
 * pool (and ALSO leaked into the wrong-sport `cardId` pool through
 * `exactPoolReader`'s OR-union — the R70 defect this repair does not
 * reopen). #2330 threw both the leak and the correct pricing out together.
 *
 * REVIEW FINDING (2026-09-19, BLOCKING, fixed here): an earlier version of
 * this module shipped TWO fragments — a narrow, correct
 * `..._STRUCTURAL_CARVEOUT_SQL` that was never wired into any reader, and a
 * broad `STARTSWITH(c.identityUnverifiedReason, 'PARK. cardId vertical')`
 * that WAS wired into all four readers. "PARK. cardId vertical" is the
 * opening clause template EVERY sport-segment PARK entry shares —
 * `classify-split-identity-rows.cjs`'s `pair` variable is prepended
 * identically whether the row is neither-backed, both-backed, or
 * title-vetoed. The wired predicate therefore admitted 100% of the tranche,
 * including the ~31K rows this module's own doc said stayed excluded. Fixed
 * by deleting the dead fragment and correcting the live one to test the
 * DISCRIMINATING TAIL of the sentence, not just its shared head.
 *
 * THE FULL CENSUS THAT BOUNDS THIS PREDICATE (read-only, 2026-09-19, against
 * every file matching `backend/data/pool-relocations/2026-09-07-split-
 * identity-*.json` — 52 files, 101,247 entries total; 87,542 of them are
 * PARK, the other 13,705 are RELOCATE/REPOINT and never carry
 * `identityUnverified`). Every distinct evidence pattern found in the PARK
 * entries, by leading/embedded phrase:
 *
 *   count   pattern                                                 admit?
 *   39,200  "...(cardId=no-catalog-row, hobbyiqCardId=no-catalog-     YES
 *           row)" — the literal neither-side-has-a-row closing
 *           parenthetical. Includes every VW3 row sampled (387/387).
 *    7,996  "Destination <slug> has NO card_catalog row" — the         YES
 *           Pokemon-phrasing variant of the SAME neither-backed
 *           class (a different template string, same meaning).
 *   17,662  "BOTH sides carry a checklist-backed catalog row"          NO
 *           — the catalog names a real card on BOTH addresses and
 *           cannot say which one this sale is.
 *   13,257  "the title states the vertical ... but the only            NO
 *           checklist-backed side is ..." — the sale's own title
 *           names a DIFFERENT vertical than the catalog-backed side.
 *    9,427  "...the checklist-backed side is the product ..." (no      NO
 *           "states the vertical" wording, but the SAME shape: one
 *           side IS checklist-backed — including a `self-derived-
 *           only` labelled side — and the title corroborates a
 *           different product or names none at all).
 *   -------
 *   87,542  total (39,200+7,996+17,662+13,257+9,427)
 *
 * So 39,200+7,996 = 47,196 rows (54% of the tranche) admit; 17,662+13,257+
 * 9,427 = 40,346 rows (46%) stay excluded. An evidence string that matches
 * NONE of the recognized patterns is EXCLUDED by construction (the predicate
 * is an allow-list of two positive shapes, not a deny-list) — see
 * `parkReasonCarveoutSql.test.ts`'s "unrecognized reason defaults to
 * excluded" case.
 *
 * `duplicate-partition-copy`, `malformed-key` (893 in this tranche; also the
 * write-guard's live enum reason), `sport-unresolved`, and every
 * `insert-named-*` reason are NEVER admitted — excluded by the prefix list
 * below, independent of the two positive shapes above (a reason can only
 * ever satisfy one class; this is belt-and-braces, not overlap).
 *
 * RU NOTE. `CONTAINS` is not index-served the way `STARTSWITH`/`=` are in
 * Cosmos — but every `CONTAINS` in `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL`
 * below runs ONLY inside the `identityUnverified != true OR (...)` disjunct,
 * which Cosmos only has to evaluate for rows that are (a) parked AND (b)
 * already matched by the query's own pool-key predicate (`c.cardId = @cid`
 * / `c.hobbyiqCardId = @cid`, index-served and evaluated first in the AND
 * chain). So the unindexed scan is bounded to one card's parked rows, not
 * the whole container — the same cost shape as the `flaggedWrong`/
 * `excludedFromFmv` disjuncts already in every one of these queries.
 *
 * THE ACTUAL FIX FOR THE VW3 REGRESSION IS ALSO A READ-SHAPE CARVE-OUT:
 * readers that resolve an identity EXCLUSIVELY through `hobbyiqCardId`
 * (soldCompsGradeReader, soldCompsStore.readCompsByCardId, and every
 * hobbyIqFmv.service `queryPool` call site — all of them branch to
 * `c.hobbyiqCardId = @id` for an `hiq:` slug and NEVER also match on
 * `c.cardId`) can safely re-admit the corrected reason-class wholesale,
 * because every row such a reader could ever return was already selected
 * BY its hobbyiqCardId — the wrong-sport leak #2330 fixed only ever
 * happened through the `cardId OR hobbyiqCardId` UNION in exactPoolReader,
 * which this predicate does NOT touch (see exactPoolReader.ts's own
 * comment); `exactPoolReader` keeps the union, so it applies the SAME
 * predicate only on rows whose `hobbyiqCardId` side matched, via a
 * CASE-shaped clause (see exactPoolReader.ts) — a `cardId`-only match stays
 * excluded regardless of reason.
 */

/** Free-text/enum prefixes that must NEVER be un-parked, regardless of which
 *  field matched. Matches both write-guard enum reasons
 *  (`splitIdentityWriteGuard.ts`'s `SplitIdentityReason`) and the 2026-09-07
 *  list lane's free-text `identityUnverifiedReason` sentences
 *  (`relocate-pool-rows-by-list.cjs` / `classify-split-identity-rows.cjs`). */
const NEVER_ADMIT_REASON_PREFIXES = [
  "duplicate-partition-copy",
  "malformed-key",
  "sport-unresolved",
  "insert-named-no-key",
  "two-inserts-named",
  "insert-named-unconfirmed",
] as const;

/**
 * THE ONE PREDICATE, used by every reader in this PR. A Cosmos SQL boolean
 * expression: true only when `c.identityUnverifiedReason` names a genuine,
 * undecidable sport/product split where NEITHER side carries a
 * checklist-backed catalog row — never a both-backed or title-vetoed park —
 * and is not one of the never-admit classes.
 *
 * Built as an ALLOW-LIST of exactly two positive shapes (the write-guard's
 * short enum, and the list lane's two neither-backed phrasings), each
 * additionally required NOT to carry the "BOTH sides carry" or "the title
 * states the vertical" phrases that the WRONG earlier version of this
 * predicate let slip through on a shared-prefix false positive (see the
 * module comment's REVIEW FINDING). An evidence string matching neither
 * shape — including every unrecognized future phrasing — falls through to
 * `false`: fail-closed, not fail-open.
 */
export const PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL =
  "(" +
  // The live write-guard's short-enum reason for a genuine, undecidable
  // sport split — never anything else, so no further guard is needed on it.
  "c.identityUnverifiedReason = 'split-identity'" +
  // The 2026-09-07 list lane's free-text NEITHER-backed phrasing, in its two
  // observed forms (classify-split-identity-rows.cjs: the explicit
  // "(cardId=no-catalog-row, hobbyiqCardId=no-catalog-row)" closing
  // parenthetical, and the Pokemon-phrasing "Destination <slug> has NO
  // card_catalog row" variant of the SAME meaning). Both are checked
  // POSITIVELY (CONTAINS the neither-backed marker) rather than by the
  // shared "PARK. cardId vertical" PREFIX every class opens with — that
  // shared prefix is exactly what let both-backed and title-vetoed rows
  // through in the version this replaces.
  " OR (STARTSWITH(c.identityUnverifiedReason, 'PARK. cardId vertical')" +
  "     AND (CONTAINS(c.identityUnverifiedReason, '(cardId=no-catalog-row, hobbyiqCardId=no-catalog-row)')" +
  "          OR CONTAINS(c.identityUnverifiedReason, ' has NO card_catalog row')))" +
  ")" +
  // Belt-and-braces negatives: even if a future phrasing widened the
  // positive match above, these two must never be admitted.
  " AND NOT CONTAINS(c.identityUnverifiedReason, 'BOTH sides carry')" +
  " AND NOT CONTAINS(c.identityUnverifiedReason, 'the title states the vertical')" +
  NEVER_ADMIT_REASON_PREFIXES.map((p) => ` AND NOT STARTSWITH(c.identityUnverifiedReason, '${p}')`).join("");
