#!/usr/bin/env -S npx tsx
/**
 * CF-DRAIN-STAGING (Drew, 2026-08-06).
 *
 * Runs data-clean + promotion in a loop to work through the
 * comps_staging pending backlog. Bounded by iteration count so it
 * can't run forever.
 *
 * As of 2026-08-06 01:15 UTC: 5.91M pending in comps_staging while
 * TCA webhook pushes ~92K/hour. Data-clean + promotion aren't
 * scheduled anywhere, so the backlog just grows.
 *
 * Env:
 *   MAX_ITERATIONS   default 30
 *   BATCH_LIMIT      default 500 (fed to each of data-clean + promotion)
 */

import { runDataCleanBatch } from "../src/services/portfolioiq/dataCleanJob.service.js";
import { runPromotionBatch } from "../src/services/portfolioiq/promotionJob.service.js";
import { CosmosClient } from "@azure/cosmos";

const MAX_ITER = process.env.MAX_ITERATIONS ? Number(process.env.MAX_ITERATIONS) : 30;
const LIMIT = process.env.BATCH_LIMIT ? Number(process.env.BATCH_LIMIT) : 500;
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

async function statusCounts(): Promise<Record<string, number>> {
  const client = new CosmosClient(conn as string);
  const staging = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("comps_staging");
  const statuses = ["pending", "clean", "anomaly", "verified", "pending-manual", "promoted"];
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    const { resources } = await staging.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = @s",
      parameters: [{ name: "@s", value: s }],
    }).fetchAll();
    counts[s] = resources[0] ?? 0;
  }
  return counts;
}

async function main(): Promise<void> {
  console.log(`▸ Drain comps_staging — MAX_ITER=${MAX_ITER}  BATCH_LIMIT=${LIMIT}`);
  const before = await statusCounts();
  console.log(`  BEFORE: ${JSON.stringify(before)}`);
  const startedAt = Date.now();

  let totalCleaned = 0, totalPromoted = 0, totalScannedClean = 0, totalScannedPromo = 0;
  for (let i = 1; i <= MAX_ITER; i++) {
    try {
      const dc = await runDataCleanBatch({ limit: LIMIT });
      totalScannedClean += dc.scanned ?? 0;
      totalCleaned += (dc.markedClean ?? 0);
    } catch (e) {
      console.error(`  ! data-clean iter ${i} failed: ${(e as Error).message}`);
    }
    try {
      const pr = await runPromotionBatch({ limit: LIMIT });
      totalScannedPromo += pr.scanned ?? 0;
      totalPromoted += (pr.promoted ?? 0);
    } catch (e) {
      console.error(`  ! promotion iter ${i} failed: ${(e as Error).message}`);
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    process.stderr.write(`  iter ${i}/${MAX_ITER}  cleaned=${totalCleaned} promoted=${totalPromoted}  ${elapsed}s\r`);
  }
  console.log("");

  const after = await statusCounts();
  console.log(`\n▸ Summary`);
  console.log(`  BEFORE: ${JSON.stringify(before)}`);
  console.log(`  AFTER:  ${JSON.stringify(after)}`);
  console.log(`  delta pending:   ${(after.pending - before.pending).toLocaleString()}`);
  console.log(`  delta clean:     ${(after.clean - before.clean).toLocaleString()}`);
  console.log(`  delta promoted:  ${(after.promoted - before.promoted).toLocaleString()}`);
  console.log(`  delta anomaly:   ${(after.anomaly - before.anomaly).toLocaleString()}`);
  console.log(`  totalCleaned reported: ${totalCleaned.toLocaleString()}`);
  console.log(`  totalPromoted reported: ${totalPromoted.toLocaleString()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
