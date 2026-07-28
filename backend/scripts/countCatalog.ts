#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const cat = c.database("hobbyiq").container("card_catalog");
  const { resources: total } = await cat.items.query("SELECT VALUE COUNT(1) FROM c").fetchAll();
  console.log(`total catalog entries:  ${total[0]}`);
  const { resources: withImage } = await cat.items.query("SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.referenceImage)").fetchAll();
  console.log(`entries with image URL: ${withImage[0]}`);
})();
