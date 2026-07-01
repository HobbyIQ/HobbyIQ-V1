/**
 * CF-DAILYIQ-MARKET-PLAYERS — pins the pure assembly logic.
 *
 * The Redis I/O layer is thin pass-through; all the interesting
 * decisions (which players make each list, sort order, edge cases)
 * live in assembleMarketPlayersPayload.
 */

import { describe, it, expect } from "vitest";
import {
  assembleMarketPlayersPayload,
  type MarketPlayersJobInput,
} from "../src/services/dailyiq/marketPlayers.service";
import type { PlayerMatchedCohortSummary } from "../src/services/playerTrend/playerTrend.types";

function cohort(medianRatio: number, cohortSize: number = 10): PlayerMatchedCohortSummary {
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

describe("assembleMarketPlayersPayload — trending list", () => {
  it("sorts trending players by medianRatio DESC", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Alpha", cohort: cohort(1.10) },
        { player: "Beta", cohort: cohort(1.50) },
        { player: "Gamma", cohort: cohort(1.30) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.trending.map((r) => r.player)).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("excludes players whose ratio is below TREND_UP_FLOOR (1.05)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Just Flat", cohort: cohort(1.03) },
        { player: "Below Floor", cohort: cohort(1.04) },
        { player: "Above Floor", cohort: cohort(1.05) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.trending.map((r) => r.player)).toEqual(["Above Floor"]);
  });

  it("excludes players with cohortSize < 3", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "One Card", cohort: cohort(1.50, 1) },
        { player: "Two Cards", cohort: cohort(1.50, 2) },
        { player: "Three Cards", cohort: cohort(1.50, 3) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.trending.map((r) => r.player)).toEqual(["Three Cards"]);
  });

  it("respects topN cap", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: Array.from({ length: 30 }, (_, i) => ({
        player: `P${i}`,
        cohort: cohort(1.10 + i * 0.01),
      })),
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
      topN: 5,
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.trending).toHaveLength(5);
    expect(p.trending[0].player).toBe("P29"); // highest ratio
  });
});

describe("assembleMarketPlayersPayload — fading list", () => {
  it("sorts fading by medianRatio ASC (most-down first)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Slight Down", cohort: cohort(0.94) },
        { player: "Big Down", cohort: cohort(0.60) },
        { player: "Medium Down", cohort: cohort(0.80) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.fading.map((r) => r.player)).toEqual(["Big Down", "Medium Down", "Slight Down"]);
  });

  it("excludes players whose ratio is above TREND_DOWN_CEIL (0.95)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Just Flat", cohort: cohort(0.97) },
        { player: "Above Ceil", cohort: cohort(0.96) },
        { player: "At Ceil", cohort: cohort(0.95) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.fading.map((r) => r.player)).toEqual(["At Ceil"]);
  });
});

describe("assembleMarketPlayersPayload — topVolume30d", () => {
  it("sorts by totalSales30d DESC and excludes zeros", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [],
      perPlayerTotal30d: [
        { player: "High Volume", totalSales30d: 5000 },
        { player: "Zero", totalSales30d: 0 },
        { player: "Low Volume", totalSales30d: 100 },
        { player: "Medium Volume", totalSales30d: 500 },
      ],
      perPlayerVolumeRatio: [],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.topVolume30d.map((r) => r.player)).toEqual([
      "High Volume",
      "Medium Volume",
      "Low Volume",
    ]);
  });
});

describe("assembleMarketPlayersPayload — supplyDryLeadingUp", () => {
  it("classic supply_dry: matched-cohort UP + volume ratio DOWN", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Bull", cohort: cohort(1.35) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [
        { player: "Bull", volumeRatio: 0.6 }, // volume ↓
      ],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.supplyDryLeadingUp).toHaveLength(1);
    expect(p.supplyDryLeadingUp[0].player).toBe("Bull");
    expect(p.supplyDryLeadingUp[0].medianRatio).toBe(1.35);
    expect(p.supplyDryLeadingUp[0].volumeRatio).toBe(0.6);
  });

  it("excludes matched-cohort UP but volume also UP (demand growth, not supply dry)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Demand Growth", cohort: cohort(1.35) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [
        { player: "Demand Growth", volumeRatio: 1.5 }, // volume ↑ — different signal
      ],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.supplyDryLeadingUp).toHaveLength(0);
  });

  it("excludes matched-cohort DOWN + volume DOWN (demand crash, not supply dry)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Demand Crash", cohort: cohort(0.60) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [
        { player: "Demand Crash", volumeRatio: 0.6 },
      ],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.supplyDryLeadingUp).toHaveLength(0);
  });

  it("excludes when volume ratio is null (no signal)", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "No Volume Data", cohort: cohort(1.35) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [
        { player: "No Volume Data", volumeRatio: null },
      ],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.supplyDryLeadingUp).toHaveLength(0);
  });

  it("is case-insensitive when matching cohort → volumeRatio", () => {
    const input: MarketPlayersJobInput = {
      perPlayerCohorts: [
        { player: "Mixed Case Player", cohort: cohort(1.35) },
      ],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [
        { player: "mixed case player", volumeRatio: 0.6 },
      ],
    };
    const p = assembleMarketPlayersPayload(input);
    expect(p.supplyDryLeadingUp).toHaveLength(1);
  });
});

describe("assembleMarketPlayersPayload — generatedAt + empty inputs", () => {
  it("empty inputs → all lists empty, generatedAt set", () => {
    const p = assembleMarketPlayersPayload({
      perPlayerCohorts: [],
      perPlayerTotal30d: [],
      perPlayerVolumeRatio: [],
    });
    expect(p.trending).toHaveLength(0);
    expect(p.fading).toHaveLength(0);
    expect(p.topVolume30d).toHaveLength(0);
    expect(p.supplyDryLeadingUp).toHaveLength(0);
    expect(p.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
