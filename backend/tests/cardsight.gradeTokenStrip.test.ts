// CF-70-GRADE-STRIP (2026-06-21) — grade-token strip at Cardsight catalog layer.
//
// Issue #70: Cardsight's /catalog/search returns [] when the query contains
// a grade token. Confirmed via direct probe — Skenes "PSA 10" → 0 results,
// Griffey "PSA 9" → 0 results vs full results for the un-graded variants.
//
// Fix: strip the grade token before the catalog call. Grade survives
// independently via parseCardQuery's structured (gradeCompany, gradeValue)
// → cardsightGradesTaxonomy → selectSalesByGrade pipeline.
//
// This file pins BOTH halves:
//   1. The strip helper itself (no false positives, all 7 grader types
//      covered, edge cases including grade-only and sandwich positions).
//   2. The freetext grade-pipeline — parseCardQuery extracts grade tokens
//      to structured fields, body carries (gradeCompany, gradeValue),
//      computeEstimate's downstream comp-filter receives graded comps.
//      This is the "graded-pricing correctness" pre-commit check that
//      proves the strip doesn't silently re-price PSA 10 queries as raw.

import { describe, it, expect, vi } from "vitest";
import { stripGradeTokensForCatalog } from "../src/services/compiq/cardsight.client.js";

describe("CF-70-GRADE-STRIP — stripGradeTokensForCatalog", () => {
  describe("strips grade tokens that break Cardsight catalog", () => {
    it("strips PSA 10 from a modern query", () => {
      expect(stripGradeTokensForCatalog("Paul Skenes 2024 Topps Chrome PSA 10"))
        .toBe("Paul Skenes 2024 Topps Chrome");
    });

    it("strips PSA 9 from a vintage query (the Issue #70 repro)", () => {
      expect(stripGradeTokensForCatalog("1989 Upper Deck Ken Griffey Jr RC PSA 9"))
        .toBe("1989 Upper Deck Ken Griffey Jr RC");
    });

    it("strips half-grades (PSA 9.5)", () => {
      expect(stripGradeTokensForCatalog("Card name PSA 9.5"))
        .toBe("Card name");
    });

    it("strips BGS grades", () => {
      expect(stripGradeTokensForCatalog("Card BGS 9.5")).toBe("Card");
      expect(stripGradeTokensForCatalog("Card BGS 10")).toBe("Card");
    });

    it("strips SGC grades", () => {
      expect(stripGradeTokensForCatalog("Card SGC 10")).toBe("Card");
    });

    it("strips CGC grades", () => {
      expect(stripGradeTokensForCatalog("Card CGC 9")).toBe("Card");
    });

    it("strips HGA grades", () => {
      expect(stripGradeTokensForCatalog("Card HGA 8.5")).toBe("Card");
    });

    it("strips TAG and BCCG (less common but in the regex)", () => {
      expect(stripGradeTokensForCatalog("Card TAG 10")).toBe("Card");
      expect(stripGradeTokensForCatalog("Card BCCG 8")).toBe("Card");
    });

    it("strips lowercase grades (case-insensitive)", () => {
      expect(stripGradeTokensForCatalog("Card psa 10")).toBe("Card");
      expect(stripGradeTokensForCatalog("Card bgs 9.5")).toBe("Card");
    });

    it("strips multiple grade tokens in one query", () => {
      expect(stripGradeTokensForCatalog("Card PSA 10 BGS 9.5"))
        .toBe("Card");
    });

    it("strips grade token with no space between grader and number (PSA10)", () => {
      expect(stripGradeTokensForCatalog("Card PSA10")).toBe("Card");
    });

    it("collapses whitespace left by the strip", () => {
      expect(stripGradeTokensForCatalog("Paul Skenes  PSA 10  Topps Chrome"))
        .toBe("Paul Skenes Topps Chrome");
    });
  });

  describe("does NOT strip false positives", () => {
    it("does NOT strip grader names without a numeric grade", () => {
      // "PSA submission", "BGS grading service" — no numeric grade follows,
      // so these aren't graded-card queries.
      expect(stripGradeTokensForCatalog("PSA grading service"))
        .toBe("PSA grading service");
      expect(stripGradeTokensForCatalog("BGS submission center"))
        .toBe("BGS submission center");
    });

    it("does NOT match grader tokens embedded in words", () => {
      // Word-boundary anchored — PSALM should not match PSA, BGSomething
      // shouldn't match BGS, etc. Verified with realistic adjacent text.
      expect(stripGradeTokensForCatalog("Psalm 23"))
        .toBe("Psalm 23"); // Psalm is a word, not PSA
      expect(stripGradeTokensForCatalog("Sgcity 5"))
        .toBe("Sgcity 5"); // Not "SGC 5" — embedded in Sgcity
    });

    it("returns ungraded query byte-identical", () => {
      const q = "Paul Skenes 2024 Topps Chrome";
      expect(stripGradeTokensForCatalog(q)).toBe(q);
    });

    it("handles empty input", () => {
      expect(stripGradeTokensForCatalog("")).toBe("");
    });

    it("handles whitespace-only input", () => {
      expect(stripGradeTokensForCatalog("   ")).toBe("");
    });
  });

  describe("edge cases", () => {
    it("returns empty when input is grade-only", () => {
      // Caller (searchCatalog) checks for empty result and short-circuits
      // to [] rather than calling Cardsight with empty q.
      expect(stripGradeTokensForCatalog("PSA 10")).toBe("");
      expect(stripGradeTokensForCatalog("BGS 9.5")).toBe("");
    });

    it("preserves the rest of the query when grade-token is sandwiched", () => {
      expect(stripGradeTokensForCatalog("Mike Trout PSA 10 2011 Topps Update"))
        .toBe("Mike Trout 2011 Topps Update");
    });

    it("preserves the rest when grade-token is at start", () => {
      expect(stripGradeTokensForCatalog("PSA 10 Paul Skenes Topps Chrome"))
        .toBe("Paul Skenes Topps Chrome");
    });

    it("preserves the rest when grade-token is at end", () => {
      expect(stripGradeTokensForCatalog("Paul Skenes Topps Chrome PSA 10"))
        .toBe("Paul Skenes Topps Chrome");
    });
  });
});

