// CF-CONFIDENCE-WEIGHTS-LEARNER (Drew, 2026-08-01). The "as we scrub
// it learns" loop. Reads captured learning_events + downstream row
// outcomes, computes how well each confidence signal predicted the
// eventual human decision, and derives adjusted weights.
//
// Runs nightly via cron. Persists learned weights to a
// confidence_weights container so the confidence scorer can load them
// on the next request. Falls back to hand-tuned defaults if no learned
// weights exist yet.
//
// Metric: for each signal, compute the correlation between:
//   - signal contribution when the row was scored
//   - whether the row was later CLEARED (positive), QUARANTINED
//     (negative), or LABEL-CORRECTED (mixed)
//
// Signals that historically CORRELATE with human-confirmed clean rows
// get their weight boosted; signals that correlate with human-flagged
// contamination get their weight boosted for the OPPOSITE direction.
//
// v1: simple positive/negative correlation → weight adjustment
// (bounded ±30% per training cycle so weights don't oscillate).
// v2 (future): full logistic regression with regularization.

import { CosmosClient, type Container } from "@azure/cosmos";
import { readLearningEvents } from "./learningEvents.service.js";

interface LearnedWeights {
  id: string;
  computedAt: string;
  trainingEventCount: number;
  weights: Record<string, number>;
  signalStats: Record<string, { positive: number; negative: number; correlation: number }>;
  version: number;
}

const CONTAINER_ID = process.env.COSMOS_CONFIDENCE_WEIGHTS_CONTAINER ?? "confidence_weights";
const CURRENT_ID = "current";
const MAX_WEIGHT_DELTA_PCT = 0.30;   // limit per-cycle drift so weights stabilize
const MIN_SAMPLES_PER_SIGNAL = 20;   // don't adjust weights on <20 samples

let cachedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({ id: process.env.COSMOS_DATABASE ?? "hobbyiq" });
    const { container } = await database.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/id"] },
      defaultTtl: -1,
    });
    cachedContainer = container;
    return container;
  } catch { return null; }
}

/** Load the current learned weights (or null if none exist yet — use defaults). */
export async function loadCurrentWeights(): Promise<LearnedWeights | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(CURRENT_ID, CURRENT_ID).read();
    return (resource as LearnedWeights) ?? null;
  } catch { return null; }
}

/** Run one training cycle. Reads the last 30d of learning events,
 *  computes correlations, adjusts weights, persists.
 *
 *  Returns the newly-computed weights (or null if not enough data). */
export async function trainConfidenceWeights(opts?: { fromDaysBack?: number; minSamples?: number }): Promise<LearnedWeights | null> {
  const daysBack = opts?.fromDaysBack ?? 30;
  const minSamples = opts?.minSamples ?? MIN_SAMPLES_PER_SIGNAL;
  const fromDate = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);

  const events = await readLearningEvents({
    eventTypes: ["ingest-accept", "ingest-quarantine", "ingest-reject", "quarantine-clear", "quarantine-force", "labeler-save"],
    fromDate,
    limit: 5000,
  });

  if (events.length < 50) return null;   // not enough training data yet

  const signalStats: Record<string, { positive: number; negative: number; correlation: number }> = {};
  const POSITIVE_TYPES = new Set(["ingest-accept", "quarantine-clear", "labeler-save"]);
  const NEGATIVE_TYPES = new Set(["ingest-reject", "ingest-quarantine", "quarantine-force"]);

  for (const e of events) {
    const isPositive = POSITIVE_TYPES.has(e.eventType);
    const isNegative = NEGATIVE_TYPES.has(e.eventType);
    if (!isPositive && !isNegative) continue;
    const features = e.features ?? {};
    for (const [feature, value] of Object.entries(features)) {
      const stat = signalStats[feature] ?? (signalStats[feature] = { positive: 0, negative: 0, correlation: 0 });
      // Only weight-adjust numeric or boolean signals
      if (typeof value === "number") {
        if (isPositive) stat.positive += value;
        else stat.negative += value;
      } else if (typeof value === "boolean" && value) {
        if (isPositive) stat.positive += 1;
        else stat.negative += 1;
      }
    }
  }

  // Compute correlation = (positive - negative) / (positive + negative + eps)
  for (const stat of Object.values(signalStats)) {
    stat.correlation = (stat.positive - stat.negative) / (stat.positive + stat.negative + 0.001);
  }

  // Load current weights (or defaults)
  const current = await loadCurrentWeights();
  const currentWeights = current?.weights ?? {};
  const newWeights: Record<string, number> = { ...currentWeights };

  for (const [feature, stat] of Object.entries(signalStats)) {
    if (stat.positive + stat.negative < minSamples) continue;
    // Positive correlation → boost weight up to MAX_DELTA. Negative → reduce.
    const current = newWeights[feature] ?? 0.1;
    const adjustment = Math.max(-MAX_WEIGHT_DELTA_PCT, Math.min(MAX_WEIGHT_DELTA_PCT, stat.correlation * MAX_WEIGHT_DELTA_PCT));
    newWeights[feature] = Math.max(0.01, Math.min(1.0, current * (1 + adjustment)));
  }

  const learned: LearnedWeights = {
    id: CURRENT_ID,
    computedAt: new Date().toISOString(),
    trainingEventCount: events.length,
    weights: newWeights,
    signalStats,
    version: (current?.version ?? 0) + 1,
  };

  const container = await getContainer();
  if (container) {
    try { await container.items.upsert(learned); } catch { /* soft */ }
  }
  return learned;
}
