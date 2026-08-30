// CF-PRODUCT-FAMILY (Drew, 2026-08-01) — the relationship between a product
// and the family a pricing rung may cross into, and the brand it rolls up to.
//
// CF-THE-ID-CARRIES-THE-PRODUCT (D23, Drew 2026-08-30, ruling c). The family
// used to be the first two segments of the key — `split("-").slice(0, 2)` —
// which was right for bowman-chrome-prospects (bowman-chrome) and wrong for
// everything the ruling names: it made `topps-series-1` and `topps-sapphire`
// one family, could not say that `bowman-draft-1st-edition` is another set,
// and read `leaf-metal-draft` as a refinement of a `leaf-metal` it did not
// know. The family is READ FROM THE TABLE now (catalog/productSetKeys.ts):
//   topps-series-1 / topps-update-series      -> topps          (one family)
//   bowman-chrome-prospects / -updates / -mega-box -> bowman-chrome
//   topps-chrome-update-series               -> topps-chrome
//   bowman-draft-chrome                       -> bowman-draft
//   bowman                                    -> bowman   (NOT bowman-chrome:
//                                                 paper and Chrome are different
//                                                 cards — Drew, 2026-08-22)
//   topps                                     -> topps    (NOT topps-chrome)
//   *sapphire*, *1st-edition*                 -> itself   (own checklist; never
//                                                 crosses — Drew, 2026-08-22 / 30)
//   donruss / panini-donruss                  -> donruss  (one line, two owners)
//   a key the table does not know             -> itself   (an unknown product
//                                                 crosses nothing)
// A legacy spelling (`topps-update`) answers with its product's family, so
// pool rows keyed under an old spelling still price within the family while
// the rename fleet runs.

import { productAncestry, productEntry, productFamilyOf } from "../catalog/productSetKeys.js";

export interface ProductFamily {
  parent: string;               // the brand root: "bowman", "topps", "panini", ...
  subproduct: string;           // what follows the root on the ancestry walk; empty for a root
  slug: string;                 // original set slug
  hierarchy: string[];          // root → ... → the product itself
}

/** The product's place under its brand, from the table's parent chain
 *  (display and roll-up only — never identity, never the pricing family).
 *  A key the table does not know is its own root. */
export function parseProductFamily(setSlug: string): ProductFamily {
  const s = String(setSlug || "").trim().toLowerCase();
  if (!s) return { parent: "", subproduct: "", slug: s, hierarchy: [] };
  const chain = productAncestry(s).reverse();     // root first
  const parent = chain[0] ?? s;
  const rest = chain.slice(1);
  return {
    parent,
    subproduct: rest.join(" > "),
    slug: s,
    hierarchy: chain,
  };
}

// CF-CROSS-SETKEY-STAYS-HOME (D4 PR 5, 2026-08-29). The product FAMILY a
// pricing rung may cross setKeys within — the table's `family` column.
export function productFamilyKey(setKey: string): string {
  return productFamilyOf(setKey);
}

/** True iff two setKeys sit in the same product family (see
 *  productFamilyKey). A bare brand is its own family, so bowman never
 *  meets bowman-chrome and topps never meets topps-chrome. */
export function sameProductFamily(a: string, b: string): boolean {
  const ka = productFamilyKey(a);
  const kb = productFamilyKey(b);
  return ka !== "" && ka === kb;
}

/** Given a family (or brand) key, the slugs among `allSlugs` that belong to
 *  it — by the table, not by prefix. Useful for "widen the pool" queries. */
export function siblingsOfParent(parent: string, allSlugs: string[]): string[] {
  const p = String(parent || "").trim().toLowerCase();
  if (!p) return [];
  return allSlugs.filter((s) => s === p || productFamilyOf(s) === p || productAncestry(s).includes(p));
}

/** Human-friendly display name. `bowman-chrome-mega-box` → "Bowman > Bowman Chrome > Bowman Chrome Mega Box". */
export function displayHierarchy(setSlug: string): string {
  const fam = parseProductFamily(setSlug);
  const titleCase = (s: string) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  if (fam.hierarchy.length <= 1) return titleCase(fam.parent);
  return fam.hierarchy.map(titleCase).join(" > ");
}

/** Whether the table names this key (or one of its spellings) at all. */
export function isKnownProduct(setKey: string): boolean {
  return productEntry(setKey) !== null;
}
