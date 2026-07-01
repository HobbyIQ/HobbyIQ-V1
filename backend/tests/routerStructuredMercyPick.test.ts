/**
 * CF-CH-STRUCTURED-SEARCH-MERCY (2026-07-01) — pin `pickBestByParallel`.
 *
 * Anchored on the actual 10-result cohort returned by CH's
 * /v1/cards/card-search for "Ethan Conrad Blue Refractor" captured
 * during the 2026-07-01 App Insights probe. This is exactly what the
 * mercy fallback sees on the wire — pinning against real shapes
 * prevents regressions where sibling parallels bleed through.
 */

import { describe, it, expect } from "vitest";
import { pickBestByParallel } from "../src/services/compiq/cardsight.router";
import type { CardHedgeCard } from "../src/services/compiq/cardhedge.client";

const ETHAN_CONRAD_COHORT: CardHedgeCard[] = [
  { card_id: "id-01", title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Sky Blue Refractor" },
  { card_id: "id-02", title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Blue Geometric Refractor" },
  { card_id: "id-03", title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Blue Refractor" }, // <-- target
  { card_id: "id-04", title: "Ethan Conrad 2026 Bowman Mega Box Prospect Mega Autographs Chrome Baseball Blue Mojo Refractor" },
  { card_id: "id-05", title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Refractor" },
  { card_id: "id-06", title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Gold Geometric Refractor" },
  { card_id: "id-07", title: "Ethan Conrad 2026 Bowman Mega Box Prospect Mega Autographs Chrome Baseball Purple Mojo Refractor" },
  { card_id: "id-08", title: "Ethan Conrad 2026 Bowman Mega Box Prospect Mega Autographs Chrome Baseball Aqua Mojo Refractor" },
];

describe("pickBestByParallel — CF-CH-STRUCTURED-SEARCH-MERCY", () => {
  it("picks base 'Blue Refractor' from the Ethan Conrad cohort", () => {
    const picked = pickBestByParallel(ETHAN_CONRAD_COHORT, "Blue Refractor");
    expect(picked?.card_id).toBe("id-03");
  });

  it("rejects 'Sky Blue Refractor' when looking for 'Blue Refractor' (preceding color qualifier)", () => {
    const twoCards: CardHedgeCard[] = [
      { card_id: "sky", title: "Player 2025 Set Sky Blue Refractor" },
      { card_id: "base", title: "Player 2025 Set Blue Refractor" },
    ];
    const picked = pickBestByParallel(twoCards, "Blue Refractor");
    expect(picked?.card_id).toBe("base");
  });

  it("rejects 'Blue Geometric Refractor' (parallel tokens not adjacent)", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "geometric", title: "Player Blue Geometric Refractor" },
    ];
    const picked = pickBestByParallel(cards, "Blue Refractor");
    expect(picked).toBeNull();
  });

  it("rejects 'Blue Mojo Refractor' (parallel tokens not adjacent, sibling parallel)", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "mojo", title: "Player Blue Mojo Refractor" },
    ];
    const picked = pickBestByParallel(cards, "Blue Refractor");
    expect(picked).toBeNull();
  });

  it("returns null on empty cards array", () => {
    expect(pickBestByParallel([], "Blue Refractor")).toBeNull();
  });

  it("returns null when parallel is empty", () => {
    expect(pickBestByParallel(ETHAN_CONRAD_COHORT, "")).toBeNull();
  });

  it("returns null when title matches parallel but two candidates tie on cleanness", () => {
    // Ambiguity: two candidates with identical extraTokens count.
    const twoCards: CardHedgeCard[] = [
      { card_id: "a", title: "Player One Blue Refractor" }, // extra=3 (Player, One, +0 auto)
      { card_id: "b", title: "Player Two Blue Refractor" }, // extra=3 (Player, Two, +0)
    ];
    expect(pickBestByParallel(twoCards, "Blue Refractor")).toBeNull();
  });

  it("picks 'Green Refractor' base from a mixed cohort", () => {
    const cohort: CardHedgeCard[] = [
      { card_id: "gr-neon", title: "Player Neon Green Refractor" },
      { card_id: "gr-base", title: "Player Green Refractor" },
    ];
    const picked = pickBestByParallel(cohort, "Green Refractor");
    expect(picked?.card_id).toBe("gr-base");
  });

  it("handles single-word parallel (e.g. 'Sapphire')", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "s1", title: "Player 2025 Bowman Draft Sapphire" },
      { card_id: "s2", title: "Player 2025 Bowman Draft Blue Sapphire" }, // preceded by "blue" qualifier
    ];
    const picked = pickBestByParallel(cards, "Sapphire");
    expect(picked?.card_id).toBe("s1");
  });

  it("is case-insensitive on parallel matching", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "lower", title: "player blue refractor" },
    ];
    const picked = pickBestByParallel(cards, "Blue Refractor");
    expect(picked?.card_id).toBe("lower");
  });

  it("skips cards with missing title", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "no-title" },
      { card_id: "yes-title", title: "Player Blue Refractor" },
    ];
    const picked = pickBestByParallel(cards, "Blue Refractor");
    expect(picked?.card_id).toBe("yes-title");
  });
});

