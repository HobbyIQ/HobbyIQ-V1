/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04).
 *
 * These are MUTATION pins, not coverage. Each one is written so that the
 * obvious wrong version of the code fails it:
 *
 *   - classify `user-verified` by catalogAuthorityOf (it says "vendor")   -> fails
 *   - let a source containing "checklist" through before the derived test -> fails
 *   - treat a missing / unknown source as permission to price            -> fails
 *   - drop the `-graded` strip so graded children escape the class       -> fails
 *   - collapse the five backings to a boolean and lose the reason        -> fails
 *
 * The CJS retire lane cannot import this module, so it restates the two source
 * families as string lists. The last block pins those lists against THIS
 * module by classifying every one of them through both — the drift this repo
 * has been bitten by before (catalogAuthority's header records an allowlist
 * that decayed into reporting 6.1% coverage where the truth was 87.8%).
 */
import { describe, it, expect } from "vitest";
import {
  isSelfDerivedIdentity,
  isChecklistBackedIdentity,
  identityBackingOf,
  mayPublishPrice,
  NO_CHECKLIST_MATCH,
  IDENTITY_UNVERIFIED,
  RETIRED_SUPERSEDED_BY_CHECKLIST,
} from "../src/services/catalog/identityBacking.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

describe("isSelfDerivedIdentity", () => {
  it("classes the sales-minted families as self-derived", () => {
    for (const s of [
      "ingest-auto-seed",
      "ingest-auto-seed-graded",
      "sold-comps-stub-2026-08-12",
      "catalog-explode-actuals-2026-08-11",
      "sales-attested",
      "sales-attested-unnumbered",
      "derived-from-base-checklist-2026-08-23",
      "pool",
      "tree-builder-v1",
      "sales-derived",
    ]) {
      expect(isSelfDerivedIdentity(s), s).toBe(true);
    }
  });

  it("classes the USER-MINTED families as self-derived — the divergence from catalogAuthority", () => {
    // THE POINT OF THE FILE. catalogAuthorityOf calls each of these "vendor",
    // which is the right answer to "may it adjudicate a setKey" and the wrong
    // answer to "may a price rest on it". If someone ever routes this
    // predicate through catalogAuthorityOf, this block fails.
    for (const s of ["user-verified", "user-verified-graded", "ebay-user-purchase", "ebay-user-purchase-graded", "ebay-user-sale", "manual-user-entry", "holding-seeded-2026-08-11"]) {
      expect(isSelfDerivedIdentity(s), `${s} must be self-derived for pricing`).toBe(true);
    }
    // …and the disagreement is real, not an artefact of a shared helper.
    expect(catalogAuthorityOf("user-verified")).toBe("vendor");
    expect(catalogAuthorityOf("ebay-user-purchase")).toBe("vendor");
  });

  it("does NOT class real transcriptions or true vendor feeds as self-derived", () => {
    for (const s of ["checklistcenter-2026-08-29", "beckett-scraped-2026-09-04", "baseballcardpedia", "bccp", "hobbymonitor-2026-09-04", "cardhedge", "cardsight"]) {
      expect(isSelfDerivedIdentity(s), s).toBe(false);
    }
  });

  it("returns false — not true — for an absent source", () => {
    // Absence is unknown provenance. Calling it self-derived would sweep the
    // 133,568 untagged rows into a retire lane.
    for (const s of [null, undefined, "", "   ", "undefined", "null"]) {
      expect(isSelfDerivedIdentity(s as string | null | undefined), String(s)).toBe(false);
    }
  });
});

describe("isChecklistBackedIdentity", () => {
  it("admits the strict allowlist families", () => {
    for (const s of [
      "sportscardchecklist-2026-09-04",
      "checklistcenter-2026-08-29",
      "checklistinsider-2026-08-27",
      "beckett-checklist-2026-08-27",
      "baseballcardpedia-ladders-2026-09-04",
      "bccp-graded",
      "hobbymonitor-2026-09-04",
      "tcgdex-scraped",
      "tcdb-scrape",
      "cardboardchecklist-scraped-2026-08-14",
      "drew-ruling-checklist-2026-08-31",
    ]) {
      expect(isChecklistBackedIdentity(s), s).toBe(true);
    }
  });

  it("REFUSES a derived source that spells the word 'checklist'", () => {
    // The exact promotion catalogAuthority's DERIVED-first ordering exists to
    // prevent. Reordering the tests in that function fails this.
    expect(isChecklistBackedIdentity("derived-from-base-checklist-2026-08-23")).toBe(false);
    expect(isChecklistBackedIdentity("derived-from-base-checklist-tiffany-2026-08-23")).toBe(false);
    expect(isSelfDerivedIdentity("derived-from-base-checklist-2026-08-23")).toBe(true);
  });

  it("REFUSES vendor feeds, user-minted rows and untagged rows", () => {
    for (const s of ["cardhedge", "cardsight", "ebay-browse", "user-verified", "ebay-user-purchase", null, undefined, ""]) {
      expect(isChecklistBackedIdentity(s as string | null | undefined), String(s)).toBe(false);
    }
  });
});

