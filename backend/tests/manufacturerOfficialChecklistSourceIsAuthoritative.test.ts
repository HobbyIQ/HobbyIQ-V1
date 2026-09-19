// CF-A-MANUFACTURERS-OWN-CHECKLIST-IS-A-CHECKLIST (2026-09-19).
//
// upperdeck.com's own checklist page is a manufacturer publishing its own
// product's card list -- the strongest possible checklist provenance there
// is. The source tag two staged hockey packages used, `upperdeck-2026-09-19`,
// classified as UNKNOWN in catalogAuthority.service.ts (no stem matched it),
// which blocked ingest at startup: `FATAL: SOURCE "upperdeck-2026-09-19"
// classifies as unknown, not checklist`. Fixed by adding a disambiguating
// `-official` tag (never a bare brand stem, which would also match a vendor
// or title string mentioning the brand) to catalogAuthority.service.ts's
// loose CHECKLIST regex (may this row count as evidence at all).
//
// SCOPE OF THIS PR. This is the LOOSE-classifier half only. The companion
// STRICT allowlist (rematch-classify.cjs's STRICT_CHECKLIST_SOURCES /
// isStrictChecklistSource -- "may this row alone prove a card exists") is a
// declared derivation input (derivation-version.cjs): changing it moves the
// I9 stamp and fails tests/i9ReferenceStamp.test.ts until a real 32-slot
// census re-baseline is done, which takes hours and is batched separately
// (see the HELD follow-up PR). That half is deliberately NOT in this PR, so
// the four new `*-official` tags below classify "checklist" on the loose
// side while still scoring non-strict on the STRICT side until the
// follow-up lands -- pinned explicitly below, not silently skipped.
//
// The full audit (grepping every `source` value across every manifest in
// backend/data/checklists/ and running both classifiers against each) also
// found pre-existing disagreements that predate this PR entirely and are
// not touched here either, for the same reason: closing them requires the
// same STRICT-side change and the same re-baseline. Named below with a
// one-line reason each, "closed by PR B".
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

  it("the exact tag the two staged Upper Deck hockey packages now use resolves correctly", () => {
    expect(catalogAuthorityOf("upperdeck-official-2026-09-19")).toBe("checklist");
  });

  it("does NOT widen to a bare brand stem -- a vendor or title string naming the brand stays unknown", () => {
    for (const bad of ["upperdeck", "upperdeck-2026-09-19", "upper-deck", "topps", "panini", "leaf",
      "upperdeck-vendor-classification", "ebay-upperdeck-listing",
    ]) {
      expect(catalogAuthorityOf(bad), bad).not.toBe("checklist");
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
  });

  it("does NOT introduce bare brand widening on vendor precedence -- an ebay/cardhedge tag naming the brand is never promoted", () => {
    expect(catalogAuthorityOf("ebay-upperdeck-listing")).toBe("vendor");
  });
});

describe("the cross-classifier agreement audit: every source declared by any manifest in this repo, with a NAMED exception list", () => {
  // This PR intentionally changes only the LOOSE side (catalogAuthorityOf).
  // The STRICT side (isStrictChecklistSource / rematch-classify.cjs) is a
  // declared derivation input and is NOT touched here -- it is a separate,
  // HELD PR that lands together with a real I9 census re-baseline. Every
  // entry below is a KNOWN, NAMED disagreement as of this PR, computed
  // against the source strings every manifest under backend/data/checklists/
  // actually declares (grepped fresh, not assumed) with this PR's changes
  // applied. The list must stay exhaustive, so a NEW, unnamed disagreement
  // still fails this test.
  const KNOWN_EXCEPTIONS: Record<string, string> = {
    // The tag the two staged Upper Deck hockey packages now use -- new in
    // this PR, loose-only. STRICT_CHECKLIST_SOURCES gains the matching
    // `upperdeck-official` (+ topps/panini/leaf, pre-emptively, not yet used
    // by any committed manifest) entry in PR B.
    "upperdeck-official-2026-09-19": "new in this PR, loose-only; closed by PR B",
    "topps-official": "new in this PR, loose-only, pre-registered ahead of use; closed by PR B",
    "panini-official": "new in this PR, loose-only, pre-registered ahead of use; closed by PR B",
    "leaf-official": "new in this PR, loose-only, pre-registered ahead of use; closed by PR B",
    // Pre-existing disagreements, predating this PR, not introduced or fixed
    // here -- each needs the same STRICT-side change PR B carries.
    "beckett+cardboardconnection": "compound a+b source; STRICT allowlist is exact-string, not component-aware; closed by PR B",
    "beckett+checklistinsider+cardboardconnection": "compound a+b+c source, same reason; closed by PR B",
    "beckett+checklistinsider+cardboardconnection+si": "compound source, same reason; closed by PR B",
    "cardboardconnection+checklistinsider+beckett": "compound source, same reason; closed by PR B",
    "beckett-s3-2026-09-19": "normalizeCatalogSource does not strip -s3 yet; closed by PR B",
    "checklist-drew-ruling-2026-08-30-red-ink": "trailing slug after the date blocks the end-anchored date strip; closed by PR B",
    "baseballcardpedia+observed-sold-comps": "compound source; correctly non-strict, but currently loose=checklist for the wrong reason (whole-string substring match); closed by PR B",
    "tcgdex-ja-modern": "unstripped -modern suffix, real committed data under data/checklists/tcgdex-ja-modern/; closed by PR B",
    "drew-google-sheet": "the one case running the OTHER direction -- STRICT already trusts it, loose does not; closed by PR B",
  };

  it("zero UNNAMED disagreements -- every disagreement is one of the ones named above", () => {
    // Grepped fresh from every manifest's own "source" field under
    // backend/data/checklists/ at the time this PR was written (38 distinct
    // strings, including the post-rename upperdeck-official-2026-09-19).
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
      // the other three manufacturer-official tags this PR registers on the
      // loose side, pre-emptively -- not yet used by any committed manifest,
      // but real once the next Topps/Panini/Leaf official acquisition lands.
      "topps-official", "panini-official", "leaf-official",
    ];
    const unnamedDisagreements: string[] = [];
    for (const s of sources) {
      const loose = catalogAuthorityOf(s) === "checklist";
      const strict = K.isStrictChecklistSource(s);
      if (loose !== strict && !(s in KNOWN_EXCEPTIONS)) {
        unnamedDisagreements.push(`${s}: catalogAuthorityOf=${loose ? "checklist" : "not-checklist"} isStrictChecklistSource=${strict}`);
      }
    }
    expect(unnamedDisagreements).toEqual([]);
  });

  it("every NAMED exception is still an actual, live disagreement -- the list does not go stale once PR B closes one", () => {
    // Guards the other direction: if PR B's fix lands here by mistake (or a
    // future edit accidentally closes one of these on the loose side only),
    // this fails loudly rather than silently carrying a dead exception.
    const sources = Object.keys(KNOWN_EXCEPTIONS);
    const stillDisagreeing = sources.filter((s) => {
      const loose = catalogAuthorityOf(s) === "checklist";
      const strict = K.isStrictChecklistSource(s);
      return loose !== strict;
    });
    expect(stillDisagreeing.sort()).toEqual(sources.sort());
  });
});
