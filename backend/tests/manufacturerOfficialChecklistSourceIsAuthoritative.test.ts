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
//
// FOLLOW-UP (same day, same PR, urgent): the initial audit that pinned this
// found SIX more pre-existing disagreements between the loose and strict
// classifiers, one of them live: `beckett-s3-2026-09-19` scored loose=
// checklist / strict=false while 20,489 rows (2026 Topps Series 1, 2023
// Chrome Platinum, 2024 Donruss football) were ingested under exactly that
// tag THE SAME DAY -- written with checklist authority, judged NOT
// checklist-backed by the rematch and the clean-share audit. All six are
// fixed below, each with its own test, so the exception list this test used
// to carry is now EMPTY: every source string any manifest in this repo
// declares classifies the SAME WAY in both places.
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
});

describe("item 1: beckett-s3-<date> normalises to beckett, the same shape as beckett-scraped-<date>", () => {
  it("20,489 rows ingested 2026-09-19 under beckett-s3-2026-09-19 are strict, not just loose-checklist", () => {
    expect(K.normalizeCatalogSource("beckett-s3-2026-09-19")).toBe("beckett");
    expect(K.isStrictChecklistSource("beckett-s3-2026-09-19")).toBe(true);
    expect(catalogAuthorityOf("beckett-s3-2026-09-19")).toBe("checklist");
  });

  it("strips -s3 the same way -scraped already strips, on other publishers too, without inventing a beckett-s3 allowlist string", () => {
    expect(K.normalizeCatalogSource("tcdb-s3-2026-09-19")).toBe("tcdb");
    expect(K.STRICT_CHECKLIST_SOURCES).not.toContain("beckett-s3");
  });
});

describe("item 2: a compound a+b+c source is strict/checklist iff EVERY component is", () => {
  it("beckett+cardboardconnection and its 3-way permutation are now strict (every component is a strict publisher)", () => {
    expect(K.isStrictChecklistSource("beckett+cardboardconnection")).toBe(true);
    expect(K.isStrictChecklistSource("beckett+checklistinsider+cardboardconnection")).toBe(true);
    expect(K.isStrictChecklistSource("cardboardconnection+checklistinsider+beckett")).toBe(true);
    expect(catalogAuthorityOf("beckett+cardboardconnection")).toBe("checklist");
    expect(catalogAuthorityOf("beckett+checklistinsider+cardboardconnection")).toBe("checklist");
    expect(catalogAuthorityOf("cardboardconnection+checklistinsider+beckett")).toBe("checklist");
  });

  it("a compound with ONE weak component fails the WHOLE compound on both sides", () => {
    // baseballcardpedia+observed-sold-comps: "observed-sold-comps" is a sale
    // observation, not a checklist transcription -- correctly NOT strict,
    // and (this PR's change) now correctly NOT loose-checklist either, for
    // the RIGHT reason (every component checked) rather than the old wrong
    // reason (whole-string CHECKLIST regex never matched the compound
    // string at all on the strict side, while on the loose side it matched
    // only because "baseballcardpedia" happened to be A substring of the
    // whole string).
    expect(K.isStrictChecklistSource("baseballcardpedia+observed-sold-comps")).toBe(false);
    expect(catalogAuthorityOf("baseballcardpedia+observed-sold-comps")).not.toBe("checklist");
    // A fourth, unregistered "+si" component sinks an otherwise-strict trio.
    expect(K.isStrictChecklistSource("beckett+checklistinsider+cardboardconnection+si")).toBe(false);
    expect(catalogAuthorityOf("beckett+checklistinsider+cardboardconnection+si")).not.toBe("checklist");
  });

  it("BEFORE this PR the loose side passed a compound on ANY ONE component's substring match, regardless of the others -- this changes two manifests' class", () => {
    // Documented per the coordinator's request: this is what catalogAuthorityOf
    // did before this fix (unconditionally "checklist" for every compound
    // tested, because the unanchored CHECKLIST regex matches a substring of
    // the whole joined string). Restated here as the CURRENT, fixed
    // behaviour so the change is visible in the diff, not just asserted.
    // Old behaviour (whole-string substring match, not per-component):
    //   catalogAuthorityOf("baseballcardpedia+observed-sold-comps") -> "checklist" (WRONG)
    //   catalogAuthorityOf("beckett+checklistinsider+cardboardconnection+si") -> "checklist" (WRONG)
    // New behaviour (every component independently checklist):
    expect(catalogAuthorityOf("baseballcardpedia+observed-sold-comps")).toBe("unknown");
    expect(catalogAuthorityOf("beckett+checklistinsider+cardboardconnection+si")).toBe("unknown");
    // This DOES move two real manifests' declared class from checklist to
    // unknown: data/checklists/hand-fetched/parallels-2026-bowman-chrome-
    // baseball.json, parallels-2026-topps-chrome-baseball.json (both
    // baseballcardpedia+observed-sold-comps), and parallels-2025-topps-
    // chrome-platinum-baseball.json (the +si compound). All three are
    // parallel/ladder REFERENCE files consumed by
    // scripts/ingest-hand-fetched-checklists.cjs, which tags rows
    // `${manifest.source}-${manifest.fetchedAt}` and has no catalogAuthorityOf
    // gate of its own at ingest time -- so any already-ingested rows under
    // these exact tags will be judged differently by downstream code that
    // calls catalogAuthorityOf after this PR merges than they were before.
  });
});

