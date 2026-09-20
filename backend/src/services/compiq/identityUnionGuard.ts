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
 * THE CENSUS THAT BOUNDS THIS CARVE-OUT (read-only, 2026-09-19, against the
 * shipped `2026-09-07-split-identity-sport-segment-*.json` lists —
 * `emit-split-identity-lists.cjs` / `classify-split-identity-rows.cjs`,
 * which stamped `identityUnverifiedReason` with the FULL evidence sentence
 * verbatim, not a short enum):
 *
 *   87,542 sport-segment PARK rows total. Of those:
 *     46,675 + 21,253  "NEITHER side carries a checklist-backed catalog row
 *                       (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row)"
 *                       — INCLUDES EVERY VW3 ROW (387/387 sampled). The
 *                       catalog has NO row on either side; hobbyiqCardId is
 *                       only the title-parse's guess, not a verified card.
 *      17,662           "BOTH sides carry a checklist-backed catalog row" —
 *                       the catalog names a real card on BOTH addresses and
 *                       cannot say which one this sale is.
 *       1,059            the title states a DIFFERENT vertical than the
 *                       catalog-backed hobbyiqCardId side outright (a title
 *                       veto) — un-parking these would refile a sale under a
 *                       sport its own title contradicts.
 *         893           malformed / key-defect addresses.
 *
 * NONE of these are the "exactly one side is checklist-backed and the title
 * doesn't contradict it" case — that combination was never parked at all;
 * `classify-split-identity-rows.cjs` ships it as a RELOCATE/REPOINT list
 * instead (10,045 + 3,660 rows, already applied, not stamped
 * `identityUnverified`). So there is no live population where this
 * predicate's `IDENTITY_UNVERIFIED_CATALOG_BACKED_HOBBYIQ_SIDE` clause below
 * would actually fire on the sport-segment tranche — it exists for the
 * SHAPE (a future or as-yet-unmeasured park whose reason DOES record a
 * catalog-backed hobbyiqCardId side with no contradicting title), and it is
 * deliberately narrow: it requires the reason to affirmatively say
 * `hobbyiqCardId=checklist-backed` and must not also carry `cardId=
 * checklist-backed` (both-backed) or the title-veto phrase.
 *
 * THE ACTUAL FIX FOR THE VW3 REGRESSION IS THE READ-SHAPE CARVE-OUT, NOT A
 * REASON-TEXT ONE: readers that resolve an identity EXCLUSIVELY through
 * `hobbyiqCardId` (soldCompsGradeReader, soldCompsStore.readCompsByCardId,
 * and every hobbyIqFmv.service `queryPool` call site — all of them branch to
 * `c.hobbyiqCardId = @id` for an `hiq:` slug and NEVER also match on
 * `c.cardId`) can safely re-admit the sport-segment PARK class wholesale,
 * because every row such a reader could ever return was already selected
 * BY its hobbyiqCardId — the wrong-sport leak #2330 fixed only ever
 * happened through the `cardId OR hobbyiqCardId` UNION in exactPoolReader,
 * which this predicate does NOT touch (see exactPoolReader.ts's own
 * comment). Those readers get `PARK_REASON_ADMITS_HOBBYIQ_MATCH` below.
 *
 * `exactPoolReader` keeps the union, so it cannot use the wholesale
 * carve-out without reopening the leak; it applies this SAME predicate only
 * on rows whose `hobbyiqCardId` side matched, via a CASE-shaped clause (see
 * exactPoolReader.ts) — a `cardId`-only match stays excluded regardless of
 * reason.
 *
 * duplicate-partition-copy, malformed-key, sport-unresolved (no usable
 * hobbyiqCardId), and the insert-named-* reasons are NEVER admitted by
 * either helper — they are excluded by construction below (the prefix list)
 * and additionally can never be true for a park whose only evidence is a
 * sport/product disagreement.
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
 * A Cosmos SQL boolean expression: true when `c.identityUnverifiedReason`
 * names the split-identity/sport-mismatch class in a way that affirmatively
 * documents `hobbyiqCardId` as the checklist-backed (or at least not
 * contradicted-by-title) side, and is NOT one of the never-admit classes.
 *
 * Deliberately a STRING PREFIX/CONTENT test, not a parse of the free-text
 * evidence sentence — Cosmos SQL has no regex-capture, and the two producers
 * of this field (the live write guard's short enum, the list lane's long
 * sentence) do not share a machine-readable shape beyond substrings. See the
 * module comment above for the measured population this was checked
 * against: the current sport-segment tranche never actually satisfies the
 * positive `hobbyiqCardId=checklist-backed`-without-title-veto branch (that
 * combination ships as RELOCATE/REPOINT, never PARK), so on TODAY's data
 * this clause only matters for whichever reader ALSO uses the wholesale
 * carve-out below; it is still asserted because a future PARK list may
 * populate it and the clause must already refuse the classes that must
 * never pass.
 */
export const PARK_REASON_STRUCTURAL_CARVEOUT_SQL =
  "IS_DEFINED(c.identityUnverifiedReason)" +
  " AND CONTAINS(c.identityUnverifiedReason, 'hobbyiqCardId=checklist-backed')" +
  " AND NOT CONTAINS(c.identityUnverifiedReason, 'cardId=checklist-backed')" +
  " AND NOT CONTAINS(c.identityUnverifiedReason, 'the title states the vertical')" +
  NEVER_ADMIT_REASON_PREFIXES.map((p) => ` AND NOT STARTSWITH(c.identityUnverifiedReason, '${p}')`).join("");

/**
 * The WHOLESALE carve-out for a reader that resolves identity EXCLUSIVELY
 * through `hobbyiqCardId` (never unions against `cardId`). Safe to admit the
 * whole split-identity/sport-mismatch PARK class here — see the module
 * comment's "READ-SHAPE CARVE-OUT" section — because a reader with this
 * shape can only ever have matched the row BY its hobbyiqCardId in the first
 * place, so #2330's fixed leak (the `cardId OR hobbyiqCardId` union in
 * exactPoolReader) cannot recur through this path.
 *
 * Still refuses duplicate-partition-copy / malformed-key / sport-unresolved
 * / insert-named-* — those are never a sport-mismatch and their exclusion
 * must hold on every path.
 */
export const PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL =
  "(" +
  // The live write-guard's short-enum reason for a genuine, undecidable
  // sport split.
  "c.identityUnverifiedReason = 'split-identity'" +
  // The 2026-09-07 list lane's free-text evidence sentence for the SAME
  // class always opens with "PARK. cardId vertical" (see
  // classify-split-identity-rows.cjs's `pair` template) and is never one of
  // the never-admit classes (checked again below, belt-and-braces with the
  // prefix list already ruling out the literal duplicate-partition-copy /
  // malformed-key / insert-named-* strings, which never start with "PARK.").
  " OR STARTSWITH(c.identityUnverifiedReason, 'PARK. cardId vertical')" +
  ")" +
  NEVER_ADMIT_REASON_PREFIXES.map((p) => ` AND NOT STARTSWITH(c.identityUnverifiedReason, '${p}')`).join("");
