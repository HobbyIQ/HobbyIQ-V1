// CF-DAILYIQ-BOWMAN-2YR (2026-07-02) — pin the Bowman-scoped lists.
//
// Two new fields on MarketPlayersPayload:
//   - bowman2yrTopVolume30d: perPlayerTotal30d ∩ bowmanUniverse, top-20 DESC
//   - bowman2yrTopMomentum:  trending rows ∩ bowmanUniverse, top-20 DESC by
//                            medianRatio; trending-up only (≥ TREND_UP_FLOOR)
//
// Both membership checks are case-insensitive so parser output casing
// doesn't accidentally drop a real match.

import { describe, it, expect } from "vitest";
import {
  assembleMarketPlayersPayload,
  type MarketPlayersJobInput,
} from "../src/services/dailyiq/marketPlayers.service";
import type { PlayerMatchedCohortSummary } from "../src/services/playerTrend/playerTrend.types";

function cohort(medianRatio: number, cohortSize = 10): PlayerMatchedCohortSummary {
  return {
    medianRatio,
    meanRatio: medianRatio + 0.02,
    cohortSize,
    latestWeekActiveCards: cohortSize + 3,
    latestWeekStart: "2026-06-22",
    priorWindowWeeksCount: 4,
    computedAtMs: 1_700_000_000_000,
  };
}

describe("assembleMarketPlayersPayload — bowman2yrTopVolume30d", () => {
  it("filters perPlayerTotal30d to bowmanUniverse; ranks DESC by totalSales30d", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: [
        { player: "Ken Griffey Jr.", totalSales30d: 30_000 }, // not in Bowman universe
        { player: "Paul Skenes", totalSales30d: 15_000 },
        { player: "Josuar Gonzalez", totalSales30d: 8_000 },
        { player: "Aaron Judge", totalSales30d: 25_000 }, // not in Bowman universe
        { player: "Ethan Salas", totalSales30d: 5_000 },
      ],
      perPlayerVolumeRatio: [],
      bowmanUniverse: ["Paul Skenes", "Josuar Gonzalez", "Ethan Salas"],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopVolume30d.map((r) => r.player)).toEqual([
      "Paul Skenes",
      "Josuar Gonzalez",
      "Ethan Salas",
    ]);
    // Non-Bowman players excluded regardless of volume
    expect(p.bowman2yrTopVolume30d.find((r) => r.player === "Ken Griffey Jr.")).toBeUndefined();
    expect(p.bowman2yrTopVolume30d.find((r) => r.player === "Aaron Judge")).toBeUndefined();
  });

  it("case-insensitive membership check", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: [
        { player: "paul skenes", totalSales30d: 100 },
        { player: "JOSUAR GONZALEZ", totalSales30d: 50 },
      ],
      perPlayerVolumeRatio: [],
      bowmanUniverse: ["Paul Skenes", "Josuar Gonzalez"],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopVolume30d.map((r) => r.player)).toEqual(["paul skenes", "JOSUAR GONZALEZ"]);
  });

  it("empty bowmanUniverse → empty list (no accidental leak of non-Bowman rows)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: [
        { player: "Paul Skenes", totalSales30d: 100 },
        { player: "Josuar Gonzalez", totalSales30d: 50 },
      ],
      perPlayerVolumeRatio: [],
      bowmanUniverse: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopVolume30d).toEqual([]);
  });

  it("missing bowmanUniverse (undefined) → empty list (defensive when discovery fails)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: [{ player: "Paul Skenes", totalSales30d: 100 }],
      perPlayerVolumeRatio: [],
      // bowmanUniverse omitted entirely
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopVolume30d).toEqual([]);
  });

  it("respects topN cap on the Bowman list", () => {
    const players = Array.from({ length: 30 }, (_, i) => `Prospect ${i + 1}`);
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: players.map((p, i) => ({ player: p, totalSales30d: (30 - i) * 100 })),
      perPlayerVolumeRatio: [],
      bowmanUniverse: players,
      topN: 5,
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopVolume30d.length).toBe(5);
    expect(p.bowman2yrTopVolume30d[0].player).toBe("Prospect 1"); // highest volume
  });
});

describe("assembleMarketPlayersPayload — bowman2yrTopMomentum", () => {
  it("filters trending rows to bowmanUniverse; ranks DESC by medianRatio", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Paul Skenes", cohort: cohort(1.30) },
        { player: "Josuar Gonzalez", cohort: cohort(1.50) },
        { player: "Ethan Salas", cohort: cohort(1.10) },
        { player: "Ken Griffey Jr.", cohort: cohort(1.40) }, // not in Bowman universe
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
      bowmanUniverse: ["Paul Skenes", "Josuar Gonzalez", "Ethan Salas"],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopMomentum.map((r) => r.player)).toEqual([
      "Josuar Gonzalez",
      "Paul Skenes",
      "Ethan Salas",
    ]);
    // Griffey excluded despite qualifying momentum
    expect(p.bowman2yrTopMomentum.find((r) => r.player === "Ken Griffey Jr.")).toBeUndefined();
  });

  it("excludes non-trending (below TREND_UP_FLOOR 1.05) Bowman players", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Trending Up", cohort: cohort(1.10) },
        { player: "Just Above", cohort: cohort(1.06) },
        { player: "Flat", cohort: cohort(1.02) }, // below floor
        { player: "Fading", cohort: cohort(0.90) }, // below floor (down)
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
      bowmanUniverse: ["Trending Up", "Just Above", "Flat", "Fading"],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.bowman2yrTopMomentum.map((r) => r.player)).toEqual(["Trending Up", "Just Above"]);
  });

  it("empty bowmanUniverse → empty list", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [{ player: "Someone", cohort: cohort(1.30) }],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
      bowmanUniverse: [],
    };
    expect(assembleMarketPlayersPayload(input).bowman2yrTopMomentum).toEqual([]);
  });
});

describe("assembleMarketPlayersPayload — Bowman lists do not affect the existing lists", () => {
  it("bowmanUniverse presence does NOT filter trending / fading / topVolume30d", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Paul Skenes", cohort: cohort(1.30) },
        { player: "Ken Griffey Jr.", cohort: cohort(1.40) },
      ],
      perPlayerTotal30d: [
        { player: "Ken Griffey Jr.", totalSales30d: 30_000 },
        { player: "Paul Skenes", totalSales30d: 15_000 },
      ],
      perPlayerVolumeRatio: [],
      bowmanUniverse: ["Paul Skenes"], // only Skenes
    };
    const p = assembleMarketPlayersPayload(input);
    // Griffey stays in the ORIGINAL top-volume + trending (unfiltered)
    expect(p.topVolume30d.map((r) => r.player)).toEqual(["Ken Griffey Jr.", "Paul Skenes"]);
    expect(p.trending.map((r) => r.player)).toEqual(["Ken Griffey Jr.", "Paul Skenes"]);
    // But Bowman-scoped list is Skenes-only
    expect(p.bowman2yrTopVolume30d.map((r) => r.player)).toEqual(["Paul Skenes"]);
    expect(p.bowman2yrTopMomentum.map((r) => r.player)).toEqual(["Paul Skenes"]);
  });
});
