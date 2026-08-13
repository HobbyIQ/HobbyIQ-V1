// CF-CATALOG-SEARCH-TIERS. Pins the rule that lets catalog coverage grow
// without degrading search.
//
// Comp-derived rows have twice become a search-quality problem
// (`sales-derived` purged 2026-08-08, `tree-builder-v1` excluded 2026-08-09).
// The sweep that gets roll-up past 85% creates ~10^5 more of them. They are
// safe only while search tiers them correctly, so the tiering is pinned here
// rather than left to a comment.
//
// Drew's model: verified cards are searchable; stubs are findable as a
// fallback when the checklist is missing; dead sources are never returned.

import { describe, it, expect } from "vitest";
import {
  catalogTier,
  isVerifiedCatalogRow,
  isProvisionalCatalogRow,
  verifiedCatalogSqlClause,
  provisionalCatalogSqlClause,
  STUB_VERIFICATION_STATUS,
} from "../src/services/catalog/catalogVisibility";

describe("catalogTier", () => {
  it("treats checklist-backed and human-confirmed rows as verified", () => {
    for (const s of ["checklist", "user-verified", "ch-catalog", "cs-catalog", "cardsight"]) {
      expect(catalogTier({ source: s }), `${s}`).toBe("verified");
    }
  });

  it("excludes CardHedge rows — they are a vendor's copy, not our card", () => {
    // CF-RETIRE-CARDHEDGE-ROWS (Drew, 2026-08-13: "clean up cardhege please
    // that is the problem"). CH is off at runtime but its rows kept surfacing
    // as if they were cards we own: four cardhedge:: rows above the real card
    // in search (all comps=0, because sales hang off the canonical slug), and
    // vendor bubble.io ids offered as the options in the review picker.
    expect(catalogTier({ source: "cardhedge" })).toBe("excluded");
    expect(catalogTier({ source: "cardhedge-graded" })).toBe("excluded");
  });

  it("excludes them by SOURCE, so the underlying rows survive", () => {
    // Deliberately not a delete: sold_comps rows reference vendor cardIds, and
    // removing the catalog rows would orphan real sales with no way back.
    // Reversible by removing two strings from EXCLUDED_SOURCES.
    const sql = verifiedCatalogSqlClause();
    expect(sql).toContain("c.source != 'cardhedge'");
    expect(sql).toContain("c.source != 'cardhedge-graded'");
  });

  it("treats a row with no provenance as legacy-authoritative", () => {
    // Most of the existing catalog predates provenance tagging. Treating
    // absence as untrusted would empty the search index.
    expect(catalogTier({})).toBe("verified");
    expect(catalogTier({ source: null, verificationStatus: null })).toBe("verified");
    expect(catalogTier({ source: "" })).toBe("verified");
  });

  it("treats comp-derived stubs as provisional, whatever the sweep date", () => {
    expect(catalogTier({ source: "sold-comps-stub-2026-08-12" })).toBe("provisional");
    expect(catalogTier({ source: "sold-comps-stub-2027-01-01" })).toBe("provisional");
  });

  it("treats pending-review as provisional, not excluded", () => {
    // These are findable-as-fallback, not banned — that is the whole point
    // of the tier: a card we have sales for should not be unfindable.
    expect(catalogTier({ source: "checklist", verificationStatus: STUB_VERIFICATION_STATUS }))
      .toBe("provisional");
  });

  it("excludes the two purged sources entirely — not even a fallback", () => {
    expect(catalogTier({ source: "sales-derived" })).toBe("excluded");
    expect(catalogTier({ source: "tree-builder-v1" })).toBe("excluded");
  });

  it("excludes rows rejected in review", () => {
    expect(catalogTier({ source: "checklist", verificationStatus: "rejected" })).toBe("excluded");
    // Rejection beats stub-ness: a rejected stub is not a fallback either.
    expect(catalogTier({ source: "sold-comps-stub-2026-08-12", verificationStatus: "rejected" }))
      .toBe("excluded");
  });

  it("keeps a stub provisional even if something stamped it verified", () => {
    // Provenance beats status, so a stray write cannot promote 100k stubs
    // into the primary tier. Promotion happens by REPLACING the row.
    expect(catalogTier({ source: "sold-comps-stub-2026-08-12", verificationStatus: "verified" }))
      .toBe("provisional");
  });

  it("exposes the tiers as predicates", () => {
    expect(isVerifiedCatalogRow({ source: "checklist" })).toBe(true);
    expect(isProvisionalCatalogRow({ source: "checklist" })).toBe(false);
    expect(isProvisionalCatalogRow({ source: "sold-comps-stub-2026-08-12" })).toBe(true);
    expect(isVerifiedCatalogRow({ source: "sold-comps-stub-2026-08-12" })).toBe(false);
  });
});

describe("SQL clauses mirror the predicates", () => {
  it("verified clause excludes stubs, dead sources and pending rows", () => {
    const sql = verifiedCatalogSqlClause();
    expect(sql).toContain("NOT STARTSWITH(c.source, 'sold-comps-stub-')");
    expect(sql).toContain("c.source != 'sales-derived'");
    expect(sql).toContain("c.source != 'tree-builder-v1'");
    expect(sql).toContain("c.verificationStatus != 'pending-review'");
  });

  it("verified clause stays permissive when fields are absent", () => {
    const sql = verifiedCatalogSqlClause();
    expect(sql).toContain("NOT IS_DEFINED(c.source)");
    expect(sql).toContain("NOT IS_DEFINED(c.verificationStatus)");
  });

  it("provisional clause selects stubs and never the dead sources", () => {
    const sql = provisionalCatalogSqlClause();
    expect(sql).toContain("STARTSWITH(c.source, 'sold-comps-stub-')");
    expect(sql).toContain("c.verificationStatus != 'rejected'");
    // Must not accidentally re-admit the purged rows as "fallback".
    expect(sql).not.toContain("sales-derived");
    expect(sql).not.toContain("tree-builder-v1");
  });

  it("the two tiers are disjoint", () => {
    // A row must never satisfy both clauses, or fallback results would
    // duplicate the primary ones.
    const rows = [
      { source: "checklist" },
      { source: "sold-comps-stub-2026-08-12" },
      { source: "sales-derived" },
      {},
    ];
    for (const r of rows) {
      expect(isVerifiedCatalogRow(r) && isProvisionalCatalogRow(r), JSON.stringify(r)).toBe(false);
    }
  });

  it("honours the alias", () => {
    expect(verifiedCatalogSqlClause("x")).toContain("x.source");
    expect(verifiedCatalogSqlClause("x")).not.toContain("c.source");
    expect(provisionalCatalogSqlClause("x")).toContain("x.source");
  });
});
