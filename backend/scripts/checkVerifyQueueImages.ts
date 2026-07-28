#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");
  const { resources: all } = await q.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending'").fetchAll();
  const { resources: withImg } = await q.items.query<number>("SELECT VALUE COUNT(1) FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND IS_STRING(c.input.imageUrl) AND LENGTH(c.input.imageUrl) > 5").fetchAll();
  console.log(`image-mismatch pending:            ${all[0] ?? 0}`);
  console.log(`  with imageUrl populated:         ${withImg[0] ?? 0}`);
  console.log(`  without / empty imageUrl:        ${(all[0] ?? 0) - (withImg[0] ?? 0)}`);
  const { resources: sample } = await q.items.query({ query: "SELECT TOP 5 c.id, c.input.playerName, c.input.imageUrl, c.input.url, c.input.title FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' ORDER BY c.observedAt DESC" }).fetchAll();
  console.log(`\nsample:`);
  for (const r of sample as Array<Record<string, unknown>>) {
    console.log(`  ${r.playerName}: img=${(r.imageUrl ? String(r.imageUrl).slice(0, 60) : "(none)")} url=${(r.url ? String(r.url).slice(0, 60) : "(none)")}`);
  }
})();
