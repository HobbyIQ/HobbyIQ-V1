// CF-ML-MOAT GROUP C PHASE A (2026-06-04): training-dataset join service.
//
// Phase A is the dataset DEFINITION. No model. No training. The deliverable
// is a stable, leakage-free function that joins prediction_log ×
// prediction_outcomes into a row shape Phase B can train on without
// thinking about leakage, ID schemes, or schema drift.
//
// Both containers share partitionKey = /cardsightCardId, which makes the
// join cheap: every outcome doc carries `predictionDocId`, and the
// corresponding prediction row lives in the SAME partition. We iterate
// outcomes (cross-partition fetchAll today; per-partition fan-out is a
// scale-up concern) and point-read each prediction. At current Phase A
// scale this is fine — corpus volume is single-digit; the entire join
// completes in well under a second.
//
// LEAKAGE GUARD: the joined row separates `features` (strictly as-of
// prediction time, sourced from prediction_log) from `label` (sourced
// from prediction_outcomes). The set of `features` keys is frozen and
// asserted in trainingDatasetJoin.test.ts; the set of keys excludes
// `salesSample`, `nSalesInWindow`, `realizedOutcomePrice`, and every
// other post-prediction field. Any future field added to the feature
// set must also be added to FEATURE_KEYS in this file AND to the
// schema doc at docs/ML_TRAINING_SCHEMA.md — the test asserts the two
// stay in sync.
//
// USAGE: this service is reusable from the export script
// (backend/src/scripts/exportTrainingDataset.ts) and from any future
// ML pipeline. It is NOT mounted as a request-path endpoint — training
// dataset assembly belongs offline.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

import type { TrendIQWeights } from "../compiq/trendIQ.types.js";
import type { OutcomeDoc, OutcomeSource } from "../outcomes/predictionOutcomes.service.js";

// ─── Frozen feature key set ────────────────────────────────────────────────
//
// EVERY key here is sourced from prediction_log ONLY (the row visible at
// prediction-emit time). Adding a key here requires updating the schema
// doc; trainingDatasetJoin.test.ts asserts the two match.

