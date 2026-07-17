// CF-OBSERVED-MULTIPLIERS (Drew, 2026-07-17). Pure math for the
// per-family observed grader multipliers. Groups sales by (family,
// grader_tier), medians each bucket, emits (graded / raw) ratio per
// tier per family. No IO.

import type {
  FamilySale,
  FamilyMultiplierRow,
  ObservedMultipliersOptions,
  ObservedMultipliersResult,
} from "../../types/observedMultipliers.types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIERS = [
  "PSA 10", "PSA 9.5", "PSA 9",
  "BGS 10", "BGS 9.5", "BGS 9",
  "SGC 10", "SGC 9.5", "SGC 9",
  "CGC 10", "CGC 9.5", "CGC 9",
];

const DEFAULTS: Required<ObservedMultipliersOptions> = {
  windowDays: 90,
  minRawSamples: 20,
  minGradedSamples: 5,
  targetTiers: DEFAULT_TIERS,
};

/** Public entry point. Consumes ALL sales for the compute period and
 *  emits one row per (family, tier) that passed the thresholds. */
export function computeObservedMultipliers(
  sales: FamilySale[],
  opts: ObservedMultipliersOptions = {},
  now: Date = new Date(),
): ObservedMultipliersResult {
  const options = resolveOptions(opts);
  const {
    windowDays, minRawSamples, minGradedSamples, targetTiers,
  } = options;

  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const tierSet = new Set(targetTiers);

  // Family → raw prices, plus family → tier → graded prices
  const raw = new Map<string, { label: string; prices: number[] }>();
  const graded = new Map<string, Map<string, number[]>>();

  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    const t = Date.parse(s.saleDate);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const familyKey = slugFamily(s.cardSetType);
    if (!familyKey) continue;
    const familyLabel = s.cardSetType;

    const graderName = (s.grader ?? "").trim();
    const isRaw = graderName === "" || graderName.toLowerCase() === "raw";

    if (isRaw) {
      let e = raw.get(familyKey);
      if (!e) {
        e = { label: familyLabel, prices: [] };
        raw.set(familyKey, e);
      }
      e.prices.push(s.price);
    } else {
      // Graded row — construct the tier label. The daily-sales `grade`
      // column already stores the grader-prefixed form (e.g. "PSA 10").
      const tierLabel = s.grade && tierSet.has(s.grade) ? s.grade : null;
      if (!tierLabel) continue;

      let byTier = graded.get(familyKey);
      if (!byTier) {
        byTier = new Map();
        graded.set(familyKey, byTier);
      }
      let arr = byTier.get(tierLabel);
      if (!arr) {
        arr = [];
        byTier.set(tierLabel, arr);
      }
      arr.push(s.price);
    }
  }

  const rows: FamilyMultiplierRow[] = [];
  const computedAt = now.toISOString();

  for (const [familyKey, rawEntry] of raw.entries()) {
    if (rawEntry.prices.length < minRawSamples) continue;
    const medianRaw = median(rawEntry.prices);
    if (medianRaw <= 0) continue;

    const tierMap = graded.get(familyKey);
    if (!tierMap) continue;

    for (const [tier, gradedPrices] of tierMap.entries()) {
      if (gradedPrices.length < minGradedSamples) continue;
      const medianGraded = median(gradedPrices);
      const multiplier = medianGraded / medianRaw;
      rows.push({
        familyKey,
        familyLabel: rawEntry.label,
        graderTier: tier,
        multiplier: round(multiplier, 3),
        nGraded: gradedPrices.length,
        nRaw: rawEntry.prices.length,
        medianGradedPrice: round(medianGraded, 2),
        medianRawPrice: round(medianRaw, 2),
        confidence: classifyConfidence(gradedPrices.length, rawEntry.prices.length),
        computedAt,
      });
    }
  }

  rows.sort((a, b) => b.multiplier - a.multiplier);

  return {
    computedAt,
    windowDays,
    familiesConsidered: raw.size,
    familiesPublished: new Set(rows.map((r) => r.familyKey)).size,
    rows,
  };
}

/** Slug a card_set_type into a stable, URL-safe family key. Examples:
 *    "Bowman Chrome Baseball"   → "bowman_chrome_baseball"
 *    "Panini Prizm Baseball"    → "panini_prizm_baseball" */
export function slugFamily(cardSetType: string): string {
  if (!cardSetType) return "";
  return cardSetType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function classifyConfidence(nGraded: number, nRaw: number): "high" | "medium" | "low" {
  if (nGraded >= 30 && nRaw >= 100) return "high";
  if (nGraded >= 10 && nRaw >= 50) return "medium";
  return "low";
}

function resolveOptions(opts: ObservedMultipliersOptions): Required<ObservedMultipliersOptions> {
  return {
    windowDays: opts.windowDays ?? DEFAULTS.windowDays,
    minRawSamples: opts.minRawSamples ?? DEFAULTS.minRawSamples,
    minGradedSamples: opts.minGradedSamples ?? DEFAULTS.minGradedSamples,
    targetTiers: opts.targetTiers ?? DEFAULTS.targetTiers,
  };
}

/** Numerically stable median. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

export const _DEFAULTS = DEFAULTS;