// ─── Freetext grade pipeline — proves grade survives the strip ──────────
//
// The catalog-side strip is orthogonal to whether the extracted grade
// reaches the comp-filter. Drew's specific risk: after the strip, a
// "Skenes PSA 10" query resolves the card but prices it as raw (because
// grade got dropped instead of re-applied). These two tests close that.

// Mock cardsight.router BEFORE importing computeEstimate so the mock
// takes effect at module load. Same pattern as compiqEstimate.q8refinement.
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

describe("CF-70-GRADE-STRIP — freetext grade pipeline (pricing-half guarantee)", () => {
  it("parseCardQuery extracts grade tokens to structured fields and strips them from playerName (the bridge)", () => {
    // The route handler does parseCardQuery → requestFromParsed → computeEstimate.
    // requestFromParsed at compiq.routes.ts:335-349 reads parsed.gradingCompany
    // → body.gradeCompany and parsed.grade → body.gradeValue. If parsed carries
    // both, the body carries both, and computeEstimate's explicitGrade computation
    // at compiqEstimate.service.ts:2512-2517 produces "PSA 9" → cardHedgeGrade.
    // This test pins the parser side of that chain.
    const parsed = parseCardQuery("1989 Upper Deck Ken Griffey Jr RC PSA 9");
    expect(parsed.gradingCompany).toBe("PSA");
    expect(parsed.grade).toBe("9");
    expect(parsed.playerName).toBe("Ken Griffey Jr");
    expect(parsed.playerName?.toLowerCase()).not.toContain("psa");

    // And the Skenes modern case (the other Issue #70 repro)
    const skenes = parseCardQuery("Paul Skenes 2024 Topps Chrome PSA 10");
    expect(skenes.gradingCompany).toBe("PSA");
    expect(skenes.grade).toBe("10");
    expect(skenes.playerName).toBe("Paul Skenes");
    expect(skenes.playerName?.toLowerCase()).not.toContain("psa");
  });

  it("computeEstimate consumes structured (gradeCompany, gradeValue) and prices from graded comps, not raw", async () => {
    // Mirror what requestFromParsed produces from parseCardQuery for
    // "1989 Upper Deck Ken Griffey Jr RC PSA 9" — structured body with
    // grade fields populated. If the strip fix accidentally re-routed grade
    // through the catalog query (or if the engine doesn't honor structured
    // grade), this test fires — FMV would land on raw comps (~$20) not
    // PSA 9 comps (~$200), or estimate would be null.
    process.env.CARD_HEDGE_API_KEY = "test-key";
    const now = Date.now();
    const isoDaysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "griffey-89ud-rc",
        title: "1989 Upper Deck Ken Griffey Jr RC #1",
        player: "Ken Griffey Jr",
        set: "Base Set",
        year: 1989,
        number: "1",
        variant: null,
      },
      sales: [
        // 5 raw comps at $20-tier (would dominate if grade NOT threaded)
        ...Array.from({ length: 5 }, (_, i) => ({
          price: 18 + i,
          date: isoDaysAgo(i * 2),
          title: "1989 Upper Deck Ken Griffey Jr RC #1",
        })),
        // 5 PSA 9 comps at $200-tier (target — must be the bucket selected)
        ...Array.from({ length: 5 }, (_, i) => ({
          price: 195 + i * 3,
          date: isoDaysAgo(i * 2 + 1),
          title: "1989 Upper Deck Ken Griffey Jr RC #1 PSA 9",
        })),
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate(
      {
        playerName: "Ken Griffey Jr",
        cardYear: 1989,
        product: "Upper Deck",
        gradeCompany: "PSA",
        gradeValue: 9,
      } as any,
      testCallContext,
    )) as Record<string, any>;

    // The engine selected PSA 9 comps (~$195-207 range) and rejected raw
    // comps (~$18-22 range). FMV lands in the graded tier.
    //
    // If grade had been dropped (the failure mode Drew flagged), FMV would
    // either be raw-tier (~$20) or null (variant-mismatch from comps that
    // don't carry the grade). Either way, this assertion would fail loudly.
    expect(result.fairMarketValue ?? result.fairMarketValueLive ?? null).not.toBeNull();
    const fmv = (result.fairMarketValue ?? result.fairMarketValueLive) as number;
    expect(fmv).toBeGreaterThan(100); // far above raw tier ($18-22)
    expect(fmv).toBeLessThan(500); // sane upper bound for PSA 9 tier
  });
});
