/**
 * Eligibility Analyzer — Phase B (rewrite) curation pipeline.
 *
 * Reads a staged Beckett file (`backend/data/beckett-sweep/{year}/{brand}.json`)
 * and determines whether the set is eligible for Phase B ingestion.
 *
 * Eligibility rule (locked, per phase-b-rewrite-prompt.md):
 *   - 100% of the staged parallels must be covered by the brand's
 *     multiplier table.
 *   - Partial coverage = NOT eligible. Phase B does not write
 *     half-curated sets.
 *
 * Pure: takes a parsed staged file in memory, returns a structured report.
 * The CLI wrapper that walks `backend/data/beckett-sweep/` and writes the
 * eligibility report file lives in `curationOrchestrator.ts`.
 */

import { brandHasTable, hasCoverage, lookup } from "./multiplierTableRegistry.js";

export type EligibilitySource = "beckett" | "cardboard-connection";

// ---------------------------------------------------------------------------
// Input shape — mirrors `StagedFile` from sweepOrchestrator.ts
// ---------------------------------------------------------------------------

export interface StagedParallel {
  rawName: string;
  printRun: number | null;
  isOneOfOne: boolean;
  note: string | null;
  normalization?: {
    strategy?: string;
    canonicalName?: string | null;
  };
}

export interface StagedFileLike {
  schemaVersion: number;
  source?: EligibilitySource;
  year: number;
  brand: string;
  setLabel: string;
  sourceUrl: string;
  parallels: StagedParallel[];
  // Other fields tolerated and ignored.
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type IneligibilityReason =
  | "brand-not-registered"
  | "partial-coverage"
  | "no-parallels-found"
  | "staged-file-empty";

export interface UncoveredParallel {
  rawName: string;
  printRun: number | null;
  /** When the staged-file normalizer offered a canonical guess. */
  normalizedCanonical: string | null;
}

export interface CoveredParallel {
  rawName: string;
  canonicalParallelName: string;
  tierWithinSet: number;
  printRun: number | null;
}

export interface EligibilityReport {
  set: string;
  brand: string;
  year: number;
  sourceUrl: string;
  /** Sources that contributed staged data for this set. */
  sources: EligibilitySource[];
  /** Source selected for downstream worksheet generation. */
  preferredSource: EligibilitySource | null;
  /** True when the same set is present in more than one source. */
  duplicateAcrossSources: boolean;
  totalParallels: number;
  coveredCount: number;
  uncoveredCount: number;
  coveredParallels: CoveredParallel[];
  uncoveredParallels: UncoveredParallel[];
  eligible: boolean;
  eligibilityReason: IneligibilityReason | "fully-covered";
  /** Human-readable summary line for the eligibility report file. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze a single staged file. Pure function — no I/O.
 *
 * Decision flow:
 *   1. Brand has no multiplier table at all → `brand-not-registered`.
 *   2. Staged file has zero parallels → `no-parallels-found`.
 *   3. Any parallel uncovered → `partial-coverage`.
 *   4. Otherwise → eligible.
 */
export function analyzeEligibility(staged: StagedFileLike): EligibilityReport {
  const source: EligibilitySource = staged.source ?? "beckett";
  const { brand, year, setLabel: set, sourceUrl, parallels } = staged;

  const covered: CoveredParallel[] = [];
  const uncovered: UncoveredParallel[] = [];

  if (!brandHasTable(brand, year)) {
    // Brand-not-registered short-circuits, but we still enumerate the
    // staged parallels so the eligibility report shows the owner exactly
    // what's missing if they ever publish a table for this brand.
    for (const p of parallels) {
      uncovered.push({
        rawName: p.rawName,
        printRun: p.printRun,
        normalizedCanonical: p.normalization?.canonicalName ?? null,
      });
    }
    return {
      set,
      brand,
      year,
      sourceUrl,
      sources: [source],
      preferredSource: null,
      duplicateAcrossSources: false,
      totalParallels: parallels.length,
      coveredCount: 0,
      uncoveredCount: parallels.length,
      coveredParallels: [],
      uncoveredParallels: uncovered,
      eligible: false,
      eligibilityReason: "brand-not-registered",
      summary:
        `INELIGIBLE: brand "${brand}" has no owner-curated multiplier table. ` +
        `${parallels.length} parallel(s) staged, all uncovered.`,
    };
  }

  if (parallels.length === 0) {
    return {
      set,
      brand,
      year,
      sourceUrl,
      sources: [source],
      preferredSource: null,
      duplicateAcrossSources: false,
      totalParallels: 0,
      coveredCount: 0,
      uncoveredCount: 0,
      coveredParallels: [],
      uncoveredParallels: [],
      eligible: false,
      eligibilityReason: "no-parallels-found",
      summary: `INELIGIBLE: staged file has zero parallels for ${set}.`,
    };
  }

  for (const p of parallels) {
    const candidate = p.normalization?.canonicalName ?? p.rawName;
    if (hasCoverage(brand, candidate, { year })) {
      const entry = lookup(brand, candidate, { year })!;
      covered.push({
        rawName: p.rawName,
        canonicalParallelName: entry.canonicalParallelName,
        tierWithinSet: entry.tierWithinSet,
        printRun: p.printRun,
      });
    } else {
      uncovered.push({
        rawName: p.rawName,
        printRun: p.printRun,
        normalizedCanonical: p.normalization?.canonicalName ?? null,
      });
    }
  }

  if (uncovered.length === 0) {
    return {
      set,
      brand,
      year,
      sourceUrl,
      sources: [source],
      preferredSource: source,
      duplicateAcrossSources: false,
      totalParallels: parallels.length,
      coveredCount: covered.length,
      uncoveredCount: 0,
      coveredParallels: covered,
      uncoveredParallels: [],
      eligible: true,
      eligibilityReason: "fully-covered",
      summary:
        `ELIGIBLE: ${set} — ${covered.length}/${parallels.length} parallels covered.`,
    };
  }

  return {
    set,
    brand,
    year,
    sourceUrl,
    sources: [source],
    preferredSource: null,
    duplicateAcrossSources: false,
    totalParallels: parallels.length,
    coveredCount: covered.length,
    uncoveredCount: uncovered.length,
    coveredParallels: covered,
    uncoveredParallels: uncovered,
    eligible: false,
    eligibilityReason: "partial-coverage",
    summary:
      `INELIGIBLE: ${set} — ${uncovered.length}/${parallels.length} parallels NOT in ` +
      `"${brand}" multiplier table. Owner must extend the table or defer this set.`,
  };
}

export interface StagedWithSource {
  source: EligibilitySource;
  staged: StagedFileLike;
}

/**
 * Analyze one logical set across all staged sources.
 *
 * Eligibility rule: the set is eligible when Beckett OR Cardboard Connection
 * (or both) is fully covered by the multiplier table. Partial coverage is not
 * merged across sources.
 */
export function analyzeEligibilityAcrossSources(
  entries: StagedWithSource[],
): EligibilityReport {
  if (entries.length === 0) {
    return {
      set: "",
      brand: "",
      year: 0,
      sourceUrl: "",
      sources: [],
      preferredSource: null,
      duplicateAcrossSources: false,
      totalParallels: 0,
      coveredCount: 0,
      uncoveredCount: 0,
      coveredParallels: [],
      uncoveredParallels: [],
      eligible: false,
      eligibilityReason: "staged-file-empty",
      summary: "INELIGIBLE: no staged sources provided for set analysis.",
    };
  }

  const reports = entries.map(({ source, staged }) =>
    analyzeEligibility({ ...staged, source }),
  );

  const sources = Array.from(new Set(reports.flatMap((r) => r.sources))) as EligibilitySource[];
  const duplicateAcrossSources = sources.length > 1;

  // Source preference policy:
  // 1) If Beckett is fully covered, prefer Beckett.
  // 2) Else prefer any other fully covered source with highest coveredCount.
  const eligibleReports = reports.filter((r) => r.eligible);
  const beckettPreferred = eligibleReports.find((r) => r.preferredSource === "beckett");
  const preferred = beckettPreferred
    ? beckettPreferred
    : eligibleReports.sort((a, b) => b.coveredCount - a.coveredCount)[0] ??
      reports.sort((a, b) => b.coveredCount - a.coveredCount)[0]!;

  const preferredSource = preferred.preferredSource;
  const baseSummary = preferred.summary;
  const summary = duplicateAcrossSources
    ? `${baseSummary} Duplicate set detected across sources: ${sources.join(", ")}.`
    : baseSummary;

  return {
    ...preferred,
    sources,
    preferredSource,
    duplicateAcrossSources,
    summary,
  };
}
