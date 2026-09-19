// CF-A-MANUFACTURERS-OWN-CHECKLIST-IS-A-CHECKLIST (2026-09-19).
//
// upperdeck.com's own checklist page is a manufacturer publishing its own
// product's card list -- the strongest possible checklist provenance there
// is. The source tag two staged hockey packages used, `upperdeck-2026-09-19`,
// classified as UNKNOWN in catalogAuthority.service.ts (no stem matched it),
// which blocked ingest at startup: `FATAL: SOURCE "upperdeck-2026-09-19"
// classifies as unknown, not checklist`. Fixed by adding a disambiguating
// `-official` tag (never a bare brand stem, which would also match a vendor
// or title string mentioning the brand) to BOTH classifiers that must agree
// on this question: catalogAuthority.service.ts's loose CHECKLIST regex
// (may this row count as evidence at all) and rematch-classify.cjs's
// STRICT_CHECKLIST_SOURCES allowlist (may this row alone prove a card
// exists) -- the same split CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-
// SOURCE-AGREES and the tcgdex-ja fix both document elsewhere in this repo.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { catalogAuthorityOf, canAdjudicate } from "../src/services/catalog/catalogAuthority.service";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");

const OFFICIAL_TAGS = ["upperdeck-official", "topps-official", "panini-official", "leaf-official"];

