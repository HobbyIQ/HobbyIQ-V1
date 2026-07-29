#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");
  // Look at ALL statuses for image-mismatch reason
  const { resources } = await q.items.query({
    query: "SELECT TOP 10 c.input.title, c.input.parallel, c.input.playerName, c.input.sport FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND c.input.parallel IN ('blue', 'Blue') ORDER BY c.observedAt DESC",
  }).fetchAll();
  console.log(`▸ Queue rows with stored parallel='blue' (10 samples):`);
  for (const r of resources as Array<{ title: string; parallel: string; playerName: string; sport: string }>) {
    console.log(`  ${r.sport?.padEnd(12)} ${String(r.playerName).padEnd(25)} title="${String(r.title).slice(0, 80)}"`);
  }
  console.log(`\n▸ Count of pending image-mismatch by stored parallel (top 15):`);
  const { resources: byPar } = await q.items.query({
    query: "SELECT c.input.parallel AS p, COUNT(1) AS n FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' GROUP BY c.input.parallel",
  }).fetchAll();
  for (const r of (byPar as Array<{ p: string; n: number }>).sort((a, b) => b.n - a.n).slice(0, 15)) {
    console.log(`  ${(r.p ?? "?").padEnd(30)} ${r.n}`);
  }
})();
