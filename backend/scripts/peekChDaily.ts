#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const c = client.database("hobbyiq").container("ch_daily_sales");
  const { resources } = await c.items.query("SELECT TOP 3 * FROM c").fetchAll();
  for (const r of resources) console.log(JSON.stringify(r, null, 2).slice(0, 900) + "\n---");

  // Search Hartman by player-in-title heuristics
  console.log("\n▸ Hartman name/title probes:");
  for (const [label, q] of [
    ["title CONTAINS Hartman", "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(UPPER(c.title ?? ''), 'HARTMAN')"],
    ["card_set CONTAINS Hartman", "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(UPPER(c.card_set ?? ''), 'HARTMAN')"],
    ["player CONTAINS Hartman", "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(UPPER(c.player ?? ''), 'HARTMAN')"],
    ["playerName CONTAINS Hartman", "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(UPPER(c.playerName ?? ''), 'HARTMAN')"],
    ["cardNumber = CPA-EHA", "SELECT VALUE COUNT(1) FROM c WHERE UPPER(c.cardNumber ?? '') = 'CPA-EHA'"],
    ["number = CPA-EHA", "SELECT VALUE COUNT(1) FROM c WHERE UPPER(c.number ?? '') = 'CPA-EHA'"],
    ["title CONTAINS CPA-EHA", "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(UPPER(c.title ?? ''), 'CPA-EHA')"],
  ]) {
    try {
      const { resources: r } = await c.items.query(q).fetchAll();
      console.log(`  ${label.padEnd(40)}  ${r[0] ?? "err"}`);
    } catch (e) {
      console.log(`  ${label.padEnd(40)}  ERROR: ${(e as Error)?.message ?? e}`);
    }
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
