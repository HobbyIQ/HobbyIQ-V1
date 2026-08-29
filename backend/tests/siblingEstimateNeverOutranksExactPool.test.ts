// D4 PR 5 (2026-08-29) — the sibling estimate seam obeys the doctrine.
//
// The fixture is real: holding ca7a150b, 2026 Bowman Chrome CPA-MG Marconi
// German Gold Refractor /50 auto, raw, purchase $187.49. Exact pool under
// its slug: $182.50 (08-18), $187.49 (08-18), $102.50 (06-17). Persisted:
// fairMarketValue 1109.44, isEstimate true, estimateBasis "sibling: … ×
// 8.00× parallel (floor lifted from 1.00×)", pricingSource "unified-
// pricing", pricingSourceMeta { method: "cross-setkey", compsUsed: 3 }.
// The holding's cardId was the WRONG identity (…:cpa-mg:refractor:auto)
// while hobbyiqCardId was the right one (…:cpa-mg:gold-refractor:auto).
//
// Doctrine pinned here: exact-pool supremacy (a fallback rung never
// outranks an exact pool with >= 1 sale), empirical-only multipliers (no
// measurement, no price), cross-setkey stays inside the product family
// and the player, and labels tell the truth.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterCrossSetKeyComps,
  foldPlayerName,
  majorityPlayerFold,
  describeCrossSetKeyPool,
} from "../src/services/portfolioiq/crossSetKeyRule.js";
import { productFamilyKey, sameProductFamily } from "../src/services/portfolioiq/productFamily.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, rel), "utf8");

// ─── The fixture's identities ────────────────────────────────────────────────
const GOLD = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto";
const GOLD_50 = `${GOLD}:num-50`;

const MARCONI_TARGET = {
  sport: "baseball",
  year: 2026,
  setKey: "bowman-chrome",
  cardNumber: "cpa-mg",
  isAuto: true,
  parallel: "gold-refractor",
  printRun: 50,
  playerFold: foldPlayerName("Marconi German,"),
};

const sale = (over: Record<string, unknown>) => ({
  price: 150,
  soldAt: "2026-08-18T00:00:00.000Z",
  source: "tca-ebay",
  parallel: "Gold Refractor",
  playerName: "Marconi German",
  ...over,
});

// ─── Cross-setkey stays inside the family and the player ────────────────────
describe("productFamilyKey / sameProductFamily — the ladder the matcher honours", () => {
  it.each([
    ["bowman-chrome-prospects", "bowman-chrome", true],
    ["bowman-chrome-updates", "bowman-chrome", true],
    ["bowman-chrome-mega-box", "bowman-chrome-prospects", true],
    ["topps-chrome-update", "topps-chrome", true],
    ["bowman-draft-chrome", "bowman-draft", true],
    // Drew's rulings: paper is not Chrome, flagship is not Chrome.
    ["bowman", "bowman-chrome", false],
    ["topps", "topps-chrome", false],
    ["bowman", "bowman-draft", false],
    // Sapphire is its own checklist and never crosses.
    ["bowman-chrome-sapphire", "bowman-chrome", false],
    ["bowman-draft-sapphire", "bowman-draft", false],
    ["topps-chrome-sapphire", "topps-chrome", false],
    ["bowman-sterling", "bowman-chrome", false],
    ["panini-prizm", "panini-select", false],
  ])("%s ↔ %s → %s", (a, b, expected) => {
    expect(sameProductFamily(a, b)).toBe(expected);
    expect(sameProductFamily(b, a)).toBe(expected);
  });

  it("an empty key is in no family", () => {
    expect(productFamilyKey("")).toBe("");
    expect(sameProductFamily("", "")).toBe(false);
  });
});

describe("foldPlayerName — the player equality the rung uses", () => {
  it("drops the eBay import's trailing comma, case, diacritics and a generational suffix", () => {
    expect(foldPlayerName("Marconi German,")).toBe("marconi german");
    expect(foldPlayerName("MARCONI GERMAN")).toBe("marconi german");
    expect(foldPlayerName("José Ramírez Jr.")).toBe("jose ramirez");
    expect(foldPlayerName("Ken Griffey Jr")).toBe("ken griffey");
  });
  it("is empty for nothing", () => {
    expect(foldPlayerName(null)).toBe("");
    expect(foldPlayerName("   ")).toBe("");
  });
  it("majorityPlayerFold learns the player from the exact slug's own pool", () => {
    expect(majorityPlayerFold([
      sale({ playerName: "Marconi German" }),
      sale({ playerName: "Marconi German," }),
      sale({ playerName: "Some Other Guy" }),
      sale({ playerName: null }),
    ])).toBe("marconi german");
    expect(majorityPlayerFold([sale({ playerName: null })])).toBeNull();
  });
});

