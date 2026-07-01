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
