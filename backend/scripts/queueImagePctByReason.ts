#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");
  const { resources: t } = await q.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending'").fetchAll();
  const { resources: w } = await q.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND IS_STRING(c.input.imageUrl) AND LENGTH(c.input.imageUrl) > 5").fetchAll();
  const { resources: bySrc } = await q.items.query("SELECT c.input.source AS s, COUNT(1) AS n FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' GROUP BY c.input.source").fetchAll();
  console.log(`pending image-mismatch: ${t[0] ?? 0}`);
  console.log(`  with imageUrl:        ${w[0] ?? 0}  (${Math.round(((w[0] ?? 0) / (t[0] ?? 1)) * 100)}%)`);
  console.log(`\nby source:`);
  for (const r of bySrc as Array<{ s: string; n: number }>) console.log(`  ${(r.s ?? "?").padEnd(20)} ${r.n}`);
})();