export const FEATURE_KEYS = [
  // Card identity
  "playerName",
  "cardYear",
  "product",
  "parallel",
  "gradeCompany",
  "gradeValue",
  // As-of-prediction pricing
  "fairMarketValue",
  "predictedPrice",
  "predictedPriceRangeLow",
  "predictedPriceRangeHigh",
  // Engineered projection input
  "forwardProjectionFactor",
  // TrendIQ composite + per-layer multipliers + per-layer weights
  "trendIQ_composite",
  "trendIQ_playerMomentum",
  "trendIQ_cardTrajectory",
  "trendIQ_segmentTrajectory",
  "trendIQ_weight_playerMomentum",
  "trendIQ_weight_cardTrajectory",
  "trendIQ_weight_segmentTrajectory",
  // Corpus-quality signals — load-bearing for Phase B reliability scoring
  "compsUsed",
  "cache_hit",
  "served_stale",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface TrainingDatasetFeatures {
  // Identity (kept STRING-typed; Phase B encodes / hashes / drops as needed)
  playerName: string | null;
  cardYear: number | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  // Pricing
  fairMarketValue: number | null;
  predictedPrice: number | null;
  predictedPriceRangeLow: number | null;
  predictedPriceRangeHigh: number | null;
  // Engineering
  forwardProjectionFactor: number;
  // TrendIQ — flat scalars only. Phase B can recover ratios; nested objects
  // would slow joins and complicate leakage checks.
  trendIQ_composite: number | null;
  trendIQ_playerMomentum: number | null;
  trendIQ_cardTrajectory: number | null;
  trendIQ_segmentTrajectory: number | null;
  trendIQ_weight_playerMomentum: number | null;
  trendIQ_weight_cardTrajectory: number | null;
  trendIQ_weight_segmentTrajectory: number | null;
  // Corpus quality
  compsUsed: number;
  cache_hit: boolean | null;
  served_stale: boolean | null;
}

export interface TrainingDatasetLabel {
  // Absolute realized outcome (median of in-window sales).
  realizedOutcomePrice: number | null;
  // Return relative to FMV at prediction time. Lets Phase B train on
  // either target without re-derivation.
  realizedReturn: number | null;
  horizonDays: number;
  outcomeSource: OutcomeSource;
}

export interface TrainingDatasetBaseline {
  // The price the SHIPPED system actually told the user. Phase B evals
  // the ML model vs realized AND vs this baseline so we can answer
  // "did the model beat the GPT-4o pipeline?"
  surfacedPrice: number | null;
  surfacedPriceSource: "predictedPrice" | "fairMarketValue" | "none";
}

export interface TrainingDatasetMetadata {
  // Join + debug only. NEVER fed to the model.
  predictionDocId: string;
  outcomeDocId: string;
  cardsightCardId: string;
  predictionTimestamp: string;
  outcomeCapturedAt: string;
  userId: string | null;
  holdingId: string | null;
  source: string;
  routedFromHolding: boolean;
}

export interface TrainingDatasetRow {
  features: TrainingDatasetFeatures;
  label: TrainingDatasetLabel;
  baseline: TrainingDatasetBaseline;
  metadata: TrainingDatasetMetadata;
  // Flagging — Phase B filters on these.
  labelUsable: boolean;
  // When labelUsable === false, why?
  excludeReason:
    | "no_sales_in_window"
    | "not_found"
    | "upstream_error"
    | null;
}

export interface TrainingDatasetSummary {
  totalOutcomes: number;
  joined: number;
  unmatched: number; // outcome existed but predictionDocId pointed to a missing prediction
  labelUsableGraded: number;
  labelUsableRaw: number;
  noSalesInWindow: number;
  notFound: number;
  upstreamError: number;
}

export interface TrainingDatasetResult {
  rows: TrainingDatasetRow[];
  summary: TrainingDatasetSummary;
}

// ─── Cosmos lazy init (test-aware) ─────────────────────────────────────────

let _outcomesContainer: Container | null = null;
let _predictionLogContainer: Container | null = null;
let _initPromise: Promise<void> | null = null;
const isTestMode = process.env.NODE_ENV === "test";

// Test-mode in-memory stores. Phase A tests use these to seed both sides
// of the join without going to Cosmos.
const _testOutcomes: OutcomeDoc[] = [];
const _testPredictions = new Map<string, any>(); // key = `${cardsightCardId}::${id}`

function predKey(cardsightCardId: string, id: string): string {
  return `${cardsightCardId}::${id}`;
}

export function _resetForTests(): void {
  _testOutcomes.length = 0;
  _testPredictions.clear();
  _outcomesContainer = null;
  _predictionLogContainer = null;
  _initPromise = null;
}

export function _seedOutcomeForTests(doc: OutcomeDoc): void {
  _testOutcomes.push(doc);
}

export function _seedPredictionForTests(row: any): void {
  _testPredictions.set(predKey(row.cardsightCardId, row.id), row);
}

async function ensureContainers(): Promise<{
  outcomes: Container | null;
  predictions: Container | null;
}> {
  if (isTestMode) return { outcomes: null, predictions: null };
  if (_outcomesContainer && _predictionLogContainer) {
    return { outcomes: _outcomesContainer, predictions: _predictionLogContainer };
  }
  if (!_initPromise) {
    _initPromise = (async () => {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName =
        process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
      const outcomesName =
        process.env.COSMOS_PREDICTION_OUTCOMES_CONTAINER ?? "prediction_outcomes";
      const predictionsName =
        process.env.COSMOS_PREDICTION_LOG_CONTAINER ?? "prediction_log";

      if (!endpoint && !connStr) {
        console.warn(
          "[cosmos][mlTraining.join] COSMOS not configured — join returns empty",
        );
        return;
      }
      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      _outcomesContainer = database.container(outcomesName);
      _predictionLogContainer = database.container(predictionsName);
    })().catch((err) => {
      console.error(
        "[cosmos][mlTraining.join] init failed:",
        err?.message ?? err,
      );
    });
  }
  await _initPromise;
  return { outcomes: _outcomesContainer, predictions: _predictionLogContainer };
}

// ─── Pure mapping helpers ──────────────────────────────────────────────────

function deriveLabelUsable(outcome: OutcomeDoc): boolean {
  if (
    outcome.outcomeSource === "cardsight_graded_window" ||
    outcome.outcomeSource === "cardsight_raw_window"
  ) {
    return outcome.realizedOutcomePrice !== null;
  }
  return false;
}

function deriveExcludeReason(
  outcome: OutcomeDoc,
): TrainingDatasetRow["excludeReason"] {
  switch (outcome.outcomeSource) {
    case "no_sales_in_window":
      return "no_sales_in_window";
    case "not_found":
      return "not_found";
    case "upstream_error":
      return "upstream_error";
    default:
      return null;
  }
}

function deriveRealizedReturn(
  realizedOutcomePrice: number | null,
  fairMarketValue: number | null,
): number | null {
  if (
    realizedOutcomePrice == null ||
    fairMarketValue == null ||
    fairMarketValue === 0
  ) {
    return null;
  }
  return realizedOutcomePrice / fairMarketValue;
}

function pickWeight(
  weights: TrendIQWeights | null | undefined,
  key: keyof TrendIQWeights,
): number | null {
  if (!weights) return null;
  const v = weights[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickComponentMultiplier(component: unknown): number | null {
  if (!component || typeof component !== "object") return null;
  const m = (component as { multiplier?: unknown }).multiplier;
  return typeof m === "number" && Number.isFinite(m) ? m : null;
}

/**
 * Build the features object from a prediction_log row. Strictly as-of
 * prediction emit time. Sources ONLY from prediction_log fields. Adding
 * a new feature requires:
 *   1. Adding the key to FEATURE_KEYS
 *   2. Adding the field to TrainingDatasetFeatures
 *   3. Adding the mapping here
 *   4. Updating docs/ML_TRAINING_SCHEMA.md
 *   5. Updating the row-shape test
 */
function buildFeatures(prediction: any): TrainingDatasetFeatures {
  return {
    playerName: prediction.playerName ?? null,
    cardYear: prediction.cardYear ?? null,
    product: prediction.product ?? null,
    parallel: prediction.parallel ?? null,
    gradeCompany: prediction.gradeCompany ?? null,
    gradeValue: prediction.gradeValue ?? null,
    fairMarketValue: prediction.fairMarketValue ?? null,
    predictedPrice: prediction.predictedPrice ?? null,
    predictedPriceRangeLow: prediction.predictedPriceRange?.low ?? null,
    predictedPriceRangeHigh: prediction.predictedPriceRange?.high ?? null,
    forwardProjectionFactor:
      typeof prediction.forwardProjectionFactor === "number"
        ? prediction.forwardProjectionFactor
        : 0,
    // TrendIQ — read both the flat-hoisted top-level fields (Phase 4B Slice 1)
    // AND the nested struct so older rows that pre-date the hoist still join.
    trendIQ_composite:
      typeof prediction.trendIQ_composite === "number"
        ? prediction.trendIQ_composite
        : typeof prediction.trendIQ?.composite === "number"
        ? prediction.trendIQ.composite
        : null,
    trendIQ_playerMomentum:
      typeof prediction.playerMomentum_multiplier === "number"
        ? prediction.playerMomentum_multiplier
        : pickComponentMultiplier(prediction.trendIQ?.components?.playerMomentum),
    trendIQ_cardTrajectory: pickComponentMultiplier(
      prediction.trendIQ?.components?.cardTrajectory,
    ),
    trendIQ_segmentTrajectory: pickComponentMultiplier(
      prediction.trendIQ?.components?.segmentTrajectory,
    ),
    trendIQ_weight_playerMomentum: pickWeight(
      prediction.trendIQ_weights ?? prediction.trendIQ?.weights,
      "playerMomentum",
    ),
    trendIQ_weight_cardTrajectory: pickWeight(
      prediction.trendIQ_weights ?? prediction.trendIQ?.weights,
      "cardTrajectory",
    ),
    trendIQ_weight_segmentTrajectory: pickWeight(
      prediction.trendIQ_weights ?? prediction.trendIQ?.weights,
      "segmentTrajectory",
    ),
    compsUsed: typeof prediction.compsUsed === "number" ? prediction.compsUsed : 0,
    cache_hit: typeof prediction.cache_hit === "boolean" ? prediction.cache_hit : null,
    served_stale:
      typeof prediction.served_stale === "boolean" ? prediction.served_stale : null,
  };
}

function buildBaseline(prediction: any): TrainingDatasetBaseline {
  return {
    surfacedPrice: prediction.surfacedPrice ?? null,
    surfacedPriceSource:
      prediction.surfacedPriceSource === "predictedPrice" ||
      prediction.surfacedPriceSource === "fairMarketValue" ||
      prediction.surfacedPriceSource === "none"
        ? prediction.surfacedPriceSource
        : "none",
  };
}

function buildMetadata(
  prediction: any,
  outcome: OutcomeDoc,
): TrainingDatasetMetadata {
  return {
    predictionDocId: prediction.id,
    outcomeDocId: outcome.id,
    cardsightCardId: outcome.cardsightCardId,
    predictionTimestamp: prediction.timestamp,
    outcomeCapturedAt: outcome.capturedAt,
    userId: prediction.userId ?? null,
    holdingId: prediction.holdingId ?? null,
    source: typeof prediction.source === "string" ? prediction.source : "unknown",
    routedFromHolding: prediction.routedFromHolding === true,
  };
}

// ─── Storage primitives ────────────────────────────────────────────────────

async function fetchAllOutcomes(): Promise<OutcomeDoc[]> {
  if (isTestMode) return [..._testOutcomes];
  const { outcomes } = await ensureContainers();
  if (!outcomes) return [];
  const { resources } = await outcomes.items
    .query<OutcomeDoc>({
      query:
        'SELECT * FROM c WHERE c.docType = "prediction_outcome"',
    })
    .fetchAll();
  return resources;
}

async function pointReadPrediction(
  predictionDocId: string,
  cardsightCardId: string,
): Promise<any | null> {
  if (isTestMode) {
    return _testPredictions.get(predKey(cardsightCardId, predictionDocId)) ?? null;
  }
  const { predictions } = await ensureContainers();
  if (!predictions) return null;
  try {
    const { resource } = await predictions
      .item(predictionDocId, cardsightCardId)
      .read<any>();
    return resource ?? null;
  } catch {
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build the Phase A training-dataset rows by joining prediction_log ×
 * prediction_outcomes. Returns ALL matched pairs with labelUsable flagged.
 *
 * The join filters on prediction_log.joinable === true via the point-read
 * mechanism: only rows persisted with a real cardsightCardId have an
 * outcome candidate, and the outcome's predictionDocId reads back ONLY
 * those rows. Sentinel-partition predictions never get outcomes captured
 * (the outcomes job filters joinable=true upstream); the join naturally
 * excludes them.
 *
 * No-sales-in-window rows are KEPT (Phase B uses them as a liquidity
 * signal — separate model head). They're flagged labelUsable=false with
 * excludeReason="no_sales_in_window" so Phase B regression code can
 * skip them with one boolean filter.
 */
export async function joinTrainingDataset(): Promise<TrainingDatasetResult> {
  const outcomes = await fetchAllOutcomes();
  const summary: TrainingDatasetSummary = {
    totalOutcomes: outcomes.length,
    joined: 0,
    unmatched: 0,
    labelUsableGraded: 0,
    labelUsableRaw: 0,
    noSalesInWindow: 0,
    notFound: 0,
    upstreamError: 0,
  };

  const rows: TrainingDatasetRow[] = [];

  for (const outcome of outcomes) {
    const prediction = await pointReadPrediction(
      outcome.predictionDocId,
      outcome.cardsightCardId,
    );
    if (!prediction) {
      summary.unmatched += 1;
      continue;
    }
    // joinable invariant: skip any sentinel-partition rows that somehow
    // slipped through (defense-in-depth — the outcomes job filters these
    // out at candidate-selection time).
    if (prediction.joinable !== true) {
      summary.unmatched += 1;
      continue;
    }

    const features = buildFeatures(prediction);
    const baseline = buildBaseline(prediction);
    const metadata = buildMetadata(prediction, outcome);
    const labelUsable = deriveLabelUsable(outcome);
    const excludeReason = labelUsable ? null : deriveExcludeReason(outcome);

    rows.push({
      features,
      label: {
        realizedOutcomePrice: outcome.realizedOutcomePrice,
        realizedReturn: deriveRealizedReturn(
          outcome.realizedOutcomePrice,
          features.fairMarketValue,
        ),
        horizonDays: outcome.horizonDays,
        outcomeSource: outcome.outcomeSource,
      },
      baseline,
      metadata,
      labelUsable,
      excludeReason,
    });

    summary.joined += 1;
    if (outcome.outcomeSource === "cardsight_graded_window" && labelUsable) {
      summary.labelUsableGraded += 1;
    } else if (outcome.outcomeSource === "cardsight_raw_window" && labelUsable) {
      summary.labelUsableRaw += 1;
    } else if (outcome.outcomeSource === "no_sales_in_window") {
      summary.noSalesInWindow += 1;
    } else if (outcome.outcomeSource === "not_found") {
      summary.notFound += 1;
    } else if (outcome.outcomeSource === "upstream_error") {
      summary.upstreamError += 1;
    }
  }

  return { rows, summary };
}
