#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const db = c.database("hobbyiq");
  const q = db.container("verify_queue");
  const st = db.container("comps_staging");
  const sc = db.container("sold_comps");

  const { resources: qrows } = await q.items.query({
    query: "SELECT TOP 3 c.id, c.input.title, c.input.imageUrl, c.input.cardId FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND CONTAINS(UPPER(c.input.playerName), 'HAMMOND') ORDER BY c.observedAt DESC",
  }).fetchAll();
  console.log(`▸ Hammond queue rows:`);
  for (const r of qrows as Array<Record<string, unknown>>) {
    console.log(`\n  queue: title="${String(r.title).slice(0, 70)}"`);
    console.log(`  queue.cardId=${r.cardId}`);
    console.log(`  queue.imageUrl='${r.imageUrl}' (len=${(r.imageUrl ?? "").length})`);
    // Find matching staging
    const { resources: staged } = await st.items.query({
      query: "SELECT TOP 2 c.id, c.hobbyiqCardId, c.raw.vendorPayload.imageUrl, c.raw.vendorPayload.url FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.observedAt DESC",
      parameters: [{ name: "@slug", value: r.cardId }],
    }).fetchAll();
    for (const s of staged as Array<Record<string, unknown>>) {
      console.log(`    staging.imageUrl='${s.imageUrl}' url='${s.url}'`);
    }
    // Find matching sold_comps by slug (cross-partition)
    const { resources: scRows } = await sc.items.query({
      query: "SELECT TOP 2 c.imageUrl, c.title, c.source FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.observedAt DESC",
      parameters: [{ name: "@slug", value: r.cardId }],
    }).fetchAll();
    for (const s of scRows as Array<Record<string, unknown>>) {
      console.log(`    sold_comps.imageUrl='${String(s.imageUrl ?? "").slice(0, 80)}' source=${s.source}`);
    }
  }
})();
