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
