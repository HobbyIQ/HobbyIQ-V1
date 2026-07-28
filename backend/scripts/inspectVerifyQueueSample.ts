#!/usr/bin/env -S node --experimental-strip-types
// Inspect what's actually in the pending-manual queue: sport breakdown,
// image URL check, listing URL check, sample rows.
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");

  // Sport distribution
  const { resources: bySport } = await q.items.query({
    query: "SELECT c.input.sport AS sport, COUNT(1) AS n FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' GROUP BY c.input.sport",
  }).fetchAll();
  console.log(`▸ pending-manual by sport:`);
  for (const r of bySport as Array<{ sport: string; n: number }>) {
    console.log(`  ${(r.sport ?? "(null)").padEnd(15)} ${r.n}`);
  }

  // Full detail on 3 random rows so we can see what's actually there
  const { resources: sample } = await q.items.query({
    query: "SELECT TOP 3 * FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' ORDER BY c.observedAt DESC",
  }).fetchAll();
  console.log(`\n▸ Full sample rows (what the UI sees):`);
  for (const r of sample as Array<{ id: string; input: Record<string, unknown>; signal?: Record<string, unknown> }>) {
    console.log(`\n  id=${r.id}`);
    console.log(`  input.playerName=${r.input.playerName}`);
    console.log(`  input.imageUrl=${r.input.imageUrl}`);
    console.log(`  input.url=${r.input.url}`);
    console.log(`  input.title=${r.input.title}`);
    console.log(`  input.sport=${r.input.sport}`);
    console.log(`  input.source=${r.input.source}`);
    console.log(`  signal.note=${r.signal?.note}`);
  }
})();