describe("filterCrossSetKeyComps — a comp crosses a setKey only inside the family, for the same player, at a print run that does not contradict", () => {
  it("keeps the same card under a sibling spelling of the product; refuses another player's CPA-MG and a bowman paper /75", () => {
    const rows = [
      // The rescue this rung exists for: one physical card, two spellings.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", playerName: "Marconi German," }),
      // Same family, un-numbered twin — unknown print run does not contradict /50.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto", printRun: null }),
      // Another player's CPA-MG in the same family: the initials collide.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", playerName: "Mateo Gil" }),
      // Bowman paper /75: a different card at a different price.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-75", printRun: 75 }),
      // Sapphire: its own checklist.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-sapphire:cpa-mg:gold-refractor:auto:num-50" }),
      // Same family, same player, but /25 contradicts /50.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-25", printRun: 25 }),
      // Same family, same player, wrong parallel slug.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:refractor:auto", parallel: "Refractor" }),
      // No slug at all: cannot be judged.
      sale({ hobbyiqCardId: undefined }),
      // Same family, same player, different year in the slug.
      sale({ hobbyiqCardId: "hiq:baseball:2025:bowman-chrome:cpa-mg:gold-refractor:auto:num-50" }),
    ];
    const v = filterCrossSetKeyComps(MARCONI_TARGET, rows);
    expect(v.refused).toBeNull();
    expect(v.kept.map((r) => r.hobbyiqCardId)).toEqual([
      "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50",
      "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto",
    ]);
    expect(v.excluded).toEqual({
      noSlug: 1,
      otherIdentity: 1,
      otherFamily: 2,
      otherParallel: 1,
      otherPrintRun: 1,
      otherPlayer: 1,
    });
  });

  it("refuses the whole rung when the target's player is unknown — a cross-product comp cannot be verified", () => {
    const v = filterCrossSetKeyComps({ ...MARCONI_TARGET, playerFold: null }, [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
    ]);
    expect(v.refused).toBe("no-player");
    expect(v.kept).toEqual([]);
  });

  it("the basis note names the comps, the family, the player and what was turned away", () => {
    const rows = [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-updates:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-75", printRun: 75 }),
    ];
    const v = filterCrossSetKeyComps(MARCONI_TARGET, rows);
    const note = describeCrossSetKeyPool(MARCONI_TARGET, v.kept, v.excluded);
    expect(note).toBe(
      "Estimated from 3 sales of this exact card within the bowman-chrome family (bowman-chrome-prospects ×2, bowman-chrome-updates ×1; player marconi german); excluded 1 other-family",
    );
  });

  it("a target with no print run accepts comps at any print run (the un-numbered slug is the fixture's own shape)", () => {
    const v = filterCrossSetKeyComps({ ...MARCONI_TARGET, printRun: null }, [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", printRun: 50 }),
    ]);
    expect(v.kept).toHaveLength(1);
  });
});

describe("hobbyIqFmv — the rung reads the rule (source pin)", () => {
  const src = read("../src/services/portfolioiq/hobbyIqFmv.service.ts");
  it("the cross-setkey rung filters through filterCrossSetKeyComps and describes its pool", () => {
    expect(src).toMatch(/const verdict = filterCrossSetKeyComps\(crossTarget, parallelMatched\);/);
    expect(src).toMatch(/buildResult\(slug, graded, "cross-setkey",\s*describeCrossSetKeyPool\(/);
    expect(src).toMatch(/const targetPlayerFold = foldPlayerName\(input\.playerName\) \|\| majorityPlayerFold\(exactSlugRowsAnyGrade\);/);
  });
  it("the input carries the caller's player and priceFromOurPool passes the holding's", () => {
    expect(src).toMatch(/playerName\?: string \| null;/);
    const ourPool = read("../src/services/portfolioiq/priceFromOurPool.service.ts");
    expect(ourPool).toMatch(/playerName: typeof holding\.playerName === "string" \? holding\.playerName : null,/);
  });
});

export { GOLD, GOLD_50 };