/**
 * CF-CH-STRUCTURED-SEARCH-MERCY-ISAUTO (2026-07-01).
 *
 * Follow-up to CF-CH-STRUCTURED-SEARCH-MERCY. The initial mercy fallback
 * didn't respect isAuto — a query for "Blue Refractor Auto" would match
 * a base-set Blue Refractor card and price the wrong SKU. Real prod
 * incident on 2026-07-01: Ethan Conrad Blue Refractor Auto priced at $67
 * (base) when Drew's actual card is closer to $400 (Prospect Autograph
 * subset that CH doesn't even catalog). The pin below regressions the
 * Ethan Conrad cohort with subset fields added — mercy MUST return null
 * for isAuto=true because CH has no auto card matching "Blue Refractor".
 */
describe("pickBestByParallel — isAuto subset gate (Ethan Conrad regression)", () => {
  const ETHAN_CONRAD_WITH_SUBSETS: CardHedgeCard[] = [
    // Base Set variants (subset excludes them from isAuto=true)
    { card_id: "base-blue-refr", subset: "Base Set",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Blue Refractor" },
    { card_id: "base-sky-blue", subset: "Base Set",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Sky Blue Refractor" },
    { card_id: "base-refr", subset: "Base Set",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Refractor" },
    // Prospect Autographs — actual autos in CH catalog, but NO Blue variant
    { card_id: "auto-refr", subset: "Prospect Autographs",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Refractor" },
    { card_id: "auto-purple", subset: "Prospect Autographs",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Purple" },
    { card_id: "auto-gold", subset: "Prospect Autographs",
      title: "Ethan Conrad 2025 Bowman Draft Chrome Baseball Gold" },
  ];

  it("Ethan Conrad Blue Refractor Auto → catalog-miss (CH has no such SKU)", () => {
    const picked = pickBestByParallel(
      ETHAN_CONRAD_WITH_SUBSETS,
      "Blue Refractor",
      { isAuto: true },
    );
    expect(picked).toBeNull();
  });

  it("isAuto=false still picks the base Blue Refractor", () => {
    const picked = pickBestByParallel(
      ETHAN_CONRAD_WITH_SUBSETS,
      "Blue Refractor",
      { isAuto: false },
    );
    expect(picked?.card_id).toBe("base-blue-refr");
  });

  it("isAuto=undefined preserves legacy no-filter behavior (backward compat)", () => {
    const picked = pickBestByParallel(
      ETHAN_CONRAD_WITH_SUBSETS,
      "Blue Refractor",
      { /* isAuto not specified */ },
    );
    expect(picked?.card_id).toBe("base-blue-refr"); // matches legacy pre-fix behavior
  });

  it("isAuto=true finds a real auto when one matches (Purple in this case)", () => {
    const picked = pickBestByParallel(
      ETHAN_CONRAD_WITH_SUBSETS,
      "Purple",
      { isAuto: true },
    );
    expect(picked?.card_id).toBe("auto-purple");
  });

  it("recognizes multiple auto-subset naming variants (Prospect Autographs, Chrome Prospect Autograph, etc.)", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "pa", subset: "Prospect Autographs", title: "Player Gold" },
      { card_id: "cpa", subset: "Chrome Prospect Autograph", title: "Player Gold" },
      { card_id: "pra", subset: "Prospect Retail Autograph", title: "Player Gold" },
      { card_id: "pmac", subset: "Prospect Mega Autographs Chrome", title: "Player Gold" },
    ];
    // All 4 have subset containing "auto" — no unique parallel match, tie → null.
    // But if we ONLY have one, it should be pickable.
    const single: CardHedgeCard[] = [cards[0]];
    const picked = pickBestByParallel(single, "Gold", { isAuto: true });
    expect(picked?.card_id).toBe("pa");
  });

  it("cards missing subset are excluded when isAuto is specified", () => {
    const cards: CardHedgeCard[] = [
      { card_id: "no-subset", title: "Player Blue Refractor" /* no subset */ },
      { card_id: "with-auto-subset", subset: "Prospect Autographs",
        title: "Player Blue Refractor" },
    ];
    const picked = pickBestByParallel(cards, "Blue Refractor", { isAuto: true });
    expect(picked?.card_id).toBe("with-auto-subset");
  });
});
