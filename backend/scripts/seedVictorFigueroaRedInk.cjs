/*
 * Seed script for Victor Figueroa 2026 Bowman Chrome Black & White Red Ink SSP:
 *   1) card_catalog entry for the specific parallel slug
 *   2) sold_comps entry backfilling Drew's $278.60 eBay purchase from 2026-06-11
 *
 * The eBay-auto import pathway didn't persist his purchase as a comp, and no
 * catalog entry existed for the Red Ink SSP variant — result: pricing engine
 * fell through to a fuzzy-match dilution pool and returned $1.89 for a $278
 * card. This seed puts both records in place so unified pricing has a real
 * anchor (Drew's own purchase + a resolvable catalog identity).
 *
 * Idempotent: uses deterministic ids and .upsert().
 */
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const now = new Date().toISOString();

  const HIQ_CARD_ID = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto";
  const DREW_USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
  const PURCHASE_PRICE = 278.60;
  const PURCHASE_DATE = "2026-06-11T00:00:00.000Z";
  const EBAY_ITEM_ID = "victor-figueroa-red-ink-drew"; // sourcePurchaseId proxy

  // 1) card_catalog upsert
  const catalog = db.container("card_catalog");
  const catalogDoc = {
    id: HIQ_CARD_ID,
    cardId: HIQ_CARD_ID,
    hobbyiqCardId: HIQ_CARD_ID,
    sport: "baseball",
    year: 2026,
    setKey: "bowman-chrome",
    setName: "Bowman Chrome",
    set: "Bowman Chrome",
    cardNumber: "CPA-VF",
    number: "CPA-VF",
    parallel: "Black & White Red Ink",
    parallelSlug: "black-white-red-ink",
    isAuto: true,
    printRun: null,
    isSsp: true,
    variantNotes: "Unnumbered Super Short Print (SSP). Black & White Shimmer base with Red Ink autograph. Rarer than the numbered /5 Red parallels.",
    playerName: "Victor Figueroa",
    player: "Victor Figueroa",
    playerSlug: "victor-figueroa",
    vendorIds: {},
    source: "seed",
    confidence: 0.95,
    observedAt: now,
    lastSeenAt: now,
    searchText: "victor figueroa cpa-vf 2026 bowman chrome black white red ink ssp",
    searchTokens: ["victor", "figueroa", "cpa-vf", "cpa", "vf", "2026", "bowman", "chrome", "black", "white", "red", "ink", "ssp", "auto"],
  };
  const catResp = await catalog.items.upsert(catalogDoc);
  console.log(`card_catalog upsert -> ${catResp.statusCode}, id=${catalogDoc.id}`);

  // 2) sold_comps entry for Drew's purchase
  const sold = db.container("sold_comps");
  const contentHash = crypto.createHash("sha256")
    .update(`${HIQ_CARD_ID}|${PURCHASE_PRICE}|${PURCHASE_DATE.slice(0, 10)}|ebay-user-purchase|${EBAY_ITEM_ID}`)
    .digest("hex")
    .slice(0, 40);
  const compDoc = {
    id: `ebay-user-purchase::retroactive::${DREW_USER_ID.slice(-8)}::${EBAY_ITEM_ID}`,
    cardId: HIQ_CARD_ID,
    hobbyiqCardId: HIQ_CARD_ID,
    playerName: "Victor Figueroa",
    cardYear: 2026,
    setName: "Bowman Chrome",
    parallel: "Black & White Red Ink",
    cardNumber: "CPA-VF",
    isAuto: true,
    sport: "baseball",
    gradeCompany: null,
    gradeValue: null,
    price: PURCHASE_PRICE,
    soldAt: PURCHASE_DATE,
    observedAt: now,
    source: "ebay-user-purchase",
    sourceExternalId: EBAY_ITEM_ID,
    contributorUserId: DREW_USER_ID,
    title: "Victor Figueroa 2026 Bowman Chrome Black & White Red Ink Auto (Red Ink SSP)",
    imageUrl: "https://i.ebayimg.com/images/g/veoAAeSwlWlqHPiZ/s-l1600.jpg",
    sellerHandle: "johsie-75",
    verifiedByUser: true,
    confidence: 0.9,
    contentHash,
    notes: "Retroactively backfilled from Drew's eBay purchase. Original ebay-auto import path missed persisting to sold_comps.",
    ttl: 157680000,
  };
  const compResp = await sold.items.upsert(compDoc);
  console.log(`sold_comps upsert -> ${compResp.statusCode}, id=${compDoc.id}, cardId=${compDoc.cardId}`);
}

main().catch(err => { console.error(err); process.exit(1); });
