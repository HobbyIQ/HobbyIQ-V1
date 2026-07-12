#!/usr/bin/env node
// CF-EBAY-REVIEW-QUEUE (2026-07-12).
//
// One-shot migration: move Drew's 36 ebay-auto holdings from
// cardStatus="active" to cardStatus="pending-review" so he goes through
// the same review flow every future user will use. Preserves everything
// else on the holding (photos, aspects, cost basis, source purchase
// linkage) so confirming is a review-and-approve, not re-entry.
//
// Idempotent — re-runs skip holdings already in pending-review.

const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolioC = client.database("hobbyiq").container("portfolio");

  const { resources } = await portfolioC.items.query({
    query: "SELECT * FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: USER_ID }],
  }).fetchAll();
  const doc = resources[0];
  if (!doc) throw new Error(`no portfolio doc for ${USER_ID}`);

  const holdings = Object.values(doc.holdings ?? {});
  const ebayAuto = holdings.filter((h) => h.source === "ebay-auto");
  const alreadyPending = ebayAuto.filter((h) => h.cardStatus === "pending-review");
  const toMigrate = ebayAuto.filter((h) => h.cardStatus !== "pending-review");

  console.log(`▶ ebay-auto holdings: ${ebayAuto.length}`);
  console.log(`  already pending-review: ${alreadyPending.length}`);
  console.log(`  to migrate:             ${toMigrate.length}`);

  if (toMigrate.length === 0) {
    console.log(`▶ Nothing to do. Exiting.`);
    return;
  }

  const nowIso = new Date().toISOString();
  for (const h of toMigrate) {
    h.cardStatus = "pending-review";
    h.needsReview = true;   // downstream badge writer keys on this
    h.migratedToReviewQueueAt = nowIso;
    h.lastUpdated = nowIso;
  }

  doc.lastUpdated = nowIso;
  await portfolioC.item(doc.id, doc.userId).replace(doc);
  console.log(`▶ Wrote portfolio doc — ${toMigrate.length} holdings migrated to pending-review`);
}
main().catch((e) => { console.error(e); process.exit(1); });
