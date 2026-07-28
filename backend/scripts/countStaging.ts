#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const db = c.database("hobbyiq");
  const st = db.container("comps_staging");
  const { resources: totalRes } = await st.items.query("SELECT VALUE COUNT(1) FROM c").fetchAll();
  console.log(`comps_staging total:            ${totalRes[0] ?? 0}`);
  const { resources: byStatus } = await st.items.query("SELECT c.status, COUNT(1) AS n FROM c GROUP BY c.status").fetchAll();
  console.log(`\nby status:`);
  for (const r of byStatus as Array<{ status: string; n: number }>) console.log(`  ${(r.status ?? "(null)").padEnd(20)} ${r.n}`);
  const { resources: byVendor } = await st.items.query("SELECT c.raw.vendor AS vendor, COUNT(1) AS n FROM c GROUP BY c.raw.vendor").fetchAll();
  console.log(`\nby vendor:`);
  for (const r of byVendor as Array<{ vendor: string; n: number }>) console.log(`  ${(r.vendor ?? "(null)").padEnd(20)} ${r.n}`);
  const { resources: withMirror } = await st.items.query("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.mirroredImage)").fetchAll();
  console.log(`\nwith mirrored image:             ${withMirror[0] ?? 0}`);
  const { resources: withMirrorSuccess } = await st.items.query("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.mirroredImage) AND NOT IS_DEFINED(c.mirroredImage.mirrorError)").fetchAll();
  console.log(`with mirrored image (success):   ${withMirrorSuccess[0] ?? 0}`);
  const { resources: withMirrorErr } = await st.items.query("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.mirroredImage.mirrorError)").fetchAll();
  console.log(`with mirror error:               ${withMirrorErr[0] ?? 0}`);
  const { resources: recent } = await st.items.query("SELECT TOP 3 c.id, c.hobbyiqCardId, c.raw.vendor, c.raw.vendorPayload.title, c.observedAt, IS_DEFINED(c.mirroredImage) AS hasImage FROM c ORDER BY c.observedAt DESC").fetchAll();
  console.log(`\nlast 3 rows:`);
  for (const r of recent as Array<Record<string, unknown>>) console.log(`  ${r.observedAt}  ${r.vendor}  ${String(r.title ?? "").slice(0, 60)}  hasImage=${r.hasImage}`);
})();
