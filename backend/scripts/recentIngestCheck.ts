#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const sc = c.database("hobbyiq").container("sold_comps");
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { resources } = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.observedAt >= @cutoff",
    parameters: [{ name: "@cutoff", value: thirtyMinAgo }],
  }).fetchAll();
  console.log(`sold_comps writes in last 30min:  ${resources[0] ?? 0}`);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { resources: h } = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.observedAt >= @cutoff",
    parameters: [{ name: "@cutoff", value: oneHourAgo }],
  }).fetchAll();
  console.log(`sold_comps writes in last 1hr:    ${h[0] ?? 0}`);
})();
