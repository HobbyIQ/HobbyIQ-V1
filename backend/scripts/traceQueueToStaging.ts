#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const db = c.database("hobbyiq");
  const q = db.container("verify_queue");
  const st = db.container("comps_staging");
  const sc = db.container("sold_comps");

  const { resources: rows } = await q.items.query({
    query: "SELECT TOP 3 c.id, c.input.cardId, c.input.imageUrl, c.input.playerName, c.input.title FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND c.input.sport = 'basketball' ORDER BY c.observedAt DESC",
  }).fetchAll();

  console.log(`▸ 3 recent basketball pending-manual rows:\n`);
  for (const r of rows as Array<{ id: string; cardId: string; imageUrl: string; playerName: string; title: string }>) {
    console.log(`  queue.id=${r.id}`);
    console.log(`  queue.cardId=${r.cardId}`);
    console.log(`  queue.imageUrl='${r.imageUrl}' (len=${(r.imageUrl ?? "").length})`);
    console.log(`  queue.title="${r.title}"`);
    // Trace back — find matching staging row by cardId
    // The staging row's raw.identityHint.vendorCardId matches sold_comps.cardId
    const { resources: stagingMatch } = await st.items.query({
      query: "SELECT TOP 1 c.id, c.status, c.raw.vendorPayload.imageUrl, c.raw.identityHint.vendorCardId FROM c WHERE c.raw.identityHint.vendorCardId = @cid ORDER BY c.observedAt DESC",
      parameters: [{ name: "@cid", value: r.cardId }],
    }).fetchAll();
    console.log(`  → staging row(s) matching this cardId:`);
    for (const s of stagingMatch as Array<Record<string, unknown>>) {
      console.log(`      status=${s.status}  vendorCardId=${s.vendorCardId}  imageUrl='${s.imageUrl}' (len=${(String(s.imageUrl ?? "")).length})`);
    }
    // Also check sold_comps
    try {
      const { resources: scMatch } = await sc.items.query({
        query: "SELECT TOP 1 c.imageUrl, c.title, c.sport FROM c WHERE c.cardId = @cid",
        parameters: [{ name: "@cid", value: r.cardId }],
      }, { partitionKey: r.cardId }).fetchAll();
      console.log(`  → sold_comps has:`);
      for (const s of scMatch as Array<{ imageUrl: string; title: string; sport: string }>) {
        console.log(`      sport=${s.sport}  imageUrl='${String(s.imageUrl ?? "").slice(0, 80)}' (len=${(String(s.imageUrl ?? "")).length})`);
      }
    } catch (e) { console.log(`  → sold_comps query err: ${(e as Error).message}`); }
    console.log("");
  }
})();
