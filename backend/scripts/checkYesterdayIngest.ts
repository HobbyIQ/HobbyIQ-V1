#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
async function main(): Promise<void> {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const sc = c.database("hobbyiq").container("sold_comps");
  const yStart = "2026-07-27T00:00:00Z";
  const yEnd   = "2026-07-28T00:00:00Z";
  for (const src of ["cardhedge", "cardsight", "ebay-user-purchase"]) {
    const { resources } = await sc.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = @s AND c.soldAt >= @a AND c.soldAt < @b",
      parameters: [{ name: "@s", value: src }, { name: "@a", value: yStart }, { name: "@b", value: yEnd }],
    }).fetchAll();
    console.log(`  ${src.padEnd(24)}  ${resources[0]}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
