#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
const sc = c.database("hobbyiq").container("sold_comps");
const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
(async () => {
  const { resources } = await sc.items.query({
  query: "SELECT c.parallel, c.price, c.source, c.hobbyiqCardId FROM c WHERE UPPER(c.cardNumber ?? '') = 'CPA-EHA' AND c.soldAt >= @cutoff",
  parameters: [{ name: "@cutoff", value: cutoff }],
}).fetchAll();
console.log(`Total CPA-EHA rows last 180d: ${resources.length}`);
const bySrc: Record<string, number> = {};
for (const r of resources) bySrc[r.source ?? "?"] = (bySrc[r.source ?? "?"] ?? 0) + 1;
for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(24)}  ${n}`);
})();
