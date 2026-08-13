// CF-PRICE-LOOKUP-COLLAPSE-GRADES (Drew, 2026-08-12).
//
// Drew's ruling: "a graded card IS an identity". A PSA 10 and a raw copy are
// separately-traded assets with their own populations and their own prices, so
// grade-suffixed rows belong in card_catalog. Nothing here deletes or demotes
// them.
//
// What this fixes is a COUNTING error downstream. Callers that ask "did I find
// one card or many?" were counting ROWS. A single 2024 Bowman Chrome Ohtani
// carries 13 rows (raw + psa-8/9/9.5/10 + bgs-9/9.5/10/10-black + sgc-10 +
// cgc-9.5/10), and card #85 carries eight more keyed on CardHedge vendor ids
// alongside its canonical `hiq:` twin. An unambiguous card therefore read as 21
// rival candidates, tripped the ambiguity guard, and returned a null FMV.
//
// Collapse to distinct physical cards first; judge ambiguity after.

export interface CatalogHit {
  id?: string | null;
  cardId?: string | null;
  year?: number | string | null;
  setKey?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  recentSaleCount?: number | null;
  [k: string]: unknown;
}

/**
 * Identity of the physical card, built from FIELDS rather than from `id`.
 *
 * Field-based is load-bearing: it is the only thing that merges a vendor-keyed
 * row (`cardId: "1727053918585x754433948322413200"`) with the canonical
 * `hiq:baseball:2024:bowman-chrome:85:base:no-auto` row for the same card.
 * Stripping a grade suffix off the id would collapse the grades but leave the
 * eight CardHedge rows looking like eight different cards.
 */
export function catalogIdentityKey(r: CatalogHit): string {
  return [
    r.year ?? "",
    String(r.setKey || r.setName || "").toLowerCase().trim(),
    String(r.cardNumber ?? "").toLowerCase().trim(),
    String(r.parallel ?? "").toLowerCase().trim(),
    r.isAuto ? "auto" : "no-auto",
    r.printRun ?? "",
  ].join("|");
}

/**
 * Which row best represents a card when resolving WHICH CARD was meant.
 *
 * Choosing the ungraded row is not choosing an ungraded price. Grade is priced
 * downstream: the caller passes gradeCompany/gradeValue to computeCanonicalFmv,
 * which keys its cache per tier, filters comps by grader+value and applies the
 * GRADE_CALIBRATION multiplier — so PSA 9 and PSA 10 stay separate market
 * values. The comps themselves hang off the BASE cardId, which is why the row
 * with no grade suffix is the right anchor for every tier.
 *
 * Order: ungraded before graded, canonical slug before vendor-keyed, then most
 * traded. `id === cardId` is the ungraded test — graded rows carry the grade as
 * an id suffix while keeping the base cardId, which is exactly the shape the
 * checklistcenter-graded ingest writes.
 *
 * Negative when `a` should win, mirroring Array.prototype.sort.
 */
export function preferUngradedCanonical(a: CatalogHit, b: CatalogHit): number {
  const graded = (r: CatalogHit) => (r.cardId && r.id === r.cardId ? 0 : 1);
  if (graded(a) !== graded(b)) return graded(a) - graded(b);

  const vendorKeyed = (r: CatalogHit) => (String(r.id || "").startsWith("hiq:") ? 0 : 1);
  if (vendorKeyed(a) !== vendorKeyed(b)) return vendorKeyed(a) - vendorKeyed(b);

  return Number(b.recentSaleCount || 0) - Number(a.recentSaleCount || 0);
}

/**
 * Collapse raw catalog rows to one representative row per physical card.
 *
 * Order-independent: the same input in any order yields the same winners.
 */
export function collapseCatalogHitsToCards(hits: readonly CatalogHit[]): CatalogHit[] {
  const byCard = new Map<string, CatalogHit>();
  for (const h of hits || []) {
    const k = catalogIdentityKey(h);
    const cur = byCard.get(k);
    if (!cur || preferUngradedCanonical(h, cur) < 0) byCard.set(k, h);
  }
  return [...byCard.values()];
}

