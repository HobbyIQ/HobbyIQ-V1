// CF-RELEASE-DECAY-CALIBRATION (2026-07-05, Drew):
// Read `release_decay_applied` events from the corpus + observed grade
// curves persisted for the SAME cards N days later. Compute prediction
// error per week-since-release bucket. Emit a schedule-tweak proposal
// that the engine team can hand-review before adjusting the piecewise
// decay rates in `releaseDecayPrior.service.ts`.
//
// Why this exists:
// Drew's guidance when we shipped release-decay-prior (2026-07-05):
// "hand-tuned baseline curve, calibrate over time". This is the "over
// time" step. As we accumulate captured curves in the corpus, we can
// measure whether the -12/-8/-5/-2%/wk schedule actually matches what
// cards did — and adjust each bucket toward the empirical rate.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." \
//     node backend/scripts/calibrate-release-decay.cjs
//
// Reads the following env vars:
//   COSMOS_CONNECTION_STRING    — required
//   COSMOS_DB_NAME              — default "hobbyiq"
//   COSMOS_CORPUS_CONTAINER     — default "cardhedge_learn_corpus"
//   CALIBRATION_MIN_SAMPLES     — min captures per bucket before we
//                                  recommend a tweak (default 5)
//
// Output: a machine-readable proposal to stdout. Never writes to
// Cosmos or to the source code — the engine team applies changes
// manually after reviewing.

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set in env");
  process.exit(1);
}
const DB_NAME = process.env.COSMOS_DB_NAME || "hobbyiq";
const CORPUS_CONTAINER = process.env.COSMOS_CORPUS_CONTAINER || "cardhedge_learn_corpus";
const MIN_SAMPLES = parseInt(process.env.CALIBRATION_MIN_SAMPLES || "5", 10);

// The current schedule — MUST stay in sync with releaseDecayPrior.service.ts
// If the service's DECAY_SCHEDULE moves, update this too or the calibration
// proposals will drift.
const CURRENT_SCHEDULE = [
  { label: "0-2wk", maxWeeks: 2, decayRatePerWeek: -0.12, blend: 1.00 },
  { label: "2-4wk", maxWeeks: 4, decayRatePerWeek: -0.08, blend: 0.75 },
  { label: "4-6wk", maxWeeks: 6, decayRatePerWeek: -0.05, blend: 0.50 },
  { label: "6-8wk", maxWeeks: 8, decayRatePerWeek: -0.02, blend: 0.25 },
];

function bucketFor(weeksSinceRelease) {
  for (const b of CURRENT_SCHEDULE) {
    if (weeksSinceRelease < b.maxWeeks) return b;
  }
  return null;
}

/**
 * Query all captured grade-curve docs that used a release-decay signal
 * (either "release-decay-blend" or "release-decay-only"). Each doc is
 * a snapshot of (cardId, grades[], ratePerWeek, signalSource, capturedAt).
 *
 * For each doc, we look up a MORE RECENT snapshot of the same cardId to
 * see how the price actually moved. If the newer snapshot's Raw value
 * differs from the older snapshot's Raw predicted, we have a data point.
 */
