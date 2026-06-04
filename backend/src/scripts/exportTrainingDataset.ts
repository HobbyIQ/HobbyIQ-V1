#!/usr/bin/env -S node --experimental-strip-types
/**
 * CF-ML-MOAT GROUP C PHASE A (2026-06-04): training-dataset export script.
 *
 * Runs the prediction_log × prediction_outcomes join against live Cosmos
 * and prints summary counts + (optionally) the joined rows as NDJSON.
 *
 * Read-only. Never writes Cosmos. Phase A's deliverable is the schema +
 * shape; this script is the operator handle that turns "what's in the
 * corpus right now?" into a concrete artifact for review.
 *
 * Usage:
 *   node --experimental-strip-types backend/src/scripts/exportTrainingDataset.ts
 *   node --experimental-strip-types backend/src/scripts/exportTrainingDataset.ts --emit-rows
 *   node --experimental-strip-types backend/src/scripts/exportTrainingDataset.ts --emit-rows > dataset.ndjson
 *
 * Required env:
 *   COSMOS_ENDPOINT + (COSMOS_KEY | AAD creds), or COSMOS_CONNECTION_STRING
 *   COSMOS_DB / COSMOS_DATABASE                (default "hobbyiq")
 *   COSMOS_PREDICTION_LOG_CONTAINER            (default "prediction_log")
 *   COSMOS_PREDICTION_OUTCOMES_CONTAINER       (default "prediction_outcomes")
 *
 * Exit code: 0 on success (even if zero rows), 1 on Cosmos / runtime error.
 */

import { joinTrainingDataset } from "../services/mlTraining/trainingDatasetJoin.service.js";

const emitRows = process.argv.includes("--emit-rows");

async function main(): Promise<number> {
  const result = await joinTrainingDataset();

  if (emitRows) {
    for (const row of result.rows) {
      process.stdout.write(JSON.stringify(row) + "\n");
    }
  }

  // Summary always goes to stderr so it never pollutes --emit-rows NDJSON.
  process.stderr.write(
    JSON.stringify(
      {
        event: "training_dataset_join_summary",
        runAt: new Date().toISOString(),
        ...result.summary,
      },
      null,
      2,
    ) + "\n",
  );

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      JSON.stringify({
        event: "training_dataset_join_failed",
        error: err?.message ?? String(err),
      }) + "\n",
    );
    process.exit(1);
  });
