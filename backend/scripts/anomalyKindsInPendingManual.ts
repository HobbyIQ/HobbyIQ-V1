#!/usr/bin/env -S node --experimental-strip-types
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const st = c.database("hobbyiq").container("comps_staging");
  const { resources } = await st.items.query({
    query: "SELECT TOP 100 c.id, c.clean.anomalies, c.raw.vendorPayload.title, c.clean.parallel FROM c WHERE c.status = 'pending-manual'",
  }).fetchAll();
  const kinds = new Map<string, number>();
  for (const r of resources as Array<{ anomalies?: Array<{ kind: string }> }>) {
    for (const a of (r.anomalies ?? [])) {
      kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    }
    if ((r.anomalies?.length ?? 0) === 0) {
      kinds.set("(no anomalies)", (kinds.get("(no anomalies)") ?? 0) + 1);
    }
  }
  console.log(`▸ anomaly kinds on 100 sampled pending-manual rows:`);
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(35)} ${v}`);
  }
  console.log(`\n▸ 5 sample rows with their anomaly + parallel:`);
  for (const r of (resources as Array<Record<string, unknown>>).slice(0, 5)) {
    const anomalies = ((r.anomalies as Array<{ kind: string; detail?: string }>) ?? []).map(a => a.kind).join(",");
    console.log(`  parallel=${(r.parallel ?? "?").toString().padEnd(20)} anomalies=[${anomalies.padEnd(50)}] title="${String(r.title).slice(0, 70)}"`);
  }
})();
