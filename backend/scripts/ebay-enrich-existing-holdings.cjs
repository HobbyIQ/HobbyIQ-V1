#!/usr/bin/env node
// CF-EBAY-BROWSE-ENRICHMENT (2026-07-12).
//
// Enrich Drew's already-created 36 ebay-auto holdings with Browse API
// item specifics. For each holding:
//   1. Find its source purchase via sourcePurchaseId
//   2. Read purchase.ebayItemId (must have been backfilled first)
//   3. Fetch Browse item details (concurrent batch)
//   4. applyBrowseEnrichment(holding, details) — writes photos/aspects/
//      grader/grade/team/sport onto the holding
//
// Additive-only: never removes fields, never reassigns holding ids.
// Idempotent: safe to re-run.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const distSvc = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "ebay",
    "ebayItemDetails.service.js",
  );
  const distAuto = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "portfolioiq",
    "ebayAutoHolding.service.js",
  );
  const { fetchEbayItemDetailsBatch } = await import(pathToFileURL(distSvc).href);
  const { applyBrowseEnrichment } = await import(pathToFileURL(distAuto).href);

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolioC = client.database("hobbyiq").container("portfolio");

  const { resources } = await portfolioC.items.query({
    query: "SELECT * FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: USER_ID }],
  }).fetchAll();
  const doc = resources[0];
  if (!doc) throw new Error(`no portfolio doc for ${USER_ID}`);

  const holdingsMap = doc.holdings ?? {};
  const purchases = Array.isArray(doc.purchases) ? doc.purchases : [];
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));

  // Candidate set: ebay-auto holdings we haven't enriched yet.
  const candidates = Object.values(holdingsMap).filter(
    (h) => h.source === "ebay-auto" && !h.enrichedFromEbay,
  );
  console.log(`▶ ${candidates.length} ebay-auto holdings to enrich`);

  const items = [];
  for (const h of candidates) {
    const p = purchaseById.get(h.sourcePurchaseId);
    if (!p) {
      console.log(`  ⚠ holding ${h.id} — no source purchase found, skipping`);
      continue;
    }
    if (!p.ebayItemId) {
      console.log(`  ⚠ holding ${h.id} — purchase has no ebayItemId, skipping`);
      continue;
    }
    items.push({ holding: h, itemId: p.ebayItemId });
  }

  console.log(`▶ fetching Browse details for ${items.length} items...`);
  const itemIds = items.map((i) => i.itemId);
  const detailsList = await fetchEbayItemDetailsBatch(USER_ID, itemIds, 8);

  let enriched = 0;
  let no404 = 0;
  for (let i = 0; i < items.length; i++) {
    const details = detailsList[i];
    if (!details) {
      no404++;
      continue;
    }
    applyBrowseEnrichment(items[i].holding, details);
    enriched++;
  }

  console.log();
  console.log(`  enriched:   ${enriched}`);
  console.log(`  404 / gone: ${no404}`);
  console.log(`  skipped:    ${candidates.length - items.length}`);

  if (enriched === 0) {
    console.log(`▶ Nothing to write. Exiting.`);
    return;
  }

  doc.lastUpdated = new Date().toISOString();
  await portfolioC.item(doc.id, doc.userId).replace(doc);
  console.log(`▶ Wrote portfolio doc (partition ${doc.userId})`);

  // Sample verification
  const sample = Object.values(doc.holdings).filter((h) => h.enrichedFromEbay).slice(0, 5);
  console.log();
  console.log(`▶ Sample of 5 enriched holdings:`);
  for (const h of sample) {
    console.log(`  ${(h.playerName ?? "?").padEnd(22)}  team=${(h.team ?? "?").padEnd(18)}  grader=${h.gradeCompany ?? "?"}/${h.gradeValue ?? "?"}  isAuto=${h.isAuto ? "Y" : "N"}  photos=${(h.photos ?? []).length}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
