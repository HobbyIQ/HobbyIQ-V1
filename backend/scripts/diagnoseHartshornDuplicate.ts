#!/usr/bin/env -S node --experimental-strip-types
// CF-EBAY-USER-PURCHASE-DUPE-DIAG (Drew, 2026-07-28).
// One-off. Dumps the FULL doc (including id, sourceExternalId,
// observedAt) for every sold_comps row at Hartshorn Blue Auto slug
// so we can see WHY two identical $608.30 rows persisted instead of
// upserting to one.

import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  const { resources } = await soldComps.items
    .query({
      query:
        "SELECT * FROM c WHERE c.hobbyiqCardId = @s ORDER BY c.observedAt DESC",
      parameters: [{ name: "@s", value: "hiq:baseball:2025:bowman-draft:cpa-jha:blue:auto" }],
    })
    .fetchAll();

  console.log(`\n▸ ${resources.length} rows at hiq:baseball:2025:bowman-draft:cpa-jha:blue:auto`);
  for (const r of resources as Array<Record<string, unknown>>) {
    console.log(`\n  ──────────────`);
    console.log(`  id:               ${r.id}`);
    console.log(`  source:           ${r.source}`);
    console.log(`  sourceExternalId: ${r.sourceExternalId}`);
    console.log(`  contentHash:      ${r.contentHash}`);
    console.log(`  cardId:           ${r.cardId}`);
    console.log(`  price:            ${r.price}`);
    console.log(`  soldAt:           ${r.soldAt}`);
    console.log(`  observedAt:       ${r.observedAt}`);
    console.log(`  contributorUserId:${r.contributorUserId}`);
    console.log(`  verifiedByUser:   ${r.verifiedByUser}`);
    console.log(`  parallel:         ${r.parallel}`);
    console.log(`  title:            ${r.title}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