describe("identityBackingOf", () => {
  const chk = { source: "checklistcenter-2026-08-29" };
  const sd = { source: "user-verified" };
  const vendor = { source: "cardhedge" };

  it("names no-slug and no-catalog-row apart", () => {
    expect(identityBackingOf("", [chk])).toBe("no-slug");
    expect(identityBackingOf(null, [chk])).toBe("no-slug");
    expect(identityBackingOf("hiq:baseball:2020:bowman:1:base:no-auto", [])).toBe("no-catalog-row");
    expect(identityBackingOf("hiq:baseball:2020:bowman:1:base:no-auto", null)).toBe("no-catalog-row");
  });

  it("ONE checklist row is enough, whatever else sits at the slug", () => {
    // This ordering is what makes the retire lane and the pricing gate agree:
    // retiring a self-derived twin can never flip a holding's verdict.
    expect(identityBackingOf("s", [sd, chk])).toBe("checklist-backed");
    expect(identityBackingOf("s", [chk, sd, vendor])).toBe("checklist-backed");
    expect(identityBackingOf("s", [chk])).toBe("checklist-backed");
  });

  it("self-derived-only and unbacked are DIFFERENT answers", () => {
    // Collapsing them loses the only thing that says which work unblocks the
    // row: acquire a checklist, or fix a matcher.
    expect(identityBackingOf("s", [sd])).toBe("self-derived-only");
    expect(identityBackingOf("s", [vendor])).toBe("unbacked");
    expect(identityBackingOf("s", [{ source: null }])).toBe("unbacked");
  });
});

describe("mayPublishPrice", () => {
  it("publishes ONLY on checklist-backed", () => {
    expect(mayPublishPrice("checklist-backed")).toBe(true);
    for (const b of ["self-derived-only", "unbacked", "no-catalog-row", "no-slug"] as const) {
      expect(mayPublishPrice(b), b).toBe(false);
    }
  });
});

describe("the CJS retire lane's source lists agree with this module", () => {
  // scripts/retire-self-derived-identities.cjs cannot import a TS module, so
  // it restates the families as string lists. Pin them here: a stem added to
  // one and not the other is the drift this repo has already been bitten by.
  const LANE_SELF_DERIVED = [
    "ingest-auto-seed", "sold-comps-stub", "catalog-explode", "tree-builder",
    "sales-derived", "sales-attested", "derived-from", "pool",
    "user-verified", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry",
    "holding-seeded",
  ];
  const LANE_CHECKLIST_STEMS = [
    "checklist", "beckett", "cardpedia", "bccp", "cardboardconnection",
    "almanac", "hobbymonitor", "tcdb", "tcgdex", "pokemon-tcg-data", "official-pdf",
  ];

  it("every stem the lane calls self-derived, this module calls self-derived", () => {
    for (const stem of LANE_SELF_DERIVED) {
      expect(isSelfDerivedIdentity(stem), stem).toBe(true);
      expect(isSelfDerivedIdentity(`${stem}-2026-09-04`), `${stem}-dated`).toBe(true);
      expect(isSelfDerivedIdentity(`${stem}-graded`), `${stem}-graded`).toBe(true);
    }
  });

  it("every stem the lane calls a checklist, this module admits — and none is self-derived", () => {
    for (const stem of LANE_CHECKLIST_STEMS) {
      const dated = `${stem}-scraped-2026-09-04`;
      expect(isChecklistBackedIdentity(dated), dated).toBe(true);
      expect(isSelfDerivedIdentity(dated), dated).toBe(false);
    }
  });
});

describe("the marker vocabulary is closed and stable", () => {
  it("names the strings the runner lane and the holding write both use", () => {
    // These strings are persisted on rows and read by the auditor; a rename
    // is a data migration, not a refactor.
    expect(NO_CHECKLIST_MATCH).toBe("no-checklist-match");
    expect(IDENTITY_UNVERIFIED).toBe("identityUnverified");
    expect(RETIRED_SUPERSEDED_BY_CHECKLIST).toBe("superseded-by-checklist");
  });
});
