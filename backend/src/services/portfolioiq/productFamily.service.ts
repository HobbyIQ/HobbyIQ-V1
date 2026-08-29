// CF-PRODUCT-FAMILY (Drew, 2026-08-01). Every set slug expresses a
// parent-then-subproduct hierarchy in its dash-joined name:
//   bowman-chrome           → parent=bowman, subproduct=chrome
//   bowman-chrome-sapphire  → parent=bowman, subproduct=chrome-sapphire
//   bowman-mega-box         → parent=bowman, subproduct=mega-box
//   topps-chrome-platinum   → parent=topps,  subproduct=chrome-platinum
//   panini-donruss-optic    → parent=panini, subproduct=donruss-optic
//
// This helper exposes the relationship so pool queries can:
//   - Query a specific sub-product (bowman-mega-box)
//   - Fall back to sibling sub-products of same parent when pool is thin
//   - Roll up to parent brand for market-level analytics

const KNOWN_PARENTS = new Set([
  "bowman",
  "topps",
  "panini",
  "upper-deck",
  "fleer",
  "donruss",
  "leaf",
]);

export interface ProductFamily {
  parent: string;               // "bowman", "topps", "panini", etc.
  subproduct: string;           // "chrome", "mega-box", "chrome-platinum", etc. Empty for parent-only.
  slug: string;                 // original set slug
  hierarchy: string[];          // [parent, ...subproduct-segments]
}

export function parseProductFamily(setSlug: string): ProductFamily {
  const s = String(setSlug || "").trim().toLowerCase();
  if (!s) return { parent: "", subproduct: "", slug: s, hierarchy: [] };
  const segments = s.split("-");
  const parent = KNOWN_PARENTS.has(segments[0]) ? segments[0] : segments[0];
  const subproduct = segments.slice(1).join("-");
  return {
    parent,
    subproduct,
    slug: s,
    hierarchy: subproduct ? [parent, ...subproduct.split("-")] : [parent],
  };
}

// CF-CROSS-SETKEY-STAYS-HOME (D4 PR 5, 2026-08-29). The product FAMILY a
// pricing rung may cross setKeys within — the ladder the catalog matcher
// already honours (project_product_family_ladder): the first two segments.
//   bowman-chrome-prospects / bowman-chrome-updates / bowman-chrome-mega-box
//     -> bowman-chrome           (one family)
//   topps-chrome-update          -> topps-chrome
//   bowman-draft-chrome          -> bowman-draft (a second spelling of it)
//   bowman                       -> bowman        (NOT bowman-chrome: paper
//                                   and Chrome are different cards at
//                                   different prices — Drew, 2026-08-22)
//   topps                        -> topps         (NOT topps-chrome)
//   *sapphire*                   -> itself        (its own checklist; never
//                                   crosses — Drew, 2026-08-22)
export function productFamilyKey(setKey: string): string {
  const s = String(setKey || "").trim().toLowerCase();
  if (!s) return "";
  const segments = s.split("-").filter(Boolean);
  if (segments.includes("sapphire")) return s;
  return segments.slice(0, 2).join("-");
}

/** True iff two setKeys sit in the same product family (see
 *  productFamilyKey). A bare brand is its own family, so bowman never
 *  meets bowman-chrome and topps never meets topps-chrome. */
export function sameProductFamily(a: string, b: string): boolean {
  const ka = productFamilyKey(a);
  const kb = productFamilyKey(b);
  return ka !== "" && ka === kb;
}

/** Given a set slug, return all sibling sub-products under the same
 *  parent brand. Useful for "widen the pool" queries. */
export function siblingsOfParent(parent: string, allSlugs: string[]): string[] {
  return allSlugs.filter((s) => s.startsWith(`${parent}-`) || s === parent);
}

/** Human-friendly display name. `bowman-mega-box` → "Bowman > Mega Box". */
export function displayHierarchy(setSlug: string): string {
  const fam = parseProductFamily(setSlug);
  const titleCase = (s: string) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  if (!fam.subproduct) return titleCase(fam.parent);
  return `${titleCase(fam.parent)} > ${titleCase(fam.subproduct)}`;
}
