// CF-GRADE-MULTIPLIER-CALIBRATION (2026-07-05, Drew):
// Read observed grade-curve captures from the corpus and compute the
// EMPIRICAL grade multiplier for each (year, product, grade) triplet.
// Emit a proposal comparing the empirical multiplier to the hand-tuned
// constant in `observedGradeCurve.service.ts` so the engine team can
// swap the table in with confidence.
//
// Why this exists:
// Today's RAW_TO_GRADE_FALLBACK_MULTIPLIER is a hand-tuned table
// (Raw × 8 = PSA 10 for autos, etc.) calibrated against Bowman-family
// autographs. As the corpus grows we can:
//   1. Verify those constants against real (Raw, PSA 10) pair sales
//   2. Adjust per-year/per-product-family where the data disagrees
//   3. Detect drift as markets evolve
//
// The script is READ-ONLY. Never writes back to Cosmos or source.
// Engine team applies proposals manually after review.
//
// Usage:
//   COSMOS_CONNECTION_STRING="..." \
//     node backend/scripts/calibrate-grade-multipliers.cjs
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   COSMOS_DB_NAME               default "hobbyiq"
//   COSMOS_CORPUS_CONTAINER      default "cardhedge_learn_corpus"
//   MIN_SAMPLES_PER_BUCKET       default 5

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set in env");
  process.exit(1);
}
const DB_NAME = process.env.COSMOS_DB_NAME || "hobbyiq";
const CORPUS_CONTAINER = process.env.COSMOS_CORPUS_CONTAINER || "cardhedge_learn_corpus";
const MIN_SAMPLES = parseInt(process.env.MIN_SAMPLES_PER_BUCKET || "5", 10);

// Current hand-tuned table — MUST stay in sync with
// observedGradeCurve.service.ts RAW_TO_GRADE_FALLBACK_MULTIPLIER.
const HAND_TUNED = {
  "Raw":     1,
  "PSA 10":  8,
  "BGS 10":  20,
  "BGS 9.5": 5,
  "SGC 10":  5,
  "CGC 10":  5,
  "PSA 9":   3,
  "BGS 9":   3,
  "SGC 9":   3,
  "CGC 9":   3,
};

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const client = new CosmosClient(CONN);
  const container = client.database(DB_NAME).container(CORPUS_CONTAINER);

  console.log(`[calibrate-grade-multipliers] Reading captures from ${DB_NAME}.${CORPUS_CONTAINER}`);
  console.log(`[calibrate-grade-multipliers] MIN_SAMPLES_PER_BUCKET = ${MIN_SAMPLES}`);
  console.log("");

  // Fetch all observed-grade-curve captures. We want docs where multiple
  // grades ended up with valueSource === "observed" — that's the joint
  // observation we can extract per-card multipliers from.
  const query = {
    query: `SELECT c.cardId, c.identity, c.capturedAt, c.grades
            FROM c
            WHERE ARRAY_LENGTH(c.grades) > 0`,
  };
  const { resources: captures } = await container.items.query(query).fetchAll();
  console.log(`[calibrate-grade-multipliers] Loaded ${captures.length} captures`);

  // Per-(year, product-family, grade) bucket of empirical multipliers.
  // key = `${year}|${product}|${grade}`, value = number[]
  const buckets = new Map();
  const familyForSet = (setName) => {
    if (!setName || typeof setName !== "string") return "unknown";
    const s = setName.toLowerCase();
    if (s.includes("bowman chrome")) return "Bowman Chrome";
    if (s.includes("bowman draft"))  return "Bowman Draft";
    if (s.includes("bowman"))        return "Bowman";
    if (s.includes("topps chrome"))  return "Topps Chrome";
    if (s.includes("topps update"))  return "Topps Update";
    if (s.includes("topps heritage"))return "Topps Heritage";
    if (s.includes("topps finest")) return "Topps Finest";
    if (s.includes("topps"))         return "Topps";
    return "other";
  };

  for (const capture of captures) {
    const grades = capture.grades || [];
    const raw = grades.find((g) => g.grade === "Raw");
    if (!raw || !raw.observedMedian || raw.valueSource !== "observed") continue;
    const identity = capture.identity || {};
    const year = identity.year || "unknown";
    const family = familyForSet(identity.set);

    for (const g of grades) {
      if (g.grade === "Raw") continue;
      if (g.valueSource !== "observed") continue;
      if (!g.observedMedian || g.observedMedian <= 0) continue;
      const multiplier = g.observedMedian / raw.observedMedian;
      const key = `${year}|${family}|${g.grade}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(multiplier);
    }
  }

  // Build the proposal — for each bucket with enough samples, compare
  // empirical median to hand-tuned constant.
  const rows = [];
  for (const [key, mults] of buckets) {
    if (mults.length < MIN_SAMPLES) continue;
    const [year, family, grade] = key.split("|");
    const empiricalMedian = median(mults);
    const handTuned = HAND_TUNED[grade];
    const divergence = handTuned
      ? Math.round((empiricalMedian / handTuned - 1) * 10000) / 100
      : null;
    rows.push({
      year,
      family,
      grade,
      samples: mults.length,
      empiricalMedian: Math.round(empiricalMedian * 100) / 100,
      handTuned: handTuned ?? null,
      divergencePct: divergence,
      recommendation:
        divergence === null
          ? "NO_HAND_TUNED_CONSTANT"
          : Math.abs(divergence) < 15
            ? "KEEP_HAND_TUNED_CONSTANT"
            : `ADJUST_TO_${Math.round(empiricalMedian * 100) / 100}`,
    });
  }

  const proposal = {
    generatedAt: new Date().toISOString(),
    minSamplesThreshold: MIN_SAMPLES,
    bucketsAnalyzed: rows.length,
    bucketsSkippedInsufficient: buckets.size - rows.length,
    rows: rows.sort((a, b) =>
      (a.year + a.family + a.grade).localeCompare(b.year + b.family + b.grade),
    ),
    notes: [
      "Bucketed by (year × product family × grade).",
      "Empirical median = median of (grade_i.observedMedian / Raw.observedMedian) across joint observed captures.",
      "KEEP_HAND_TUNED_CONSTANT: hand-tuned is within 15% of empirical — no action.",
      "ADJUST_TO_X: hand-tuned differs >15% from empirical; consider swapping constant for the year+family bucket.",
      "NO_HAND_TUNED_CONSTANT: grade lacks a hand-tuned constant; empirical median IS the proposal.",
    ],
  };

  console.log(JSON.stringify(proposal, null, 2));
}

main().catch((err) => {
  console.error("[calibrate-grade-multipliers] FAILED:", err.message);
  console.error(err.stack);
  process.exit(2);
});
