// CF-SLUG-REGRESSION-2026-08-01 (Drew, 2026-08-01). Pinned tests for
// every bug we hit during the 2026-07-30/08-01 pool-cleanup sprint.
// These MUST stay green — any future change that breaks them is a
// regression on ground truth Drew has already verified.

import { describe, it, expect } from "vitest";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// Helper: extract parallel segment (position 5) from a computed slug
function parallelOf(parallel: string): string {
  const slug = computeHobbyIqCardId({
    sport: "baseball", year: 2026, setKey: "bowman-chrome",
    cardNumber: "1", parallel, isAuto: false, printRun: null,
  });
  return slug.split(":")[5];
}
import { preIngestClean } from "../src/services/portfolioiq/preIngestClean.service.js";
import { extractGradeFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import type { RecordSoldCompInput } from "../src/services/portfolioiq/soldCompsStore.service.js";

describe("Chrome subset collapse (Drew's rule: buyers don't distinguish subset)", () => {
  // SUPERSEDED by CF-DRAFT-IS-ITS-OWN-PRODUCT (Drew, 2026-08-16: "it shuld
  // fold into Draft since it is draft"). The subset-collapse rule below still
  // holds for Topps Chrome Update; it does NOT hold for Draft, which is a
  // separate product with a separate checklist — bowman-draft carries 277,616
  // checklist-backed catalog rows against bowman-draft-chrome's ZERO.
  it("Bowman Chrome Draft resolves to bowman-draft (its own product)", () => {
    expect(normalizeSetKey("2025 Bowman Draft Chrome Baseball")).toBe("bowman-draft");
    expect(normalizeSetKey("2025 Bowman Chrome Draft Baseball")).toBe("bowman-draft");
  });
  it("Topps Chrome Update collapses to topps-chrome", () => {
    expect(normalizeSetKey("2020 Topps Chrome Update Baseball")).toBe("topps-chrome");
    // Bare "Chrome Update" without Topps prefix — no match (safer than mis-classify)
    expect(normalizeSetKey("2018 Topps Chrome Update")).toBe("topps-chrome");
  });
  it("Sapphire is a distinct product — NOT collapsed", () => {
    expect(normalizeSetKey("2023 Bowman Chrome Sapphire Baseball")).toBe("bowman-chrome-sapphire");
    expect(normalizeSetKey("2022 Topps Chrome Sapphire Baseball")).toBe("topps-chrome-sapphire");
  });
  it("Topps Chrome Platinum is distinct — NOT collapsed", () => {
    expect(normalizeSetKey("2023 Topps Chrome Platinum Baseball")).toBe("topps-chrome-platinum");
  });
});

describe("Slug determinism (idempotent regeneration)", () => {
  it("same inputs → same slug, twice", () => {
    const c = {
      sport: "baseball",
      year: 2025,
      setKey: "2025 Bowman Chrome Draft Baseball",
      cardNumber: "CPA-JHA",
      parallel: "Blue Refractor",
      isAuto: true,
      printRun: 150,
    };
    const a = computeHobbyIqCardId(c);
    const b = computeHobbyIqCardId(c);
    // Determinism is the point of this test and is unaffected by the Draft
    // taxonomy change; only the expected product segment moved.
    expect(a).toBe(b);
    expect(a).toBe("hiq:baseball:2025:bowman-draft:cpa-jha:blue-refractor:auto:num-150");
  });
});

describe("preIngestClean — Cardsight fuzzy-match rejection", () => {
  // Regression: Hartman Blue Refractor $6 sub-pool contamination.
  // Cardsight fuzzy-matched sales of completely different cards to
  // CPA-EHA queries. Those rows must be REJECTED before they reach
  // sold_comps.
  it("rejects a Cardsight row whose title mentions neither player nor cardNumber", () => {
    const input: RecordSoldCompInput = {
      cardId: "cs-xxx",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "2026 Bowman Chrome Baseball",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 6.00,
      soldAt: "2026-07-15T00:00:00Z",
      source: "cardsight",
      sourceExternalId: "cs-xxx",
      contributorUserId: null,
      title: "2025 Topps Chrome Baseball Random Base #123",
    };
    const result = preIngestClean(input);
    expect(result.rejected?.category).toBe("fuzzy-match");
    expect(result.rejected?.reason).toContain("hartman");
  });

  it("ACCEPTS a Cardsight row whose title mentions the player", () => {
    const input: RecordSoldCompInput = {
      cardId: "cs-yyy",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "2026 Bowman",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 1500,
      soldAt: "2026-07-15T00:00:00Z",
      source: "cardsight",
      sourceExternalId: "cs-yyy",
      contributorUserId: null,
      title: "2026 Bowman Chrome Eric Hartman Blue Refractor Auto /150",
    };
    const result = preIngestClean(input);
    expect(result.rejected).toBeUndefined();
    expect(result.input?.parallel).toBe("Blue Refractor");
  });

  it("ACCEPTS a Cardsight row whose title has the cardNumber", () => {
    const input: RecordSoldCompInput = {
      cardId: "cs-zzz",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "2026 Bowman",
      parallel: "Base",
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 1900,
      soldAt: "2026-07-15T00:00:00Z",
      source: "cardsight",
      sourceExternalId: "cs-zzz",
      contributorUserId: null,
      title: "#CPA-EHA Blue Refractor Chrome 1st Auto /150",
    };
    const result = preIngestClean(input);
    expect(result.rejected).toBeUndefined();
  });
});

describe("preIngestClean — Manual entry parallel required", () => {
  // Regression: 2026-08-01 Hartman $1,526 sale — script silently
  // defaulted parallel="Base" when caller didn't pass one, producing
  // a Base slug for a real Blue Refractor sale.
  it("rejects manual entry with no parallel", () => {
    const input: RecordSoldCompInput = {
      cardId: "abc",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: null,
      parallel: null,
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 1526,
      soldAt: "2026-07-19T00:00:00Z",
      source: "manual-user-entry",
      sourceExternalId: "test-1",
      contributorUserId: "user-drew",
      title: "eBay auction I watched",
    };
    const result = preIngestClean(input);
    expect(result.rejected?.category).toBe("invalid");
    expect(result.rejected?.reason).toMatch(/parallel required/i);
  });

  it("rejects manual entry with future soldAt", () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const input: RecordSoldCompInput = {
      cardId: "abc",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: null,
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 1500,
      soldAt: future,
      source: "manual-user-entry",
      sourceExternalId: "test-2",
      contributorUserId: "user-drew",
    };
    const result = preIngestClean(input);
    expect(result.rejected?.reason).toMatch(/future/i);
  });

  it("ACCEPTS manual entry with explicit parallel", () => {
    const input: RecordSoldCompInput = {
      cardId: "abc",
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: null,
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
      price: 1526,
      soldAt: "2026-07-19T00:00:00Z",
      source: "manual-user-entry",
      sourceExternalId: "test-3",
      contributorUserId: "user-drew",
      verifiedByUser: true,
    };
    const result = preIngestClean(input);
    expect(result.rejected).toBeUndefined();
    expect(result.input?.parallel).toBe("Blue Refractor");
  });
});

