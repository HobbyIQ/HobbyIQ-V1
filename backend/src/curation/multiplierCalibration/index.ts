// CF-CAT-ENGINE (2026-06-21): public API + the orchestrating runner.
//
// Pure runner — accepts a fetch scope + an apiKey, executes the
// analyze→generate phases, returns the worksheet. No I/O beyond
// Cardsight (read-only). Owner runs this from a CLI script or test
// invocation; the worksheet output is reviewed via PR.
//
// Apply step is deliberately not here. The worksheet is the deliverable.

import {
  fetchCorpus,
  type CorpusFetchScope,
  type CorpusFetchResult,
} from "./cardsightCorpus.js";
import { bucketCardSales, type PerCardBuckets } from "./pairedRatio.js";
import { analyzeAllTiers, discoverTierKeys } from "./densityAnalyzer.js";
import {
  buildWorksheet,
  renderWorksheetAsTs,
  type Worksheet,
} from "./worksheetGenerator.js";

export interface RunCalibrationResult {
  worksheet: Worksheet;
  renderedTs: string;
  corpus: CorpusFetchResult;
}

export interface RunCalibrationOptions {
  scope: CorpusFetchScope;
  apiKey: string;
  /** Fixes generatedAt for tests / reproducibility. Defaults to new Date().toISOString(). */
  now?: string;
  /** Progress hook for CLI runs. */
  onProgress?: (probed: number, total: number) => void;
}

export async function runCalibration(
  opts: RunCalibrationOptions,
): Promise<RunCalibrationResult> {
  const generatedAt = opts.now ?? new Date().toISOString();

  const corpus = await fetchCorpus(opts.scope, opts.apiKey, opts.onProgress);
  const perCard: PerCardBuckets[] = corpus.perCard.map(bucketCardSales);
  const tierKeys = discoverTierKeys(perCard);
  const analyses = analyzeAllTiers(perCard, tierKeys);

  const worksheet = buildWorksheet(
    {
      scopeLabel: opts.scope.scopeLabel,
      generatedAt,
      cardsProbed: corpus.cardsProbed,
      cardsErrored: corpus.cardsErrored,
    },
    analyses,
  );

  return {
    worksheet,
    renderedTs: renderWorksheetAsTs(worksheet),
    corpus,
  };
}

export {
  fetchCorpus,
  fetchSetCards,
  fetchCardSales,
  type CorpusFetchScope,
  type CorpusFetchResult,
} from "./cardsightCorpus.js";
export {
  bucketCardSales,
  pairedRatiosStrict,
  pairedRatiosRelaxed,
  median,
  percentile,
  type PerCardBuckets,
  type PairedRatio,
  type PairedBasis,
} from "./pairedRatio.js";
export {
  analyzeAllTiers,
  analyzeTier,
  computeTierPremium,
  assignProvenance,
  discoverTierKeys,
  deriveRefRelativeFromBase,
  MIN_EMPIRICAL_N,
  type TierAnalysisResult,
  type TierDensity,
  type TierPremiumCandidate,
  type TierProvenanceVerdict,
} from "./densityAnalyzer.js";
export {
  buildWorksheet,
  renderWorksheetAsTs,
  type Worksheet,
  type WorksheetMeta,
  type WorksheetTierProposal,
} from "./worksheetGenerator.js";
export {
  classifySale,
  isBaseAutoTitle,
  type ClassifiedSale,
} from "./saleClassifier.js";
