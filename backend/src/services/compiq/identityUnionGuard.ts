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
 * REVIEW ROUND 1 (2026-09-19, BLOCKING, fixed): an earlier version of this
 * module shipped a wired predicate that matched only on the shared "PARK.
 * cardId vertical" PREFIX every sport-segment PARK entry opens with,
 * admitting 100% of the tranche including both-sides-backed and
 * title-vetoed rows. Fixed by testing the discriminating TAIL of the
 * sentence instead.
 *
 * REVIEW ROUND 2 (2026-09-19, OWNER RULING, restated and applied here): that
 * fix over-corrected the OTHER way. A live production-shape check of round
 * 1's PR found two more incident pools (`2023 Topps #472` and `#271`
 * basketball) that still did not recover, because their park reasons sit in
 * the both-sides-backed / title-veto classes round 1 newly excluded — yet
 * their titles plainly say Wembanyama/Spurs and `hobbyiqCardId` (basketball)
 * IS the right pricing id. The owner's actual decision was narrower than
 * round 1 read it: keep a split-identity sale priced when matched BY ITS
 * PRICING ID (hobbyiqCardId); keep it out of the wrong-sport pool; keep
 * duplicate copies excluded. It did NOT ask to newly exclude BOTH-sides or
 * title-veto sport-splits wholesale — that was round-1 scope creep. The ONE
 * principled exception the owner asked for: exclude a title-veto row ONLY
 * when the sale's OWN TITLE states a vertical that is NOT `hobbyiqCardId`'s
 * own sport — i.e. the title itself says the pricing id is wrong. A title
 * that confirms `hobbyiqCardId`'s sport (or says nothing about sport at all)
 * is not vetoing the pricing id, so it admits.
 *
 * THE FULL CENSUS THIS PREDICATE IS BUILT AND TESTED AGAINST (read-only,
 * 2026-09-19, every file matching `backend/data/pool-relocations/2026-09-07-
 * split-identity-*.json` — 52 files, 87,542 PARK entries; mutually exclusive
 * buckets, checked in this priority order so a row with more than one
 * marker is not double-counted):
 *
 *   count   pattern                                                 admit?
 *   54,671  NEITHER side carries a checklist-backed catalog row       YES
 *           (the closing parenthetical spells "not checklist-backed"
 *           three ways — "no-catalog-row" / "self-derived-only" /
 *           "unbacked" — in any combination on either side, or the
 *           Pokemon-phrasing "Destination <slug> has NO card_catalog
 *           row" variant). Includes every VW3 row sampled (387/387).
 *    1,059  ONE side IS checklist-backed and the title corroborates    YES
 *           a DIFFERENT PRODUCT, or names no product at all — a
 *           product-level veto, never a vertical/sport one; the
 *           owner's rule only excludes a VERTICAL contradiction.
 *   17,662  BOTH sides carry a checklist-backed catalog row — the      YES
 *           catalog names a real card on both addresses; nothing
 *           here contradicts hobbyiqCardId's sport.
 *    8,568  the title STATES a vertical, and it EQUALS hobbyiqCardId's YES
 *           own sport segment — the title confirms the pricing id.
 *    4,609  the title states a vertical that EQUALS cardId's sport     NO
 *           (the wrong side) — the sale's own title contradicts
 *           hobbyiqCardId, the owner's one exception.
 *       80  the title states a vertical that equals NEITHER side's     NO
 *           sport (e.g. "soccer" when the split is baseball/
 *           basketball) — does not confirm hobbyiqCardId either.
 *      893  malformed / key-defect address (a vendor key wearing an    NO
 *           `hiq:` prefix, or a non-canonical vertical segment) —
 *           never a decidable sport split at all.
 *   -------
 *   87,542  total (54,671+1,059+17,662+8,568+4,609+80+893)
 *
 * So 54,671+1,059+17,662+8,568 = 81,960 rows (94% of the tranche) admit;
 * 4,609+80+893 = 5,582 rows (6%) stay excluded — verified by running the
 * SQL expression below (not just the census script) against every real
 * evidence string via `parkReasonCensusAgainstRealListFiles.test.ts`'s
 * shared evaluator, which independently confirms 81,960/5,582 and requires
 * every one of the 87,542 real strings to land in a RECOGNIZED bucket
 * (unrecognized = 0) — a future evidence phrasing this predicate cannot
 * classify must still default-exclude (see the predicate's own fail-closed
 * shape below), but the test fails loudly if the real corpus ever contains
 * one, rather than silently trusting the allow-list covers everything
 * written so far. (An earlier draft of this census under-counted
 * neither-backed and missed the "title names no product" phrasing
 * entirely — both caught by that same test's "unrecognized = 0" assertion
 * failing during review, which is exactly why it exists as a hard gate
 * rather than a documentation comment alone.)
 *
 * WHY THE PREDICATE STILL FAILS CLOSED ON AN UNRECOGNIZED REASON: it is an
 * ALLOW-LIST (three positive shapes: the write-guard's `split-identity`
 * enum, the neither-backed phrasing, and "not a vertical-contradicting
 * title-veto"), not a deny-list. A reason this predicate has never seen
 * falls through every branch to `false`.
 *
 * `duplicate-partition-copy`, `malformed-key` (also the live write-guard
 * enum reason — the 893 malformed list-rows above are covered by the same
 * marker text `addressDefect` in `splitIdentityWriteGuard.ts` produces),
 * `sport-unresolved`, and every `insert-named-*` reason are NEVER
 * admitted — excluded by the prefix list below, independent of everything
 * else (a reason can only ever satisfy one class; this is belt-and-braces,
 * not overlap).
 *
 * RU NOTE. `CONTAINS`/`INDEX_OF`/`SUBSTRING` are not index-served the way
 * `STARTSWITH`/`=` are in Cosmos — but every one of them in
 * `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL` below runs ONLY inside the
 * `identityUnverified != true OR (...)` disjunct, which Cosmos only has to
 * evaluate for rows that are (a) parked AND (b) already matched by the
 * query's own pool-key predicate (`c.cardId = @cid` / `c.hobbyiqCardId =
 * @cid`, index-served and evaluated first in the AND chain). So the
 * unindexed scan is bounded to one card's parked rows, not the whole
 * container — the same cost shape as the `flaggedWrong`/`excludedFromFmv`
 * disjuncts already in every one of these queries.
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
 *
 * THE UNRESOLVED RISK, STATED PLAINLY (not fixed by a reader, tracked
 * separately): admitting the whole class restores pre-#2330 pricing for
 * every sport-split park except the title-contradicted ones, but it does
 * NOT verify hobbyiqCardId is correct. The write-guard's own doctrine
 * measured hobbyiqCardId correct only ~66% of the time on the comparable
 * same-setKey sport-split population — so roughly a third of the
 * neither-backed rows, and an unknown share of the both-sides/product-veto
 * rows, are filed under the wrong pool. That is the SAME error rate the
 * engine carried for years before #2330 ever shipped, not a new regression.
 * The cure is a RESOLUTION LANE, not a reader filter: for each parked
 * split-identity row, look up whether either side's setKey has a checklist
 * row naming the sale's player (and, where available, card number); the
 * side whose checklist confirms the player WINS and the row is
 * relocated/repointed/un-parked onto it (exactly the RELOCATE/REPOINT shape
 * `classify-split-identity-rows.cjs` already ships for the decidable
 * population); a row where neither side's checklist names the player (or
 * both do) stays parked, unresolved, exactly as today. That lane is
 * out of scope for this PR.
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
 * The shipped canonical-vertical vocabulary this predicate enumerates over
 * to test "the title's stated vertical equals hobbyiqCardId's own sport."
 * Re-exported rather than re-typed from `slugGuard.service.ts`'s
 * `CANONICAL_SPORTS` — the SAME set the write guard (`addressDefect`) and
 * every emitter already validate a sport segment against, so this predicate
 * learns a newly added sport in the same commit that ships it, instead of a
 * second, driftable copy.
 */
import { CANONICAL_SPORTS } from "../portfolioiq/slugGuard.service.js";

/**
 * `(STARTSWITH(c.hobbyiqCardId, 'hiq:<sport>:') AND CONTAINS(reason, 'the
 * title states the vertical "<sport>"'))`, OR-ed over every canonical sport
 * — the OWNER'S OFFERED SAFE FORM for "the title's stated vertical equals
 * hobbyiqCardId's own sport segment", built from the shipped vocabulary so
 * every canonical sport is covered without a second hand-typed list. Cosmos
 * SQL has no capture-group extraction, so rather than parsing the sport out
 * of `c.hobbyiqCardId` with SUBSTRING/INDEX_OF (fragile to compose correctly
 * inside a boolean expression and harder to verify by inspection), this
 * enumerates the finite, already-validated vocabulary as OR-ed pairs — the
 * census above confirms every "the title states the vertical" sport
 * actually observed in the corpus, and every hobbyiqCardId sport segment
 * this class carries, is one of these 17.
 */
function titleConfirmsHobbyiqCardIdVerticalSql(): string {
  const clauses = [...CANONICAL_SPORTS].map(
    (sport) =>
      `(STARTSWITH(c.hobbyiqCardId, 'hiq:${sport}:') AND CONTAINS(c.identityUnverifiedReason, 'the title states the vertical "${sport}"'))`,
  );
  return `(${clauses.join(" OR ")})`;
}

/**
 * THE ONE PREDICATE, used by every reader in this PR. A Cosmos SQL boolean
 * expression: true when `c.identityUnverifiedReason` names a sport-segment
 * split park whose title does NOT contradict `hobbyiqCardId`'s own sport,
 * and is not one of the never-admit classes.
 *
 * Built as an ALLOW-LIST of THREE positive shapes: the write-guard's short
 * enum (`split-identity`), the list lane's free-text sport-segment PARK
 * sentence (shared "PARK. cardId vertical" prefix) WITHOUT the vertical
 * veto phrase, and that SAME prefix WITH the vertical veto phrase but ONLY
 * when the stated vertical agrees with hobbyiqCardId's own sport. Malformed/
 * key-defect addresses are excluded structurally (their own distinguishing
 * phrases), independent of whether they also happen to carry a
 * neither-backed marker. An evidence string matching none of these —
 * including every unrecognized future phrasing — falls through to `false`:
 * fail-closed, not fail-open.
 */
export const PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL =
  "(" +
  // The live write-guard's short-enum reason for a genuine, undecidable
  // sport split — never anything else, so no further guard is needed on it.
  "c.identityUnverifiedReason = 'split-identity'" +
  // The 2026-09-07 list lane's free-text sport-segment PARK sentence: admit
  // it UNLESS the title explicitly states a vertical that is NOT
  // hobbyiqCardId's own sport (the owner's one exception) or the address
  // itself is malformed (never a decidable sport split).
  " OR (STARTSWITH(c.identityUnverifiedReason, 'PARK. cardId vertical')" +
  "     AND NOT CONTAINS(c.identityUnverifiedReason, 'which is not a canonical vertical')" +
  "     AND NOT CONTAINS(c.identityUnverifiedReason, 'contains an empty slug segment')" +
  "     AND NOT CONTAINS(c.identityUnverifiedReason, 'has only')" +
  "     AND (NOT CONTAINS(c.identityUnverifiedReason, 'the title states the vertical')" +
  `          OR ${titleConfirmsHobbyiqCardIdVerticalSql()}))` +
  ")" +
  NEVER_ADMIT_REASON_PREFIXES.map((p) => ` AND NOT STARTSWITH(c.identityUnverifiedReason, '${p}')`).join("");
