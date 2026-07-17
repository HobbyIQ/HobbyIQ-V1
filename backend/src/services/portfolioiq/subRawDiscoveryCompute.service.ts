// CF-SUB-RAW-DISCOVERY (Drew, 2026-07-17). Pure math + filter logic
// for the sub-raw prospect finder: raw cards trading well below their
// family's typical PSA 10 valuation.
//
// Value-hunter UX: "Raw under $30 where PSA 10 avg is >$300, family
// multiplier is high-confidence."
//
// The compute takes normalized inputs (raw comp aggregates + family
// multipliers) and applies gates. Cosmos I/O lives in a thin
// orchestration layer above this.

import type {
  SubRawCandidate,
  SubRawDiscoveryOptions,
} from "../../types/discovery.types.js";

/** Aggregate row for a specific SKU: median raw price + descriptor. */
export interface SkuRawAggregate {
  cardId: string;
  player: string;
  year: number;
  cardSet: string;
  cardSetType: string;
  variant: string;
  number: string;
  medianRawPrice: number;
  rawComps: number;
  imageUrl: string | null;
}

/** Family PSA 10 multiplier by family key. */
export interface FamilyMultipliersByKey {
  get(familyKey: string): {
    multiplier: number;
    confidence: "high" | "medium" | "low";
    nGraded: number;
  } | undefined;
}

const DEFAULTS: Required<SubRawDiscoveryOptions> = {
  maxRawPrice: 30,
  minExpectedGain: 200,
  minExpectedGainMultiple: 5.0,
  gradingCostAssumed: 80,
  minFamilyConfidence: "medium",
  topN: 25,
};

export function computeSubRawDiscovery(
  aggregates: SkuRawAggregate[],
  familyMultipliers: FamilyMultipliersByKey,
  slugFamily: (label: string) => string,
  opts: SubRawDiscoveryOptions = {},
): SubRawCandidate[] {
  const options = { ...DEFAULTS, ...opts };
  const {
    maxRawPrice,
    minExpectedGain,
    minExpectedGainMultiple,
    gradingCostAssumed,
    minFamilyConfidence,
    topN,
  } = options;

  const confidenceGate = confidenceRank(minFamilyConfidence);
  const candidates: SubRawCandidate[] = [];

  for (const a of aggregates) {
    if (!Number.isFinite(a.medianRawPrice) || a.medianRawPrice <= 0) continue;
    if (a.medianRawPrice > maxRawPrice) continue;
    const familyKey = slugFamily(a.cardSetType || a.cardSet);
    if (!familyKey) continue;
    const fm = familyMultipliers.get(familyKey);
    if (!fm) continue;
    if (confidenceRank(fm.confidence) < confidenceGate) continue;

    const expectedPsa10Price = a.medianRawPrice * fm.multiplier;
    const expectedGain = expectedPsa10Price - a.medianRawPrice - gradingCostAssumed;
    if (expectedGain < minExpectedGain) continue;
    const expectedGainMultiple = expectedGain / a.medianRawPrice;
    if (expectedGainMultiple < minExpectedGainMultiple) continue;

    candidates.push({
      cardId: a.cardId,
      player: a.player,
      year: a.year,
      cardSet: a.cardSet,
      variant: a.variant,
      number: a.number,
      medianRawPrice: round(a.medianRawPrice, 2),
      familyKey,
      familyPsa10Multiplier: fm.multiplier,
      familyPsa10Confidence: fm.confidence,
      expectedPsa10Price: round(expectedPsa10Price, 2),
      gradingCostAssumed,
      expectedGain: round(expectedGain, 2),
      expectedGainMultiple: round(expectedGainMultiple, 2),
      rawComps: a.rawComps,
      imageUrl: a.imageUrl,
    });
  }

  return candidates
    .sort((a, b) => b.expectedGain - a.expectedGain)
    .slice(0, topN);
}

function confidenceRank(conf: "high" | "medium" | "low" | "any"): number {
  switch (conf) {
    case "high":    return 3;
    case "medium":  return 2;
    case "low":     return 1;
    case "any":     return 0;
  }
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

export const _DEFAULTS = DEFAULTS;
