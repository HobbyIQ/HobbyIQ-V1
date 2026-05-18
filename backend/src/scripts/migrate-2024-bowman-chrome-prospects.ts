#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase B migration script — 2024 Bowman Chrome Prospects (Skenes anchor case).
 *
 * Runs the curation orchestrator restricted to one (year, brand) tuple:
 *   year = 2024
 *   brand = "Bowman Chrome Prospects"
 *
 * Default mode is a DRY RUN of the full pipeline:
 *   1. analyze:  staged → eligibility/2024__Bowman-Chrome-Prospects.json
 *   2. generate: eligibility → worksheets/2024__Bowman-Chrome-Prospects.json
 *
 * No Cosmos writes occur unless `--apply` is passed AND the worksheet's
 * `status` has been flipped to `"reviewed"` by the owner. Even with
 * `--apply`, the orchestrator routes through `applyWorksheet.ts` which
 * defaults to dry-run; the script forwards `apply: true` only when both
 * `--apply` and a non-empty `REVIEWED_BY` env var are supplied.
 *
 * Usage:
 *   node --experimental-strip-types backend/src/scripts/migrate-2024-bowman-chrome-prospects.ts
 *   REVIEWED_BY="owner-name" node ... migrate-2024-bowman-chrome-prospects.ts --apply
 *
 * Flags:
 *   --apply       Run apply phase. Default false.
 *   --force       Re-generate eligibility + worksheet files. Default false.
 */

import * as path from "node:path";
import { runOrchestrator } from "../curation/curationOrchestrator.js";
import {
  buildCosmosClient,
  getParallelsContainers,
} from "../services/parallelsReference/ingestion.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SWEEP_DIR = path.join(REPO_ROOT, "backend", "data", "beckett-sweep");
const OUT_DIR = path.join(REPO_ROOT, "backend", "data", "phase-b-curation", "2024-bowman-chrome-prospects");

const TARGET_YEAR = 2024;
const TARGET_BRAND = "Bowman Chrome Prospects";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const reviewedBy = process.env.REVIEWED_BY ?? "";

  if (apply && !reviewedBy) {
    console.error("[migrate-2024] --apply requires REVIEWED_BY env var");
    process.exit(2);
  }

  console.log(`[migrate-2024] sweep=${SWEEP_DIR}`);
  console.log(`[migrate-2024] out=${OUT_DIR}`);
  console.log(`[migrate-2024] year=${TARGET_YEAR} brand="${TARGET_BRAND}"`);
  console.log(`[migrate-2024] apply=${apply} force=${force}`);

  const phases = apply
    ? (["analyze", "generate", "apply"] as const)
    : (["analyze", "generate"] as const);

  let container = undefined;
  if (apply) {
    const client = buildCosmosClient();
    const containers = await getParallelsContainers(client);
    container = containers.parallelAttributes;
  }

  const summary = await runOrchestrator({
    sweepDir: SWEEP_DIR,
    outDir: OUT_DIR,
    years: [TARGET_YEAR],
    brands: [TARGET_BRAND],
    force,
    phases,
    cosmosContainer: container,
    apply,
    reviewedBy: apply ? reviewedBy : undefined,
  });

  console.log(`[migrate-2024] staged-files=${summary.stagedFilesFound}`);
  console.log(`[migrate-2024] analyzed=${summary.analyzedCount} eligible=${summary.eligibleCount}`);
  console.log(`[migrate-2024] worksheets-generated=${summary.worksheetsGeneratedCount}`);
  console.log(`[migrate-2024] errors=${summary.errorCount}`);
  for (const o of summary.outcomes) {
    if (o.error) console.log(`  ERROR ${o.set}: ${o.error}`);
    else if (o.skipped) console.log(`  skip  ${o.set} (${o.skippedReason})`);
    else if (o.worksheetGenerated) console.log(`  gen   ${o.set} → ${o.worksheetPath}`);
    else if (o.applyResult) {
      console.log(
        `  apply ${o.set} dry=${o.applyResult.dryRunCount} upserted=${o.applyResult.upsertedCount} errors=${o.applyResult.errorCount}`,
      );
    }
  }

  if (summary.errorCount > 0) {
    console.error(`[migrate-2024] FAILED with ${summary.errorCount} error(s)`);
    process.exit(1);
  }
  console.log("[migrate-2024] OK");
}

main().catch((err) => {
  console.error("[migrate-2024] fatal:", err);
  process.exit(1);
});
