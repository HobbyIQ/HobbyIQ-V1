#!/usr/bin/env node
// CF-SOURCE-VENDOR (2026-07-13): backfill sourceVendor="cardhedge" on every
// holding across every user that has a fairMarketValue but no vendor
// provenance. Every priced holding today was CH-sourced (Cardsight
// removed 2026-06-27; eBay-direct not wired yet) so the stamp is safe
// and idempotent.

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolio = client.database("hobbyiq").container("portfolio");

  const { resources } = await portfolio.items.query({
    query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)",
  }).fetchAll();

  console.log(`▶ ${resources.length} portfolio docs to scan`);
  const nowIso = new Date().toISOString();
  let usersUpdated = 0;
  let holdingsStamped = 0;
  let holdingsAlreadyStamped = 0;
  let holdingsNoFmv = 0;

  for (const doc of resources) {
    const holdings = Object.values(doc.holdings ?? {});
    let mutated = false;
    for (const h of holdings) {
      const hasFmv = typeof h.fairMarketValue === "number" && h.fairMarketValue > 0;
      if (!hasFmv) { holdingsNoFmv += 1; continue; }
      if (h.sourceVendor) { holdingsAlreadyStamped += 1; continue; }
      h.sourceVendor = "cardhedge";
      h.sourceVendorUpdatedAt = nowIso;
      holdingsStamped += 1;
      mutated = true;
    }
    if (mutated) {
      doc.lastUpdated = nowIso;
      await portfolio.item(doc.id, doc.userId).replace(doc);
      usersUpdated += 1;
    }
  }

  console.log();
  console.log(`  users updated:         ${usersUpdated}`);
  console.log(`  holdings stamped:      ${holdingsStamped}`);
  console.log(`  already stamped:       ${holdingsAlreadyStamped}`);
  console.log(`  no FMV (skipped):      ${holdingsNoFmv}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
