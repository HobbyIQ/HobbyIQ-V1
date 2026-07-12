#!/usr/bin/env node
// CF-EBAY-BROWSE-ENRICHMENT (2026-07-12).
//
// Backfill ebayItemId on Drew's existing 39 ebay-source purchases.
// The Trading API returns OrderLineItemID as "itemId-txnId"; the itemId
// is everything before the first "-". We persist the raw itemId so
// downstream Browse API calls don't have to re-split every time.
//
// Idempotent: purchases that already have ebayItemId are skipped.

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

function extractItemIdFromOrderId(orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  const dash = orderId.indexOf("-");
  const raw = dash > 0 ? orderId.slice(0, dash) : orderId;
  // Must be all digits (eBay legacy item ids are numeric).
  return /^\d+$/.test(raw) ? raw : null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolioC = client.database("hobbyiq").container("portfolio");

  const { resources } = await portfolioC.items.query({
    query: "SELECT * FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: USER_ID }],
  }).fetchAll();
  const doc = resources[0];
  if (!doc) throw new Error(`no portfolio doc for ${USER_ID}`);

  const purchases = Array.isArray(doc.purchases) ? doc.purchases : [];
  const ebayPurchases = purchases.filter((p) => p.source === "ebay");
  console.log(`▶ Found ${ebayPurchases.length} eBay purchases`);

  let backfilled = 0;
  let alreadySet = 0;
  let unresolved = 0;
  for (const p of ebayPurchases) {
    if (p.ebayItemId) {
      alreadySet++;
      continue;
    }
    const id = extractItemIdFromOrderId(p.ebayOrderId);
    if (id) {
      p.ebayItemId = id;
      backfilled++;
    } else {
      unresolved++;
      console.log(`  ⚠ unresolved: purchaseId=${p.id} orderId=${p.ebayOrderId}`);
    }
  }

  console.log();
  console.log(`  already set:  ${alreadySet}`);
  console.log(`  backfilled:   ${backfilled}`);
  console.log(`  unresolved:   ${unresolved}`);

  if (backfilled === 0) {
    console.log(`▶ Nothing to write. Exiting.`);
    return;
  }

  // Preserve _etag if present.
  doc.lastUpdated = new Date().toISOString();
  await portfolioC.item(doc.id, doc.userId).replace(doc);
  console.log(`▶ Wrote portfolio doc (partition ${doc.userId})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