describe("Grade extraction from title", () => {
  // Regression: 2026-08-01 Cardsight rows for "2024 Bowman Chrome Shohei
  // Ohtani #85 PSA 9 Mint" ingested with gradeCompany=null (Raw).
  it("PSA 9", () => {
    expect(extractGradeFromTitle("2024 Bowman Chrome Shohei Ohtani #85 PSA 9 Mint")).toEqual({ gradeCompany: "PSA", gradeValue: 9 });
  });
  it("PSA 10 GEM MINT", () => {
    expect(extractGradeFromTitle("2024 Bowman MEGA BOX Chrome #33 SHOHEI OHTANI PSA 10 GEM MINT 1st Year")).toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
  it("BGS 9.5", () => {
    expect(extractGradeFromTitle("Some 2020 Card BGS 9.5 slabbed")).toEqual({ gradeCompany: "BGS", gradeValue: 9.5 });
  });
  it("SGC 10", () => {
    expect(extractGradeFromTitle("Card SGC 10 mint")).toEqual({ gradeCompany: "SGC", gradeValue: 10 });
  });
  it("Raw card returns null", () => {
    expect(extractGradeFromTitle("2020 Bowman Chrome Refractor Auto /499")).toEqual({ gradeCompany: null, gradeValue: null });
  });
});

describe("Bowman Mega Box is its OWN product (supersedes the 2026-08-01 collapse)", () => {
  // The 2026-08-01 rule collapsed Mega Box into bowman-chrome: "same physical
  // Chrome insert set, just retail-exclusive distribution, buyers don't
  // distinguish". That held only while Mega Box was the ONLY source of 2026
  // Bowman Chrome cards.
  //
  // Standalone 2026 Bowman Chrome released 2026-08-12 with its own 100-card
  // base checklist, and the numbering collides head-on:
  //     Mega Box      #52 = Shohei Ohtani      #9 = Munetaka Murakami
  //     Bowman Chrome #52 = JJ Wetherholt RC   #9 = Cody Bellinger
  // The collapse put 695 Mega Box comps on Bowman Chrome base cards, so
  // Ohtani's sales were valuing Wetherholt's rookie. Drew, 2026-08-12:
  // "Mega box is different from 2026 bowman and 2026 bowman is a different
  // product" / "fix the rule".
  it("Bowman Mega Box maps to its own key, NOT bowman-chrome", () => {
    expect(normalizeSetKey("2026 Bowman Mega Box Baseball")).toBe("bowman-chrome-mega-box");
    expect(normalizeSetKey("2024 Bowman Mega Box Chrome")).toBe("bowman-chrome-mega-box");
  });

  it("does not collide with standalone Bowman Chrome", () => {
    // The whole point: these two must never resolve to the same pool again.
    expect(normalizeSetKey("2026 Bowman Chrome Baseball")).toBe("bowman-chrome");
    expect(normalizeSetKey("2026 Bowman Mega Box Baseball"))
      .not.toBe(normalizeSetKey("2026 Bowman Chrome Baseball"));
  });

  it("matches the name parseTitleIdentity already canonicalizes to", () => {
    // parseTitleIdentity maps "Bowman Mega Box" -> "Bowman Chrome Mega Box";
    // the setKey must agree or titles and slugs disagree about the product.
    expect(normalizeSetKey("Bowman Chrome Mega Box")).toBe("bowman-chrome-mega-box");
  });

  it("still beats the generic /^bowman/ collapse", () => {
    // If the bare Bowman rule won, Mega Box would land in the paper flagship
    // pool — the failure the original 2026-08-01 rule was written to prevent.
    expect(normalizeSetKey("2026 Bowman Mega Box Baseball")).not.toBe("bowman");
  });

  it("Plain Bowman still maps to bowman (paper flagship)", () => {
    expect(normalizeSetKey("2024 Bowman Baseball")).toBe("bowman");
  });
});

describe("Mojo parallels — colors preserved, Refractor implied", () => {
  // Drew's note 2026-08-01: "Mojos have colors too". Blue Mojo /50,
  // Green Mojo /99, Red Mojo /25 are common Mega Box parallels.
  // Slug must preserve the color AND treat Mojo as implying Refractor.
  it("Bare 'Mojo' → mojo-refractor", () => {
    expect(parallelOf("Mojo")).toBe("mojo-refractor");
  });
  it("'Mojo Refractor' → mojo-refractor (unchanged)", () => {
    expect(parallelOf("Mojo Refractor")).toBe("mojo-refractor");
  });
  it("'Mega Refractor' alias → mojo-refractor", () => {
    expect(parallelOf("Mega Refractor")).toBe("mojo-refractor");
  });
  it("'Blue Mojo' → blue-mojo-refractor", () => {
    expect(parallelOf("Blue Mojo")).toBe("blue-mojo-refractor");
  });
  it("'Blue Mojo Refractor' → blue-mojo-refractor", () => {
    expect(parallelOf("Blue Mojo Refractor")).toBe("blue-mojo-refractor");
  });
  it("'Green Mojo' → green-mojo-refractor", () => {
    expect(parallelOf("Green Mojo")).toBe("green-mojo-refractor");
  });
  it("'Red Mega Refractor' → red-mojo-refractor (color + mega/mojo alias)", () => {
    expect(parallelOf("Red Mega Refractor")).toBe("red-mojo-refractor");
  });
  it("Bare 'Mega' → mojo-refractor (mega + mojo are same card language)", () => {
    expect(parallelOf("Mega")).toBe("mojo-refractor");
  });
  it("'Blue Mega' → blue-mojo-refractor", () => {
    expect(parallelOf("Blue Mega")).toBe("blue-mojo-refractor");
  });
  it("'Gold Mega' → gold-mojo-refractor", () => {
    expect(parallelOf("Gold Mega")).toBe("gold-mojo-refractor");
  });
});

describe("Chrome-prefix cardNumber override (removed — too broad)", () => {
  // Regression: 2026-07-31 blanket override of set-slug based on
  // CPA/FCA/TC prefix misclassified 184 rows (Donruss Champions,
  // Topps Chrome Platinum, Topps Finest → wrong bowman-chrome).
  // Verify that a CPA-XX cardNumber does NOT auto-force bowman-chrome
  // when the source setKey clearly says a different product.
  it("Topps Chrome Platinum CPA-XX stays at topps-chrome-platinum", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2023,
      setKey: "2023 Topps Chrome Platinum Baseball",
      cardNumber: "CPA-GS",
      parallel: "Base",
      isAuto: true,
      printRun: null,
    });
    expect(slug).toBe("hiq:baseball:2023:topps-chrome-platinum:cpa-gs:base:auto");
  });

  it("Donruss Champions currently maps to panini-donruss (parent brand)", () => {
    // Not ideal — Donruss Champions is a distinct 2003-era product line —
    // but current production behavior lumps it under panini-donruss.
    // Pinning current behavior; upgrade to donruss-champions requires
    // a normalizeSetKey pattern addition + backfill.
    expect(normalizeSetKey("2003 Donruss Champions Baseball")).toBe("panini-donruss");
  });
});
