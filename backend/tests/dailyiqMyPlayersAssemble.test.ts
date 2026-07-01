/**
 * CF-DAILYIQ-MY-PLAYERS — pins the two pure helpers.
 *
 * summarizeUserHoldingsByPlayer: input = raw holding dict, output =
 * per-player summary with quantities.
 *
 * enrichOwnedCardsFromCohort: input = user's cardId → quantity map +
 * matched-cohort result, output = intersection with per-card ratios.
 */

import { describe, it, expect } from "vitest";
import {
  summarizeUserHoldingsByPlayer,
  enrichOwnedCardsFromCohort,
} from "../src/services/dailyiq/myPlayers.service";
import type { MatchedCohortResult } from "../src/services/playerTrend/matchedCohort.types";

function cohortResult(members: Array<{ cardId: string; ratio: number; latest?: number; prior?: number }>): MatchedCohortResult {
  return {
    latestWeekStart: "2026-06-22",
    latestWeekEnd: "2026-06-28",
    priorWindowWeeksCount: 4,
    cohort: members.map((m) => ({
      cardId: m.cardId,
      latestWeekMedianPrice: m.latest ?? 100,
      latestWeekSaleCount: 3,
      priorWindowMedianPrice: m.prior ?? 100,
      priorWindowSaleCount: 10,
      ratio: m.ratio,
    })),
    medianRatio: 0,
    meanRatio: 0,
    latestWeekActiveCards: members.length,
    totalCardsEvaluated: members.length,
    droppedNewOrLongTail: 0,
  };
}

describe("summarizeUserHoldingsByPlayer", () => {
  it("groups holdings by player with holdingCount + perCardQuantity", () => {
    const summaries = summarizeUserHoldingsByPlayer({
      "h1": { playerName: "Eric Hartman", cardId: "card-A", quantity: 1 },
      "h2": { playerName: "Eric Hartman", cardId: "card-A", quantity: 2 }, // same card
      "h3": { playerName: "Eric Hartman", cardId: "card-B", quantity: 1 },
      "h4": { playerName: "Ethan Conrad", cardId: "card-X", quantity: 1 },
    });
    expect(summaries).toHaveLength(2);
    // Sorted by holdingCount DESC — Hartman first (3 holdings)
    expect(summaries[0].player).toBe("Eric Hartman");
    expect(summaries[0].holdingCount).toBe(3);
    expect(summaries[0].perCardQuantity.get("card-A")).toBe(3); // 1 + 2
    expect(summaries[0].perCardQuantity.get("card-B")).toBe(1);
    expect(summaries[1].player).toBe("Ethan Conrad");
    expect(summaries[1].holdingCount).toBe(1);
  });

  it("normalizes player names case-insensitively but preserves display case", () => {
    const summaries = summarizeUserHoldingsByPlayer({
      "h1": { playerName: "Eric Hartman", cardId: "a" },
      "h2": { playerName: "eric hartman", cardId: "b" }, // lower
      "h3": { playerName: "  Eric Hartman  ", cardId: "c" }, // padded
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].holdingCount).toBe(3);
    // Display uses the FIRST-encountered form (Eric Hartman) — preserves user's typing
    expect(summaries[0].player).toBe("Eric Hartman");
  });

  it("skips holdings with missing/empty playerName", () => {
    const summaries = summarizeUserHoldingsByPlayer({
      "h1": { playerName: "Eric Hartman", cardId: "a" },
      "h2": { playerName: "", cardId: "b" }, // empty
      "h3": { cardId: "c" }, // undefined
      "h4": { playerName: null, cardId: "d" } as any,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].holdingCount).toBe(1);
  });

  it("defaults quantity to 1 when missing or non-positive", () => {
    const summaries = summarizeUserHoldingsByPlayer({
      "h1": { playerName: "Eric Hartman", cardId: "card-A" }, // no quantity
      "h2": { playerName: "Eric Hartman", cardId: "card-A", quantity: 0 },
      "h3": { playerName: "Eric Hartman", cardId: "card-A", quantity: -5 },
    });
    expect(summaries[0].perCardQuantity.get("card-A")).toBe(3);
  });

  it("empty holdings → empty output", () => {
    expect(summarizeUserHoldingsByPlayer({})).toEqual([]);
  });
});

describe("enrichOwnedCardsFromCohort", () => {
  it("intersects user's cards with cohort members and includes ratios", () => {
    const owned = new Map([
      ["card-A", 3],
      ["card-B", 1],
      ["card-C", 2],
    ]);
    const cohort = cohortResult([
      { cardId: "card-A", ratio: 1.35, latest: 135, prior: 100 },
      { cardId: "card-B", ratio: 0.95, latest: 95, prior: 100 },
      // card-C not in cohort
      // card-D user doesn't own
      { cardId: "card-D", ratio: 2.0, latest: 200, prior: 100 },
    ]);
    const out = enrichOwnedCardsFromCohort(owned, cohort);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.cardId)).toEqual(["card-A", "card-B"]); // sorted by ratio DESC
    expect(out[0].ratio).toBe(1.35);
    expect(out[0].quantity).toBe(3);
    expect(out[0].latestWeekMedianPrice).toBe(135);
    expect(out[1].ratio).toBe(0.95);
    expect(out[1].quantity).toBe(1);
  });

  it("returns empty array when cohort is null", () => {
    const owned = new Map([["card-A", 1]]);
    expect(enrichOwnedCardsFromCohort(owned, null)).toEqual([]);
  });

  it("returns empty array when user owns nothing", () => {
    const cohort = cohortResult([{ cardId: "card-A", ratio: 1.5 }]);
    expect(enrichOwnedCardsFromCohort(new Map(), cohort)).toEqual([]);
  });

  it("returns empty array when cohort has zero members (all cards new-to-market)", () => {
    const owned = new Map([["card-A", 1]]);
    const cohort = cohortResult([]);
    expect(enrichOwnedCardsFromCohort(owned, cohort)).toEqual([]);
  });

  it("returns empty array when none of user's cards intersect the cohort", () => {
    const owned = new Map([
      ["card-X", 1],
      ["card-Y", 2],
    ]);
    const cohort = cohortResult([
      { cardId: "card-A", ratio: 1.5 },
      { cardId: "card-B", ratio: 0.8 },
    ]);
    expect(enrichOwnedCardsFromCohort(owned, cohort)).toEqual([]);
  });

  it("sorts cohort by ratio DESC (user's best-trending owned card first)", () => {
    const owned = new Map([
      ["low", 1],
      ["mid", 1],
      ["high", 1],
    ]);
    const cohort = cohortResult([
      { cardId: "low", ratio: 0.7 },
      { cardId: "high", ratio: 1.9 },
      { cardId: "mid", ratio: 1.1 },
    ]);
    const out = enrichOwnedCardsFromCohort(owned, cohort);
    expect(out.map((o) => o.cardId)).toEqual(["high", "mid", "low"]);
  });
});
