// CF-CATALOG-AUTHORITY (2026-08-20).
//
// One declaration of "does this catalog row count as evidence?", replacing five
// near-identical copies that had drifted apart. The differences were not
// deliberate, and one of them flipped 51 card-number prefixes between "repair"
// and "blocked".
//
// The real production source strings are pinned here because they are the thing
// that rots: dated scrape runs and "-graded" twins mint a new source every
// night, and an exact allowlist decays silently. One did — it recognised 5 of
// ~30 checklist sources and reported 6.1% coverage where the truth was 87.8%.

import { describe, it, expect } from "vitest";
import {
  catalogAuthorityOf, canAdjudicate, isReKeyable, authorityRank, isTranscriptionGrade,
} from "../src/services/catalog/catalogAuthority.service.js";

describe("CF-CATALOG-AUTHORITY", () => {
  it("classifies the real checklist sources, including dated runs and -graded twins", () => {
    for (const s of [
      "checklistcenter", "checklistcenter-graded", "checklistcenter-html",
      "beckett-checklist", "beckett-checklist-graded",
      "beckett-scraped-2026-08-13", "beckett-scraped-2026-08-17", "beckett-scraped-2026-08-19",
      "baseballcardpedia", "baseballcardpedia-graded", "bccp", "bccp-graded",
      "checklistinsider-2026-08-11", "cardboardchecklist-scraped-2026-08-14",
      "cardboard-connection-scraped-2026-08-14", "baseball-almanac",
      "tcdb-2026-08-12", "bbm-japan-official-pdf-2026-08-12",
    ]) expect(catalogAuthorityOf(s), s).toBe("checklist");
  });

  it("classifies vendors — they record how a VENDOR types, not what was printed", () => {
    for (const s of ["cardhedge", "cardhedge-graded", "cardsight", "cardsight-graded",
      "ebay-browse", "ebay-user-purchase", "user-verified", "clc-product-structure",
    ]) expect(catalogAuthorityOf(s), s).toBe("vendor");
  });

  it("classifies DERIVED — rows generated from our own data", () => {
    // The dangerous class: a mis-slugged comp seeds a row, and that row then
    // confirms the comp.
    for (const s of ["ingest-auto-seed", "sold-comps-stub-2026-08-12",
      "sold-comps-stub-scarcity-scraped-2026-08-16", "catalog-explode-actuals-2026-08-12",
      "tree-builder-v1", "sales-derived", "pool",
    ]) expect(catalogAuthorityOf(s), s).toBe("derived");
  });

  it("a DERIVED source is never promoted by a checklist-ish word in its name", () => {
    // "sold-comps-stub-scarcity-SCRAPED-..." contains "scraped"; ordering must
    // keep it derived.
    expect(catalogAuthorityOf("sold-comps-stub-scarcity-scraped-2026-08-16")).toBe("derived");
    expect(catalogAuthorityOf("catalog-explode-actuals-2026-08-12")).toBe("derived");
  });

  it("treats missing/undefined source as unknown, never as evidence", () => {
    // 133,568 production rows literally have source "undefined".
    for (const s of [null, undefined, "", "   ", "undefined", "null"]) {
      expect(catalogAuthorityOf(s as string), String(s)).toBe("unknown");
      expect(canAdjudicate(s as string)).toBe(false);
    }
  });

  it("ONLY a checklist may adjudicate", () => {
    expect(canAdjudicate("checklistcenter")).toBe(true);
    expect(canAdjudicate("beckett-scraped-2026-08-19")).toBe(true);
    expect(canAdjudicate("cardhedge")).toBe(false);
    expect(canAdjudicate("ingest-auto-seed")).toBe(false);
    expect(canAdjudicate("undefined")).toBe(false);
  });

  it("everything except a checklist may be re-keyed", () => {
    // A checklist row is never moved — a checklist is what put it there.
    expect(isReKeyable("checklistcenter")).toBe(false);
    expect(isReKeyable("beckett-checklist")).toBe(false);
    // Drew: "that is correct, cardhedge classified it wrongly."
    expect(isReKeyable("cardhedge")).toBe(true);
    expect(isReKeyable("ingest-auto-seed")).toBe(true);
    expect(isReKeyable("undefined")).toBe(true);
  });

  it("ranks a checklist above a vendor above our own seed", () => {
    expect(authorityRank("checklistcenter")).toBeGreaterThan(authorityRank("cardhedge"));
    expect(authorityRank("cardhedge")).toBeGreaterThan(authorityRank("ingest-auto-seed"));
    expect(authorityRank("ingest-auto-seed")).toBeGreaterThan(authorityRank("undefined"));
  });
});

describe("CF-CATALOG-AUTHORITY — formatting vs coverage", () => {
  it("the wiki-style sources count for COVERAGE but not for FORMATTING", () => {
    // They disagree with themselves 12-18% on hyphenation, so they may say
    // WHICH cards exist but not HOW a number is spelled.
    for (const s of ["baseballcardpedia", "bccp", "baseballcardpedia-graded"]) {
      expect(canAdjudicate(s), `${s} coverage`).toBe(true);
      expect(isTranscriptionGrade(s), `${s} formatting`).toBe(false);
    }
  });

  it("the meticulous sources count for BOTH", () => {
    for (const s of ["checklistcenter", "checklistcenter-graded", "beckett-checklist",
      "beckett-scraped-2026-08-19", "checklistinsider-2026-08-11"]) {
      expect(canAdjudicate(s), `${s} coverage`).toBe(true);
      expect(isTranscriptionGrade(s), `${s} formatting`).toBe(true);
    }
  });

  it("checklistcenter-html is trusted for coverage but NOT formatting", () => {
    // Same site as checklistcenter, different extraction: 23% bare. The suffix
    // matters, and an exact-list approach kept missing it.
    expect(canAdjudicate("checklistcenter-html")).toBe(true);
    expect(isTranscriptionGrade("checklistcenter-html")).toBe(false);
  });

  it("nothing non-checklist is transcription grade", () => {
    for (const s of ["cardhedge", "ingest-auto-seed", "undefined", "sold-comps-stub-2026-08-12"]) {
      expect(isTranscriptionGrade(s), s).toBe(false);
    }
  });
});
