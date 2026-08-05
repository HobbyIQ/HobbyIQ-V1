#!/usr/bin/env -S npx tsx
/**
 * One-off: force Bobby Witt through the single-holding refresh path
 * so the unified early-exit fires and writes the trend-lifted number
 * from real BGS 9.5 comps instead of the stale $6.92 our-pool wrote
 * before the cost-basis floor landed.
 */
import { CosmosClient } from "@azure/cosmos";
import { repriceOneHolding } from "../src/services/portfolioiq/portfolioStore.service.js";

const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const HOLDING_ID = "2480a6bf-90c7-490b-9cfb-7594c3583b8d";

async function main(): Promise<void> {
  console.log(`Refreshing Bobby Witt (${HOLDING_ID}) via autoPriceHolding...`);
  const ok = await repriceOneHolding(USER_ID, HOLDING_ID);
  console.log(`Result: ${ok ? "success" : "failed"}`);
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const db = client.database("hobbyiq");
  const { resource: doc } = await db.container("portfolio").item(USER_ID, USER_ID).read();
  const h = doc.holdings[HOLDING_ID];
  console.log("After refresh:");
  for (const k of ["fairMarketValue","estimatedValue","estimateBasis","valuationStatus","pricingSource","lastUpdated"] as const) {
    console.log(`  ${k}: ${JSON.stringify(h[k])}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
