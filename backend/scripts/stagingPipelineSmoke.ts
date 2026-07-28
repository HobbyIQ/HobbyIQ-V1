#!/usr/bin/env -S npx tsx
// CF-STAGING-SMOKE (Drew, 2026-07-28). Fire one CH sales fetch that
// exercises the shim end-to-end so we can prove the pipeline works
// without waiting for the nightly cron.
//
// Uses the standard client's persistIdentity hook — same code path
// as real user-driven ingest. Then queries the staging container to
// verify a row landed.

import { getCardSales } from "../src/services/compiq/cardhedge.client.js";
import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const targetCardId = process.argv[2] ?? "1778542140951x283396404010038530";  // Hartman Blue Refractor Auto (has a known CH cardId)
  console.log(`▸ Firing getCardSales for cardId=${targetCardId}`);
  const beforeCount = await stagingCount();
  console.log(`  staging count BEFORE: ${beforeCount}`);

  const sales = await getCardSales(targetCardId, "Raw", 20, {
    persistIdentity: {
      playerName: "Eric Hartman",
      cardYear: 2026,
      sport: "baseball",
    },
  });
  console.log(`  CH returned ${sales.length} sales`);
  if (sales.length > 0) {
    console.log(`  first sale: $${sales[0].price} @ ${sales[0].date}  title="${(sales[0].title ?? "").slice(0, 60)}"  image=${sales[0].image_url ? "yes" : "no"}`);
  }

  // Give the fire-and-forget writes a moment to land.
  console.log(`  waiting 8s for background writes...`);
  await new Promise((r) => setTimeout(r, 8000));

  const afterCount = await stagingCount();
  console.log(`  staging count AFTER:  ${afterCount}`);
  console.log(`  net new staging rows: ${afterCount - beforeCount}`);

  if (afterCount > beforeCount) {
    const latest = await latestStagingRows(3);
    console.log(`\n  latest 3 staging rows:`);
    for (const row of latest) {
      console.log(`    id=${row.id}`);
      console.log(`      slug=${row.hobbyiqCardId}  status=${row.status}  vendor=${row.raw?.vendor}`);
      console.log(`      title="${String(row.raw?.vendorPayload?.title ?? "").slice(0, 70)}"`);
      console.log(`      mirroredImage: ${row.mirroredImage?.blobUrl ? "✓ " + row.mirroredImage.blobUrl : "✗"}${row.mirroredImage?.mirrorError ? " ERROR:" + JSON.stringify(row.mirroredImage.mirrorError) : ""}`);
    }
  }
}

async function stagingCount(): Promise<number> {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const st = c.database("hobbyiq").container("comps_staging");
  const { resources } = await st.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll();
  return resources[0] ?? 0;
}

interface StagingRow {
  id: string;
  hobbyiqCardId: string;
  status: string;
  raw?: { vendor?: string; vendorPayload?: { title?: string } };
  mirroredImage?: { blobUrl?: string; mirrorError?: unknown };
}

async function latestStagingRows(n: number): Promise<StagingRow[]> {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const st = c.database("hobbyiq").container("comps_staging");
  const { resources } = await st.items.query<StagingRow>({
    query: "SELECT TOP @n c.id, c.hobbyiqCardId, c.status, c.raw, c.mirroredImage FROM c ORDER BY c.observedAt DESC",
    parameters: [{ name: "@n", value: n }],
  }).fetchAll();
  return resources;
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
