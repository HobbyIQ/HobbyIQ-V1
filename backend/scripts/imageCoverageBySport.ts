#!/usr/bin/env -S node --experimental-strip-types
// How much of the sold_comps pool has imageUrl by sport
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const sc = c.database("hobbyiq").container("sold_comps");
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  console.log(`▸ imageUrl coverage on sold_comps (last 30d) by sport:\n`);
  for (const sport of ["baseball", "basketball", "football", "hockey"]) {
    const { resources: total } = await sc.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.sport = @s AND c.soldAt >= @cutoff",
      parameters: [{ name: "@s", value: sport }, { name: "@cutoff", value: cutoff }],
    }).fetchAll();
    const { resources: withImg } = await sc.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.sport = @s AND c.soldAt >= @cutoff AND IS_STRING(c.imageUrl) AND LENGTH(c.imageUrl) > 5",
      parameters: [{ name: "@s", value: sport }, { name: "@cutoff", value: cutoff }],
    }).fetchAll();
    const t = total[0] ?? 0;
    const w = withImg[0] ?? 0;
    const pct = t > 0 ? Math.round((w / t) * 100) : 0;
    console.log(`  ${sport.padEnd(12)} total=${String(t).padStart(6)}  withImage=${String(w).padStart(6)}  ${pct}%`);
  }
})();