/**
 * Drop variants the query never asked for.
 *
 * "2024 Bowman Chrome Ohtani Base" collapses to four real cards: base #85 plus
 * the II-OY insert auto at /1, /25 and /50. Those are genuinely different
 * cards, so the collapse above cannot merge them — but they are not rival
 * readings of this query. A query silent on serial numbering and silent on
 * autographs means the plain card, and leaving the numbered autos in the pool
 * is what keeps a clear question looking ambiguous.
 *
 * Each narrowing applies ONLY when it leaves something behind. Prospect-auto
 * sets have no unsigned card at all, and a set can be entirely serial-numbered;
 * in those cases the query still resolves rather than emptying out.
 */
export function narrowToRequestedVariants(
  cards: readonly CatalogHit[],
  opts: {
    wantsAuto?: boolean;
    wantsPrintRun?: boolean;
    exactSetKey?: string | null;
    hasExplicitCardNumber?: boolean;
  } = {},
): CatalogHit[] {
  let out = [...(cards || [])];

  // The catalog query has to CONTAINS-match setKey, because setName is sparse
  // and the caller only has spaced product text. But CONTAINS('bowman-chrome')
  // also matches bowman-chrome-sapphire and bowman-chrome-mega-box — separate
  // products that trade at their own prices, not readings of "Bowman Chrome".
  // An exact set match, where one exists, always beats a prefix match.
  //
  // And when NO exact row exists, the sub-products must not be substituted for
  // it. A prod probe for "2023 Topps Chrome Acuna Base" found no flagship base
  // row and silently resolved to topps-chrome-sapphire — a different card at a
  // different price, returned with full confidence. Rows whose setKey
  // contradicts the request are dropped outright; the caller gets a miss it can
  // seed, not a confident wrong answer. Rows with NO setKey are kept, since
  // they matched on setName and nothing disproves them.
  if (opts.exactSetKey) {
    const want = opts.exactSetKey.toLowerCase().trim();
    const setKeyOf = (c: CatalogHit) => String(c.setKey || "").toLowerCase().trim();
    const exact = out.filter((c) => setKeyOf(c) === want);
    out = exact.length > 0 ? exact : out.filter((c) => setKeyOf(c) === "");
  }

  // Prefer canonical slugs over vendor-keyed rows once any canonical row is
  // present. Vendor rows carry vendor identity mistakes with them (a #33
  // "Ohtani" in a set whose Ohtani is #85), and since the sold_comps roll-up
  // reached ~100% the canonical row is the one with the comps behind it.
  const canonical = out.filter((c) => String(c.id || "").startsWith("hiq:"));
  if (canonical.length > 0) out = canonical;

  // `parallel: "Base"` is overloaded. It means "not a parallel" — but an
  // INSERT is not a parallel either, so inserts sit in the flagship setKey
  // wearing Base and impersonate the base card. A prod probe for
  // "2024 Topps Chrome Skenes Base" came back with six survivors, every one an
  // insert (89CU-1, USC27, CAERU-1, YQ-51).
  //
  // Until the catalog carries an explicit insert/subset flag, numbering is the
  // discriminator: flagship base sets number 1..N while inserts carry an alpha
  // prefix. The ranking tie-break below already assumed this ("prefer numeric
  // cardNumbers, typically the base card"); applying it BEFORE the ambiguity
  // count is what lets a clear query resolve. Skipped when the caller named a
  // specific card number, and skipped when it would empty the pool — a
  // prospect-auto product is all alpha numbering and must still answer.
  if (!opts.hasExplicitCardNumber) {
    const baseNumbered = out.filter((c) => /^\d+$/.test(String(c.cardNumber ?? "").trim()));
    if (baseNumbered.length > 0) out = baseNumbered;
  }

  if (!opts.wantsPrintRun) {
    const unnumbered = out.filter((c) => c.printRun == null);
    if (unnumbered.length > 0) out = unnumbered;
  }
  if (!opts.wantsAuto) {
    const unsigned = out.filter((c) => !c.isAuto);
    if (unsigned.length > 0) out = unsigned;
  }
  return out;
}