async function main() {
  const client = new CosmosClient(CONN);
  const container = client.database(DB_NAME).container(CORPUS_CONTAINER);

  console.log(`[calibrate-release-decay] Reading captures from ${DB_NAME}.${CORPUS_CONTAINER}`);
  console.log(`[calibrate-release-decay] MIN_SAMPLES per bucket = ${MIN_SAMPLES}`);
  console.log("");

  // Read all decay-signal captures. Small enough to load in memory —
  // we're calibrating on days-to-weeks of data, ~thousands of docs max.
  const query = {
    query: `SELECT c.cardId, c.capturedAt, c.ratePerWeek, c.signalSource, c.grades
            FROM c
            WHERE c.signalSource IN ("release-decay-blend", "release-decay-only")
            ORDER BY c.capturedAt ASC`,
  };
  const { resources: captures } = await container.items.query(query).fetchAll();
  console.log(`[calibrate-release-decay] Found ${captures.length} captures with decay signal`);

  if (captures.length === 0) {
    console.log("[calibrate-release-decay] No captures yet — nothing to calibrate. Try again in a few days.");
    return;
  }

  // Group by cardId so we can pair each capture with a later snapshot.
  const byCard = new Map();
  for (const c of captures) {
    if (!byCard.has(c.cardId)) byCard.set(c.cardId, []);
    byCard.get(c.cardId).push(c);
  }

  // For each cardId, walk chronologically. For each (earlier, later)
  // pair where the earlier used decay and later has a Raw value, compute
  // actual weekly-rate observed:
  //   actualRatePerWeek = ((later.rawValue / earlier.rawPredicted) - 1)
  //                        × 7 / (later.days - earlier.days)
  const dataPoints = []; // { weeksSinceReleaseAtCapture, appliedRate, actualRate, gapPct }
  for (const [cardId, list] of byCard) {
    for (let i = 0; i < list.length; i++) {
      const earlier = list[i];
      const earlierRaw = (earlier.grades || []).find((g) => g.grade === "Raw");
      if (!earlierRaw || !earlierRaw.predictedPriceAt30d) continue;
      // Only consider captures where we're inside the decay window
      // (rate < 0 tells us decay was applied at all).
      if (typeof earlier.ratePerWeek !== "number") continue;

      // Find the closest LATER snapshot for the same cardId that has
      // an observed Raw value (valueSource === "observed").
      for (let j = i + 1; j < list.length; j++) {
        const later = list[j];
        const laterRaw = (later.grades || []).find((g) => g.grade === "Raw");
        if (!laterRaw || laterRaw.valueSource !== "observed" || !laterRaw.observedMedian) continue;

        const daysBetween =
          (Date.parse(later.capturedAt) - Date.parse(earlier.capturedAt)) /
          (24 * 3600 * 1000);
        if (!Number.isFinite(daysBetween) || daysBetween < 3) continue; // too close, noise
        if (daysBetween > 45) break; // stale pairing — later captures more relevant

        const weeksElapsed = daysBetween / 7;
        // What did earlier PREDICT the price to be at this later date?
        // earlier.rate applied over weeksElapsed:
        const predictedNow =
          (earlierRaw.observedMedian || earlierRaw.predictedPriceAt30d) *
          (1 + earlier.ratePerWeek * weeksElapsed);
        const actualNow = laterRaw.observedMedian;
        // Empirical rate that would have taken earlier's anchor to
        // later's actual price
        const anchor = earlierRaw.observedMedian || earlierRaw.predictedPriceAt30d;
        const actualRatePerWeek =
          weeksElapsed > 0
            ? (actualNow / anchor - 1) / weeksElapsed
            : 0;

        // Which bucket did the applied rate correspond to?
        // Reverse-engineer: the earlier ratePerWeek came from a blend,
        // so we can't perfectly recover the bucket. Best proxy: use
        // (capturedAt - release_date) but we don't have release_date on
        // the capture doc. Fall back to bucket = "unknown" and just
        // report the delta between applied and actual per-cardId.
        dataPoints.push({
          cardId,
          earlierCapturedAt: earlier.capturedAt,
          laterCapturedAt: later.capturedAt,
          daysBetween: Math.round(daysBetween),
          weeksElapsed: Math.round(weeksElapsed * 100) / 100,
          appliedRatePerWeek: Math.round(earlier.ratePerWeek * 10000) / 100,
          actualRatePerWeek: Math.round(actualRatePerWeek * 10000) / 100,
          errorPct:
            actualRatePerWeek !== 0
              ? Math.round(
                  ((earlier.ratePerWeek - actualRatePerWeek) / Math.abs(actualRatePerWeek)) *
                    10000,
                ) / 100
              : null,
          signalSource: earlier.signalSource,
        });

        break; // pair with the first-suitable later capture, then move on
      }
    }
  }

  console.log(`[calibrate-release-decay] Generated ${dataPoints.length} paired data points`);
  console.log("");

  if (dataPoints.length < MIN_SAMPLES) {
    console.log(
      `[calibrate-release-decay] Below MIN_SAMPLES=${MIN_SAMPLES} — insufficient data for a proposal. Continue running the engine and re-run this script in a few days.`,
    );
    return;
  }

  // Overall summary: mean applied vs mean actual, and mean error.
  const meanApplied =
    dataPoints.reduce((s, p) => s + p.appliedRatePerWeek, 0) / dataPoints.length;
  const meanActual =
    dataPoints.reduce((s, p) => s + p.actualRatePerWeek, 0) / dataPoints.length;

  const proposal = {
    generatedAt: new Date().toISOString(),
    samplesUsed: dataPoints.length,
    minSamplesThreshold: MIN_SAMPLES,
    overall: {
      meanAppliedRatePerWeekPct: Math.round(meanApplied * 100) / 100,
      meanActualRatePerWeekPct: Math.round(meanActual * 100) / 100,
      biasPct: Math.round((meanApplied - meanActual) * 100) / 100,
      biasDirection:
        meanApplied > meanActual
          ? "Predicted was MORE negative than actual (decay too aggressive)"
          : meanApplied < meanActual
            ? "Predicted was LESS negative than actual (decay too gentle)"
            : "matched",
    },
    currentSchedule: CURRENT_SCHEDULE,
    dataPointsPreview: dataPoints.slice(0, 20),
    notes: [
      "Bucket-level tweaks require pairing each capture with its release-date at capture time.",
      "That correlation ISN'T on today's capture doc — add `weeksSinceReleaseAtCapture` to the persistence layer and re-run in a week.",
      "Meanwhile, the overall bias direction is a first-pass signal: if we're consistently too negative, shift the whole schedule up by biasPct/4.",
    ],
  };

  console.log(JSON.stringify(proposal, null, 2));
}

main().catch((err) => {
  console.error("[calibrate-release-decay] FAILED:", err.message);
  console.error(err.stack);
  process.exit(2);
});