describe("item 3: tcgdex-ja-modern reduces to the registered tcgdex-ja publisher lane", () => {
  it("both tcgdex-ja-modern and its sibling directory's own declared source classify strict/checklist", () => {
    // 53 committed manifests under backend/data/checklists/tcgdex-ja-modern/
    // and backend/data/checklists/tcgdex-ja-sv10/ both declare exactly
    // "tcgdex-ja-modern" as their source (checked directly, not assumed).
    expect(K.normalizeCatalogSource("tcgdex-ja-modern")).toBe("tcgdex-ja");
    expect(K.isStrictChecklistSource("tcgdex-ja-modern")).toBe(true);
    expect(catalogAuthorityOf("tcgdex-ja-modern")).toBe("checklist");
  });

  it("does not disturb the existing tcgdex-ja lane or its dated forms", () => {
    expect(K.isStrictChecklistSource("tcgdex-ja")).toBe(true);
    expect(K.isStrictChecklistSource("tcgdex-ja-2026-09-04")).toBe(true);
  });
});

describe("item 4 + 5: drew-google-sheet and *-drew-ruling* are checklist-grade on the loose side too", () => {
  it("drew-google-sheet, already strict, now has a loose CHECKLIST stem", () => {
    expect(K.isStrictChecklistSource("drew-google-sheet")).toBe(true);
    expect(catalogAuthorityOf("drew-google-sheet")).toBe("checklist");
    expect(catalogAuthorityOf("drew-google-sheet-2026-09-01")).toBe("checklist");
  });

  it("checklist-drew-ruling-<date>-<slug> is strict -- the date-strip is anchored at the end, so a trailing slug used to block it", () => {
    // checklist-drew-ruling-2026-08-30-red-ink: the trailing "-red-ink"
    // (naming WHICH ruling among several that day) stops
    // normalizeCatalogSource's END-anchored date strip from firing at all,
    // so the whole un-stripped string survived to the allowlist check and
    // failed it, even though the loose side already matched it via the bare
    // "checklist" substring.
    expect(K.isStrictChecklistSource("checklist-drew-ruling-2026-08-30-red-ink")).toBe(true);
    expect(catalogAuthorityOf("checklist-drew-ruling-2026-08-30-red-ink")).toBe("checklist");
  });

  it("a bare drew-ruling-<date> (Drew's own unaided, hand-authored ruling, no checklist name in the tag) is checklist-grade on both sides too", () => {
    expect(K.isStrictChecklistSource("drew-ruling-2026-08-30")).toBe(true);
    expect(K.isStrictChecklistSource("drew-ruling-2026-08-31")).toBe(true);
    expect(catalogAuthorityOf("drew-ruling-2026-08-30")).toBe("checklist");
    expect(catalogAuthorityOf("drew-ruling-2026-08-31")).toBe("checklist");
  });

  it("cardpedia-drew-ruling (already correct before this PR) is unaffected", () => {
    expect(K.isStrictChecklistSource("cardpedia-drew-ruling-2026-09-01")).toBe(true);
    expect(catalogAuthorityOf("cardpedia-drew-ruling-2026-09-01")).toBe("checklist");
  });

  it("does not sweep in an unrelated drew-* tag that names neither ruling nor the google sheet", () => {
    expect(K.isStrictChecklistSource("drew-bowman-parallels-xlsx")).toBe(false);
    expect(catalogAuthorityOf("drew-bowman-parallels-xlsx")).not.toBe("checklist");
  });
});

describe("item 6: checklistinsider-2026-09-19 and cardboardconnection-2026-09-19 (today's Prizm baseball / UD Extended ingests) are strict AND loose=checklist", () => {
  it("both were already correct before this PR -- confirmed, not changed", () => {
    expect(catalogAuthorityOf("checklistinsider-2026-09-19")).toBe("checklist");
    expect(K.isStrictChecklistSource("checklistinsider-2026-09-19")).toBe(true);
    expect(catalogAuthorityOf("cardboardconnection-2026-09-19")).toBe("checklist");
    expect(K.isStrictChecklistSource("cardboardconnection-2026-09-19")).toBe(true);
  });
});

describe("the full agreement audit: EVERY source declared by any manifest in this repo classifies the SAME WAY in both places, with NO exceptions", () => {
  it("zero disagreements across every distinct source string in backend/data/checklists/", () => {
    // Grepped fresh from every manifest's own "source" field. The exception
    // list this test used to carry (six pre-existing disagreements plus the
    // upperdeck tag) is now EMPTY -- every one of those was fixed by items
    // 1-5 above (upperdeck-2026-09-19 was renamed to upperdeck-official-
    // 2026-09-19 in the same PR, so it no longer appears in current manifests
    // at all; it is not re-tested here for that reason, and is covered by
    // the upperdeck-official test group above instead).
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
    const disagreements: string[] = [];
    for (const s of sources) {
      const loose = catalogAuthorityOf(s) === "checklist";
      const strict = K.isStrictChecklistSource(s);
      if (loose !== strict) {
        disagreements.push(`${s}: catalogAuthorityOf=${loose ? "checklist" : "not-checklist"} isStrictChecklistSource=${strict}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
