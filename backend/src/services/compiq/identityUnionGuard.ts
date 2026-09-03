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