describe("a manufacturer's own -official checklist source", () => {
  it("classifies as CHECKLIST authority, dated or bare", () => {
    for (const tag of OFFICIAL_TAGS) {
      expect(catalogAuthorityOf(tag), tag).toBe("checklist");
      expect(catalogAuthorityOf(`${tag}-2026-09-19`), `${tag}-2026-09-19`).toBe("checklist");
    }
  });

  it("may adjudicate (canAdjudicate) like every other checklist source", () => {
    for (const tag of OFFICIAL_TAGS) {
      expect(canAdjudicate(`${tag}-2026-09-19`), tag).toBe(true);
    }
  });

  it("is a STRICT checklist source in rematch-classify.cjs too -- the two must agree", () => {
    for (const tag of OFFICIAL_TAGS) {
      expect(K.STRICT_CHECKLIST_SOURCES).toContain(tag);
      expect(K.isStrictChecklistSource(tag), tag).toBe(true);
      expect(K.isStrictChecklistSource(`${tag}-2026-09-19`), `${tag}-2026-09-19`).toBe(true);
    }
  });

  it("the exact tag the two staged Upper Deck hockey packages now use resolves correctly", () => {
    expect(catalogAuthorityOf("upperdeck-official-2026-09-19")).toBe("checklist");
    expect(K.isStrictChecklistSource("upperdeck-official-2026-09-19")).toBe(true);
  });

  it("does NOT widen to a bare brand stem -- a vendor or title string naming the brand stays unknown/non-strict", () => {
    for (const bad of ["upperdeck", "upperdeck-2026-09-19", "upper-deck", "topps", "panini", "leaf",
      "upperdeck-vendor-classification", "ebay-upperdeck-listing",
    ]) {
      expect(catalogAuthorityOf(bad), bad).not.toBe("checklist");
      expect(K.isStrictChecklistSource(bad), bad).toBe(false);
    }
  });

  it("a manufacturer's product-structure classification still routes to VENDOR, never CHECKLIST, even though it names the brand", () => {
    // -product-structure is checked BEFORE the CHECKLIST regex in
    // catalogAuthorityOf -- this pins that order is unaffected by the new
    // alternative, the same precedence bccp-product-structure already relies
    // on.
    expect(catalogAuthorityOf("cardhedge-upperdeck-product-structure")).toBe("vendor");
  });

  it("the pre-existing official-pdf alternative (bbm-japan-official-pdf) is untouched", () => {
    expect(catalogAuthorityOf("bbm-japan-official-pdf")).toBe("checklist");
    expect(catalogAuthorityOf("bbm-japan-official-pdf-2026-08-12")).toBe("checklist");
    expect(K.isStrictChecklistSource("bbm-japan-official-pdf")).toBe(true);
  });

  it("every source string this repo's checklist manifests actually declare classifies the SAME WAY in both catalogAuthorityOf and isStrictChecklistSource, or is already a known, pre-existing exception", () => {
    // Grepped from every manifest's own "source" field under
    // backend/data/checklists/ at the time this test was written. A NEW
    // disagreement here means a future acquisition's source tag will ingest
    // under one authority and get judged differently by the rematch/clean-
    // share audit -- exactly the outage this test exists to catch early.
    // KNOWN_PRE_EXISTING_DISAGREEMENTS are tags found to already disagree
    // BEFORE this PR -- listed by name, not fixed here (that is a larger,
    // separate audit), so this test does not regress on them while still
    // catching anything new.
    const KNOWN_PRE_EXISTING_DISAGREEMENTS = new Set([
      // Multi-source combined tags: catalogAuthorityOf's unanchored regex
      // matches the "beckett"/"cardboardconnection" substring inside them,
      // but rematch-classify.cjs's STRICT allowlist is an EXACT-STRING
      // match and these compound strings are not (and arguably should not
      // be, without a ruling on which single publisher's provenance a
      // three-way combined tag should inherit) listed verbatim.
      "beckett+cardboardconnection",
      "beckett+checklistinsider+cardboardconnection",
      "beckett+checklistinsider+cardboardconnection+si",
      "cardboardconnection+checklistinsider+beckett",
      "beckett-s3-2026-09-19",
      // A hand-ruling source naming "checklist" in a compound descriptive
      // slug, not a bare recognised stem -- an exact-string gap in the
      // STRICT allowlist, same shape as the multi-source tags above.
      "checklist-drew-ruling-2026-08-30-red-ink",
      // The loose observed-comps suffix on an otherwise-strict publisher --
      // normalizeCatalogSource does not strip "+observed-sold-comps", so the
      // exact-string STRICT allowlist misses it while the unanchored loose
      // regex still matches "baseballcardpedia" inside it.
      "baseballcardpedia+observed-sold-comps",
      // tcgdex's -ja lane has an extra, unstripped "-modern" suffix that
      // normalizeCatalogSource's suffix-stripping does not recognise (only
      // graded/attested/unnumbered/scraped and a trailing date are
      // stripped) -- so `tcgdex-ja-modern` normalises to itself, which is
      // not `tcgdex-ja` (the STRICT_PUBLISHER_LANES entry) and not `tcgdex`
      // (the STRICT_CHECKLIST_SOURCES entry) either, while the loose regex
      // still matches the bare "tcgdex" substring. Real, committed data
      // under backend/data/checklists/tcgdex-ja-modern/ is affected.
      "tcgdex-ja-modern",
      // The reverse direction: `drew-google-sheet` IS in the STRICT
      // allowlist (Drew's own hand-verified checklist sheets, explicitly
      // documented there) but has no stem in catalogAuthorityOf's CHECKLIST
      // regex, so the loose gate calls it "unknown" while the strict gate
      // trusts it to adjudicate -- a source the strict gate is MORE willing
      // to trust than the loose one, the opposite direction from every
      // other disagreement in this list.
      "drew-google-sheet",
    ]);
    const sources = [
      "baseballcardpedia", "baseballcardpedia+observed-sold-comps", "baseballcardpedia-2026-09-13",
      "baseballcardpedia-2026-09-15", "bbm-japan-official-pdf", "beckett", "beckett+cardboardconnection",
      "beckett+checklistinsider+cardboardconnection", "beckett+checklistinsider+cardboardconnection+si",
      "beckett-s3-2026-09-19", "both", "cardboard-connection", "cardboardconnection+checklistinsider+beckett",
      "cardboardconnection-2026-09-13", "cardboardconnection-2026-09-14", "cardboardconnection-2026-09-19",
      "cardpedia-drew-ruling-2026-09-01", "cardpedia-drew-ruling-2026-09-08", "cardpedia-drew-ruling-2026-09-09",
      "cardpedia-drew-ruling-2026-09-11", "checklist-drew-ruling-2026-08-30-red-ink", "checklistinsider",
      "checklistinsider-2026-09-13", "checklistinsider-2026-09-15", "checklistinsider-2026-09-19",
      "drew-bowman-parallels-xlsx", "drew-google-sheet", "drew-ruling-2026-08-30", "drew-ruling-2026-08-31",
      "hobbymonitor", "pokemon-tcg-data", "seed", "sportscardchecklist", "sportscardchecklist-2026-09-15",
      "tcdb", "tcdb-2026-09-13", "tcgdex-ja-modern", "upperdeck-official-2026-09-19",
    ];
    const newDisagreements: string[] = [];
    for (const s of sources) {
      const loose = catalogAuthorityOf(s) === "checklist";
      const strict = K.isStrictChecklistSource(s);
      if (loose !== strict && !KNOWN_PRE_EXISTING_DISAGREEMENTS.has(s)) {
        newDisagreements.push(`${s}: catalogAuthorityOf=${loose ? "checklist" : "not-checklist"} isStrictChecklistSource=${strict}`);
      }
    }
    expect(newDisagreements).toEqual([]);
  });
});
