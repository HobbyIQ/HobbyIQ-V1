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
  isDerived,
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

// CF-SEARCH-AUTHORITY-RANK (Drew, 2026-08-20: "lets fix things the right way").
//
// Search ranked duplicate rows for one card by an exact eleven-string list.
// Every real checklist source fell outside it and scored the WORST rank, while
// self-seeded and vendor rows scored inside it — so a row we generated from our
// own comps beat a printed checklist, and search showed the self-confirming
// copy. These pin the ordering that stops that.
describe("isDerived - the predicate callers kept re-declaring", () => {
  it("covers every self-generated source, not just the two everyone remembers", () => {
    // The old inline Set was {sales-derived, tree-builder-v1}. The rest are the
    // same shape at far larger scale and were being treated as clean.
    for (const s of [
      "sales-derived", "tree-builder-v1",
      "ingest-auto-seed", "sold-comps-stub", "sold-comps-stub-2026-08-12",
      "catalog-explode", "catalog-explode-actuals", "pool",
    ]) {
      expect(isDerived(s), s).toBe(true);
    }
  });

  it("does NOT claim vendor or checklist rows", () => {
    // cardhedge is excluded from SEARCH by policy (catalogVisibility), but it is
    // not something we generated, and conflating the two questions un-hides it.
    for (const s of ["cardhedge", "cardsight", "ebay", "checklistcenter",
      "beckett-scraped-2026-08-19", "baseballcardpedia"]) {
      expect(isDerived(s), s).toBe(false);
    }
  });
});

describe("authorityRank beats a checklist row's dated source string", () => {
  it("ranks every real checklist source above derived, vendor and unknown", () => {
    // These are the exact pairings that were resolving backwards in production.
    const beats: Array<[string, string]> = [
      ["beckett-scraped-2026-08-19", "ingest-auto-seed"],
      ["baseballcardpedia", "ch-catalog"],
      ["checklistcenter", "cardhedge"],
      ["checklistinsider", "ingest-auto-seed"],
      ["bccp", "sold-comps-stub"],
    ];
    for (const [winner, loser] of beats) {
      expect(authorityRank(winner), `${winner} vs ${loser}`)
        .toBeGreaterThan(authorityRank(loser));
    }
  });

  it("orders the classes checklist > vendor > derived > unknown", () => {
    expect(authorityRank("checklistcenter")).toBe(3);
    expect(authorityRank("cardhedge")).toBe(2);
    expect(authorityRank("ingest-auto-seed")).toBe(1);
    expect(authorityRank("ch-catalog")).toBe(0);
  });
});
