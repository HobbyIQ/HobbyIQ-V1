/**
 * CF-A-DERIVED-SOURCE-MAY-NOT-SPELL-CHECKLIST (2026-09-04).
 *
 * catalogAuthority's own header says a derived row "must never outvote a
 * checklist", and the class comment says DERIVED is tested first "because
 * several derived sources embed a checklist-ish word". Two families we
 * actually write escaped that anyway, because the DERIVED regex is anchored
 * and their names do not start with a listed stem.
 *
 * The `derived-from-base-checklist-*` pair is the one that mattered. It ranked
 * EQUAL to a real transcription, and mergeCatalogEntries breaks a rank tie on
 * confidence with `>` — so on a tie the INCUMBENT keeps the row. A row we
 * synthesised from a base card therefore could not be corrected by the
 * checklist that owns the card: the ingest wrote, and the merge discarded.
 *
 * These pins are about the CLASSIFIER, not about any one product. The mutation
 * block at the bottom proves they fail against the regex as it was.
 */
import { describe, it, expect } from "vitest";
import {
  catalogAuthorityOf,
  authorityRank,
  canAdjudicate,
  isDerived,
  isReKeyable,
} from "../src/services/catalog/catalogAuthority.service.js";

/** Source strings this repo actually writes. Every one was read out of a
 *  script that mints it, not invented for the test. */
const SYNTHESISED = [
  // scripts/comp-quality/create-tiffany-cards-from-base.cjs:163
  "derived-from-base-checklist-2026-08-23",
  // scripts/comp-quality/create-product-line-cards-from-base.cjs:169
  "derived-from-base-checklist-tiffany-2026-08-23",
  // scripts/map-pokemon-setkeys-to-checklist.cjs:51, audit-sales-landing-by-authority.cjs:6
  "sales-attested",
  "sales-attested-2026-08",
];

/** A real transcription of a printed checklist. */
const TRANSCRIBED = [
  "sportscardchecklist",
  "sportscardchecklist-2026-09-04",
  "beckett-scraped-2026-08-19",
  "checklistcenter",
];

describe("a row we synthesised is DERIVED, whatever its name spells", () => {
  it.each(SYNTHESISED)("%s classifies derived, not checklist", (src) => {
    expect(catalogAuthorityOf(src)).toBe("derived");
    expect(isDerived(src)).toBe(true);
  });

  it.each(SYNTHESISED)("%s may not adjudicate and stays re-keyable", (src) => {
    expect(canAdjudicate(src)).toBe(false);
    expect(isReKeyable(src)).toBe(true);
  });

  it("ranks BELOW a checklist — strictly, so the merge's `>` can fire", () => {
    // The whole defect was an EQUAL rank. Equality is not a tie the checklist
    // wins; mergeCatalogEntries keeps the incumbent on a tie. So the assertion
    // that matters is strict inequality, not "does not exceed".
    for (const s of SYNTHESISED) {
      for (const t of TRANSCRIBED) {
        expect(authorityRank(s)).toBeLessThan(authorityRank(t));
      }
    }
  });

  it("sales-attested ranks WITH its ingest-auto-seed siblings, not below them", () => {
    // It was rank 0 (unknown) — beneath the seed rows it is a sibling of.
    expect(authorityRank("sales-attested")).toBe(authorityRank("ingest-auto-seed"));
    expect(authorityRank("sales-attested")).toBe(1);
  });

  it("the -graded twin of a synthesised row is synthesised too", () => {
    expect(catalogAuthorityOf("derived-from-base-checklist-2026-08-23-graded")).toBe("derived");
    expect(catalogAuthorityOf("sales-attested-graded")).toBe("derived");
  });
});

describe("the fix stays narrow — it demotes nothing it should not", () => {
  it.each(TRANSCRIBED)("%s is still a checklist at rank 3", (src) => {
    expect(catalogAuthorityOf(src)).toBe("checklist");
    expect(authorityRank(src)).toBe(3);
  });

  it("the anchor is kept: a checklist source is not demoted by the word 'derived'", () => {
    // An UNANCHORED derived regex would sweep any source with the word
    // anywhere in it. The stems are added by name for exactly this reason.
    expect(catalogAuthorityOf("checklistcenter-derived-notes")).toBe("checklist");
  });

  it("`sales-` is not widened to a bare prefix", () => {
    // A future sales-sourced TRANSCRIPTION must not be demoted by a word in
    // its name, any more than a derived one may be promoted by one.
    expect(catalogAuthorityOf("sales-checklist-transcription-2027")).toBe("checklist");
  });

  it("vendor and unknown are untouched", () => {
    expect(catalogAuthorityOf("cardhedge")).toBe("vendor");
    expect(catalogAuthorityOf("keymancollectibles")).toBe("unknown");
    expect(catalogAuthorityOf("")).toBe("unknown");
    expect(catalogAuthorityOf(null)).toBe("unknown");
  });
});

describe("the pins fail against the regex as it was", () => {
  it("the OLD anchored DERIVED promoted derived-from-base-* to checklist", () => {
    // The mutation, verbatim: the regex before the two stems were added.
    const OLD_DERIVED = /^(ingest-auto-seed|sold-comps-stub|catalog-explode|tree-builder|sales-derived|pool)/;
    const OLD_VENDOR = /^(cardhedge|cardsight|ebay|user-verified)/;
    const OLD_CHECKLIST = /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor|tcdb|tcgdex|pokemon-tcg-data|official-pdf/;
    const classifyOld = (source: string): string => {
      const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
      if (!s) return "unknown";
      if (OLD_DERIVED.test(s)) return "derived";
      if (OLD_VENDOR.test(s)) return "vendor";
      if (/-product-structure$/.test(s)) return "vendor";
      if (OLD_CHECKLIST.test(s)) return "checklist";
      return "unknown";
    };

    // The bug, stated: a synthesised row read as a transcription...
    expect(classifyOld("derived-from-base-checklist-2026-08-23")).toBe("checklist");
    // ...and sales-attested fell BELOW the seeds it is a sibling of.
    expect(classifyOld("sales-attested")).toBe("unknown");

    // The shipped classifier disagrees with the old one on exactly these, and
    // agrees with it everywhere the fix was not meant to reach.
    for (const s of SYNTHESISED) expect(catalogAuthorityOf(s)).not.toBe(classifyOld(s));
    for (const s of TRANSCRIBED) expect(catalogAuthorityOf(s)).toBe(classifyOld(s));
    expect(catalogAuthorityOf("cardhedge")).toBe(classifyOld("cardhedge"));
  });
});
