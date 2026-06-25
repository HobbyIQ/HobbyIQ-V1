import { describe, it, expect } from "vitest";
import { stripGradingTokens } from "../src/services/compiq/cardhedge.client";

// Regression coverage for issue #6 — PSA-grade tokens in the query string
// were being sent verbatim to Card Hedge's AI match + search endpoints,
// dropping confidence below 0.80 and skewing search ranking on strict
// auto + color + parallel SKUs, which fell through to a wrong-variant
// fallback and emitted a spurious "autograph" variantWarning.
//
// stripGradingTokens runs at the top of findCompsByQuery so every CH
// call downstream is grade-free. Grade is still passed separately via
// opts.grade to getCardSales().

describe("stripGradingTokens", () => {
  describe("PSA", () => {
    it("strips PSA 10", () => {
      expect(stripGradingTokens("Jacob Wilson PSA 10")).toBe("Jacob Wilson");
    });
    it("strips PSA 9", () => {
      expect(stripGradingTokens("Griffey PSA 9")).toBe("Griffey");
    });
    it("strips PSA 9.5", () => {
      expect(stripGradingTokens("Trout PSA 9.5")).toBe("Trout");
    });
    it("strips PSA 8", () => {
      expect(stripGradingTokens("Jordan PSA 8")).toBe("Jordan");
    });
    it("strips PSA with no space (psa10)", () => {
      expect(stripGradingTokens("Jordan psa10")).toBe("Jordan");
    });
    it("is case-insensitive (psa 10 / Psa 10 / PSA 10)", () => {
      expect(stripGradingTokens("Card psa 10")).toBe("Card");
      expect(stripGradingTokens("Card Psa 10")).toBe("Card");
      expect(stripGradingTokens("Card PSA 10")).toBe("Card");
    });
  });

  describe("other grading companies", () => {
    it("strips BGS 9.5", () => {
      expect(stripGradingTokens("Card BGS 9.5")).toBe("Card");
    });
    it("strips SGC 10", () => {
      expect(stripGradingTokens("Card SGC 10")).toBe("Card");
    });
    it("strips CGC 9", () => {
      expect(stripGradingTokens("Card CGC 9")).toBe("Card");
    });
    it("strips HGA 10", () => {
      expect(stripGradingTokens("Card HGA 10")).toBe("Card");
    });
    it("strips Beckett 9.5", () => {
      expect(stripGradingTokens("Card Beckett 9.5")).toBe("Card");
    });
  });

  describe("Gem Mint / Raw", () => {
    it("strips 'Gem Mint'", () => {
      expect(stripGradingTokens("Card Gem Mint")).toBe("Card");
    });
    it("strips 'gem mint' lowercase", () => {
      expect(stripGradingTokens("Card gem mint")).toBe("Card");
    });
    it("strips bare 'Raw'", () => {
      expect(stripGradingTokens("Card Raw")).toBe("Card");
    });
    it("strips bare 'raw' lowercase", () => {
      expect(stripGradingTokens("Card raw")).toBe("Card");
    });
  });

  describe("preservation — must NOT strip non-grade content", () => {
    it("preserves print runs (/150, /99, /25)", () => {
      expect(stripGradingTokens("Blue Wave /150 PSA 10")).toBe("Blue Wave /150");
      expect(stripGradingTokens("Gold /25 PSA 9")).toBe("Gold /25");
      expect(stripGradingTokens("Refractor /99")).toBe("Refractor /99");
    });
    it("preserves #/nn print run format", () => {
      expect(stripGradingTokens("Gold #/25 PSA 9")).toBe("Gold #/25");
    });
    it("preserves card numbers (BD-31, CPA-CBO)", () => {
      expect(stripGradingTokens("Bowman BD-31 PSA 10")).toBe("Bowman BD-31");
      expect(stripGradingTokens("CPA-CBO PSA 10")).toBe("CPA-CBO");
    });
    it("preserves year (2023, 2024, 2025)", () => {
      expect(stripGradingTokens("2024 Bowman Draft PSA 10")).toBe("2024 Bowman Draft");
    });
    it("preserves auto / refractor / color tokens", () => {
      expect(stripGradingTokens("Green Refractor Auto PSA 10")).toBe("Green Refractor Auto");
    });
    it("is idempotent on grade-free strings", () => {
      const q = "2023 Bowman Draft Green Refractor Auto Jacob Wilson";
      expect(stripGradingTokens(q)).toBe(q);
    });
    it("collapses internal whitespace after stripping", () => {
      expect(stripGradingTokens("Card  PSA 10  Auto")).toBe("Card Auto");
    });
    it("returns empty string on a grade-only query (caller falls back)", () => {
      expect(stripGradingTokens("PSA 10")).toBe("");
    });
  });

  describe("issue #6 reproducing cases — full Tier-1 queries", () => {
    // These three cases reproduce variant-mismatch on production today
    // because the grade tokens reach Card Hedge unmodified. After this fix
    // each query strips down to the SKU-only form CH expects, and CH AI
    // match should return the strict auto+color+refractor SKU directly.
    const cases: Array<[string, string, string]> = [
      [
        "case 01",
        "2023 Bowman Draft Green Refractor Auto Jacob Wilson PSA 10",
        "2023 Bowman Draft Green Refractor Auto Jacob Wilson",
      ],
      [
        "case 04b",
        "2024 Bowman Draft Chrome Refractor Auto Nick Kurtz PSA 10",
        "2024 Bowman Draft Chrome Refractor Auto Nick Kurtz",
      ],
      [
        "case 19b",
        "2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10",
        "2025 Bowman Draft Chrome Green Refractor Auto Eli Willits",
      ],
    ];

    for (const [label, withGrade, expected] of cases) {
      it(`${label}: strips grade tokens cleanly`, () => {
        expect(stripGradingTokens(withGrade)).toBe(expected);
      });
    }
  });

  describe("issue #6 non-reproducing cases — full Tier-1 queries", () => {
    // Cases 11 and 16 already work today (no strict variant requirements
    // so AI degradation is harmless). Stripping must not regress them.
    it("case 11 (Aaron Judge 2017 Topps Chrome Catching RC PSA 10)", () => {
      expect(
        stripGradingTokens("2017 Topps Chrome Catching RC Aaron Judge PSA 10")
      ).toBe("2017 Topps Chrome Catching RC Aaron Judge");
    });
    it("case 16 (Ken Griffey Jr 1989 Upper Deck RC PSA 9)", () => {
      expect(stripGradingTokens("1989 Upper Deck RC Ken Griffey Jr PSA 9")).toBe(
        "1989 Upper Deck RC Ken Griffey Jr"
      );
    });
  });
});
