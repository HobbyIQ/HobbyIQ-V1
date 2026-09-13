/**
 * CF-A-GENERIC-WORD-NEVER-REPLACES-A-STATED-FINISH (round-2 parallel-semantics
 * ruling, item 2, 2026-09-13).
 *
 * The census's `changed:parallel` sample (7 non-Pokemon slots,
 * `census-slot-{1,2,3,4,5,6,9}.json`) showed 192 setKey-same,
 * generic-non-Base-result transitions where the DERIVED parallel genericized
 * the STORED one: a specific finish already read from the title ("Gold
 * Interstellar Refractor", "Silver Sparkle Refractor", "Silver Pulsar Prizm",
 * "Mosaic Honeycomb") collapsed to a bare sub-product word ("Chrome") or a
 * bare scarcity tag ("SSP") rather than the checklist-named finish the same
 * title states.
 *
 * ROOT CAUSE: three fallback rules in `extractParallel`
 * (parseTitleIdentity.service.ts) --
 *   1. the Heritage-gated bare "Chrome" return,
 *   2. the bare "Refractor" fallback, and
 *   3. the bare "SSP" fallback --
 * all `return` before `statedFinishFromChecklist` (the checklist-backed
 * reader, gated on a known product) gets a turn. Every one of these titles
 * names a checklist-attested finish this file has no hand-written rule for
 * (Cosmic Chrome's pattern-refractor family, 2026 Heritage's Sparkle
 * Refractor ladder, Mosaic's Honeycomb, Obsidian's Silver Pulsar Prizm), so
 * the generic/scarcity word answered in its place -- a DIFFERENT card
 * address, not a smaller one. Doctrine: named parallel/finish = distinct
 * card; SP =/= SSP and neither is a parallel name by itself (scarcity tags);
 * "Chrome" is a product word, not a parallel; scarcity tags never replace a
 * finish; only-improve (never more generic).
 *
 * FIX: each of the three fallbacks now asks `statedFinishFromChecklist` --
 * scoped to a KNOWN product (ctx.setKey truthy only, so the reader's
 * unscoped global index can never answer with an unrelated product's own
 * name) -- for a more specific stated finish before returning the generic
 * word. Where the checklist has nothing more specific to offer, the
 * generic/scarcity fallback still fires exactly as before (negatives below).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import { _resetStatedFinishCorpus } from "../src/services/portfolioiq/statedFinishFromChecklist";

const parallelOf = (
  title: string,
  ctx?: { year?: number | null; setKey?: string | null },
): string => parseListingIdentity(title, undefined, ctx ?? {}).parallel;

describe("CF-A-GENERIC-WORD-NEVER-REPLACES-A-STATED-FINISH", () => {
  beforeEach(() => _resetStatedFinishCorpus());

  // ── Cluster A: Topps Cosmic Chrome pattern-refractor family -> bare "Refractor" ──
  // census-slot-1/9, cardhedge::ch-daily. stored/checklist both say the pattern
  // name; the bare-Refractor fallback used to discard it.
  describe("Topps Cosmic Chrome pattern refractors beat bare Refractor", () => {
    const cases: Array<[string, number, string]> = [
      ["2025 Topps Cosmic Chrome Football #128 Orange Galactic Refractor", 2025, "Orange Galactic Refractor"],
      ["2025 Topps Cosmic Chrome Football #58 Blue Moon Refractor", 2025, "Blue Moon Refractor"],
      ["2025 Topps Cosmic Chrome Football #118 Nucleus Refractor", 2025, "Nucleus Refractor"],
      ["2025 Topps Cosmic Chrome Football #181 Green Space Dust Refractor", 2025, "Green Space Dust Refractor"],
      ["2025 Topps Cosmic Chrome Football #SC-2 Gold Interstellar Refractor", 2025, "Gold Interstellar Refractor"],
      ["2024 Topps Cosmic Chrome Baseball #90 Purple Nebula Refractor", 2024, "Purple Nebula Refractor"],
      ["2024 Topps Cosmic Chrome Baseball #ET-21 Black Eclipse Refractor", 2024, "Black Eclipse Refractor"],
    ];
    for (const [title, year, expected] of cases) {
      it(`"${title}" -> "${expected}" (not "Refractor")`, () => {
        expect(parallelOf(title, { year, setKey: "topps-cosmic-chrome" })).toBe(expected);
      });
    }
  });

  // ── Cluster B: 2026 Topps Heritage Sparkle Refractor ladder -> bare "Refractor" ──
  // census-slot-5/6, cardhedge::ch-daily. No rule anywhere named this ladder.
  describe("2026 Topps Heritage Sparkle Refractor ladder beats bare Refractor", () => {
    const cases: Array<[string, string]> = [
      ["2026 Topps Heritage Baseball #72 Burgundy Sparkle Refractor", "Burgundy Sparkle Refractor"],
      ["2026 Topps Heritage Baseball #258 Silver Sparkle Refractor", "Silver Sparkle Refractor"],
      ["2026 Topps Heritage Baseball #128 Pink Sparkle Refractor", "Pink Sparkle Refractor"],
      ["2026 Topps Heritage Baseball #119 Light Blue Sparkle Refractor", "Light Blue Sparkle Refractor"],
      ["2026 Topps Heritage Baseball #103 Aqua Sparkle Refractor", "Aqua Sparkle Refractor"],
    ];
    for (const [title, expected] of cases) {
      it(`"${title}" -> "${expected}" (not "Refractor")`, () => {
        expect(parallelOf(title, { year: 2026, setKey: "topps-heritage" })).toBe(expected);
      });
    }
  });

  // ── Cluster C: Topps Heritage Chrome, finish stated NOT adjacent to "Chrome" ──
  // census-slot-9, cardhedge::ch-daily. "Chrome" is the product's own name here
  // (topps-heritage-chrome); the real finish word sits elsewhere in the title.
  describe("Topps Heritage Chrome: a non-adjacent finish beats bare Chrome", () => {
    // NOTE: the real stored/taxonomy setKey for these rows is "topps-heritage"
    // -- `topps-heritage-chrome` is not a coded product in productSetKeys.ts.
    // "Chrome" here names the Chrome PARALLEL FAMILY within Heritage, not a
    // separate setKey; see the CF-CHROME-NAMES-THE-PRODUCT-NOT-THE-FINISH
    // comment block in parseTitleIdentity.service.ts.
    it('"2024 Topps Heritage Chrome Baseball #229 Refractor" -> a Refractor finish (not bare "Chrome")', () => {
      const got = parallelOf(
        "2024 Topps Heritage Chrome Baseball #229 Refractor",
        { year: 2024, setKey: "topps-heritage" },
      );
      expect(got).not.toBe("Chrome");
      expect(got.toLowerCase()).toContain("refractor");
    });
    it('"2024 Topps Heritage Chrome Baseball #405 Purple" -> a Purple finish (not bare "Chrome")', () => {
      const got = parallelOf(
        "2024 Topps Heritage Chrome Baseball #405 Purple",
        { year: 2024, setKey: "topps-heritage" },
      );
      expect(got).not.toBe("Chrome");
      expect(got.toLowerCase()).toContain("purple");
    });
    it('"2024 Topps Heritage Chrome Baseball #473 Black" -> a Black finish (not bare "Chrome")', () => {
      const got = parallelOf(
        "2024 Topps Heritage Chrome Baseball #473 Black",
        { year: 2024, setKey: "topps-heritage" },
      );
      expect(got).not.toBe("Chrome");
      expect(got.toLowerCase()).toContain("black");
    });
  });

  // ── Cluster D: scarcity tag (SSP) must not replace a stated finish ──
  // census-slot-3/4, cardhedge::ch-daily / tca-ebay.
  describe("SSP is a scarcity tag, not a finish -- it never replaces one", () => {
    // NOTE: `panini-obsidian`'s 2024 football checklist in the corpus
    // (data/checklist-parallel-names.json) carries a bare "Silver" and many
    // "... Silver" compounds but no "Pulsar" entry at all -- a genuine
    // checklist-ingest gap (round-2 ruling cluster 3's "not-checklist-backed"
    // shape), not a parser defect this fix can close. Per "absent beats
    // wrong" doctrine the honest answer stays "SSP" until the checklist is
    // backfilled; this pins that the fix does not paper over a coverage gap
    // with a guess.
    it('Obsidian "Silver Pulsar Prizm ... SSP" with no checklist coverage for Pulsar still answers "SSP" (coverage gap, not a guess)', () => {
      const got = parallelOf(
        "AARON RODGERS 2024 Panini Obsidian Silver Pulsar Prizm #151 NY Jets SSP MINT - Raw",
        { year: 2024, setKey: "panini-obsidian" },
      );
      expect(got).toBe("SSP");
    });
    it('Mosaic "Honeycomb SSP Case Hit" keeps Honeycomb, not bare "SSP"', () => {
      const got = parallelOf(
        "Joe Burrow 2024 Panini Mosaic Honeycomb SSP Case Hit #43 Bengals - Raw",
        { year: 2024, setKey: "panini-mosaic" },
      );
      expect(got).not.toBe("SSP");
      expect(got.toLowerCase()).toContain("honeycomb");
    });
  });

  // ── Negatives: the generic/scarcity fallback still fires when the checklist
  // has nothing more specific -- this fix narrows a false positive, it does
  // not disable the fallback. ──
  describe("negatives: generic fallback still answers when nothing more specific exists", () => {
    it('bare "Refractor" with no product context still returns "Refractor"', () => {
      // No setKey supplied -- the product-scoped guard added by this fix keeps
      // this on the plain fallback exactly as before.
      expect(parallelOf("1993 Topps Finest Baseball #100 Refractor")).toBe("Refractor");
    });
    it('bare "Chrome" in a plain Heritage title (no other finish word) still returns "Chrome"', () => {
      expect(parallelOf(
        "2026 Topps Heritage #136 Jac Caglianone Chrome RC",
        { year: 2026, setKey: "topps-heritage" },
      )).toBe("Chrome");
    });
    it('"Chrome White RC" in Heritage still returns "Chrome White" (adjacency rule unaffected)', () => {
      expect(parallelOf(
        "2026 Topps Heritage Jac Caglianone Chrome White RC #136",
        { year: 2026, setKey: "topps-heritage" },
      )).toBe("Chrome White");
    });
    it('a genuinely bare "SSP" with no other finish word still returns "SSP"', () => {
      expect(parallelOf(
        "2024 Panini Select #354 Josh Downs SSP Colts Suite Level",
        { year: 2024, setKey: "panini-select" },
      )).toBe("SSP");
    });
    it("Bowman/Topps Chrome colour rules are unaffected by the Heritage checklist call", () => {
      expect(parallelOf("Owen Carey Bowman Chrome Gold /50 Braves", { year: 2026, setKey: "bowman-chrome" }))
        .toBe("Gold Refractor");
      expect(parallelOf("2025 Topps Chrome Judge Blue /150 #100", { year: 2025, setKey: "topps-chrome" }))
        .toBe("Blue Refractor");
    });
  });
});
