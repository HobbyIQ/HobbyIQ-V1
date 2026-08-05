#!/usr/bin/env -S npx tsx
/**
 * Force ALL of Drew's holdings through single-holding refresh so
 * every one hits the unified pricing early-exit (or falls through
 * to the guarded legacy path). Batch reprice loop has extra sibling-
 * rescue branches that can produce wrong numbers for cards with real
 * pool data (Cam Caminiti Blue Refractor: real pool median $160,
 * sibling rescue produced $18).
 */
import { CosmosClient } from "@azure/cosmos";
import { repriceOneHolding } from "../src/services/portfolioiq/portfolioStore.service.js";

const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main(): Promise<void> {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const db = client.database("hobbyiq");
  const { resource: doc } = await db.container("portfolio").item(USER_ID, USER_ID).read();
  const holdings = Object.values(doc.holdings ?? {}) as Array<{ id: string; playerName?: string; cardStatus?: string }>;

  console.log(`Refreshing ${holdings.length} holdings for ${USER_ID}...`);
  let success = 0, skipped = 0, failed = 0;
  for (const h of holdings) {
    if (h.cardStatus === "pending-review") {
      console.log(`  SKIP ${h.id.slice(0, 8)} ${h.playerName ?? "?"} (pending-review)`);
      skipped++;
      continue;
    }
    const ok = await repriceOneHolding(USER_ID, h.id);
    console.log(`  ${ok ? "OK  " : "FAIL"} ${h.id.slice(0, 8)} ${h.playerName ?? "?"}`);
    if (ok) success++; else failed++;
  }
  console.log(`\nDone: ${success} refreshed, ${skipped} skipped, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
