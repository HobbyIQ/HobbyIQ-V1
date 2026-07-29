#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");
  const { resources } = await q.items.query({
    query: "SELECT TOP 20 c.input.title, c.input.parallel, c.input.playerName FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND c.input.sport = 'baseball' ORDER BY c.observedAt DESC",
  }).fetchAll();
  console.log(`▸ 20 recent baseball pending-manual titles + stored parallel:\n`);
  for (const r of resources as Array<{ title: string; parallel: string; playerName: string }>) {
    console.log(`  parallel=${String(r.parallel).padEnd(20)} title="${String(r.title).slice(0, 100)}"`);
  }
})();
