#!/usr/bin/env node
/**
 * CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04) — REPORT ONLY.
 *
 * How many stored sold_comps rows COULD be given a seller identity from a
 * payload we still hold? This script answers that and writes nothing. There
 * is no APPLY flag and no write path in this file, deliberately: the census
 * has to be agreed before anything mutates 6.87M rows.
 *
 * What the sources can and cannot give back
 * -----------------------------------------
 *   ch_daily_sales   — NO. Verified read-only 2026-09-04: the container's
 *                      fields are card_description, card_id, card_set,
 *                      card_set_type, created_at, description, grade,
 *                      grader, group, id, image_url, listing_url, number,
 *                      player, pop, price, price_history_id, sale_date,
 *                      sale_type, source, updated_at, variant, year.
 *                      There is no seller on the vendor row at all. The
 *                      only near-miss is `listing_url` (an eBay ITEM id),
 *                      which identifies the LISTING, not who sold it — and
 *                      resolving item -> seller would mean re-fetching
 *                      millions of long-ended eBay listings. Not possible.
 *   tca-ebay         — NO. VendorSaleRow carries title/price/soldAt/url/
 *                      externalId/imageUrl; the TCA payload exposes no
 *                      seller to persist.
 *   cardsight        — NO. Same VendorSaleRow shape.
 *   ebay-user-purchase — YES, partially. These rows were emitted from a
 *                      HOLDING, and eBay enrichment stores the Browse
 *                      seller object on that holding as
 *                      `ebaySeller: { username, feedbackScore }`. Measured
 *                      2026-09-04: 111 of 111 eBay-sourced holdings carry
 *                      it, 96 distinct sellers. That is the recoverable
 *                      set, and it is what this script counts.
 *   ebay-account     — YES going forward (the connected account IS the
 *                      seller), but stored rows did not record which
 *                      account polled them, so they are counted separately
 *                      as "forward-only".
 *
 * The join. A pool row's `sourceExternalId` for the import path is built
 * from the holding, so rows are matched back to holdings by
 * (contributorUserId, cardId) and reported per user. A row that matches
 * more than one candidate holding is reported AMBIGUOUS and never counted
 * as recoverable — guessing a seller is precisely the overclaim the whole
 * change exists to prevent.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING=... node scripts/report-seller-identity-backfill.cjs
 */
const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) {
  console.error("COSMOS_CONNECTION_STRING is required (read-only use).");
  process.exit(1);
}
const DB = process.env.COSMOS_DATABASE || "hobbyiq";

function handleOf(holding) {
  const s = holding && holding.ebaySeller;
  if (typeof s === "string") return s.trim().toLowerCase() || null;
  if (s && typeof s === "object" && typeof s.username === "string") {
    return s.username.trim().toLowerCase() || null;
  }
  return null;
}

(async () => {
  const client = new CosmosClient(CONN);
  const db = client.database(DB);

  console.log(JSON.stringify({ event: "seller_backfill_report_start", mode: "REPORT-ONLY", writes: 0 }));

  // ── 1. Pool rows lacking a seller, by source ────────────────────────────
  const { resources: bySource } = await db.container("sold_comps").items.query({
    query: `SELECT c.source AS source, COUNT(1) AS rows,
              SUM((IS_DEFINED(c.sellerHandle) AND NOT IS_NULL(c.sellerHandle) AND c.sellerHandle != "") ? 1 : 0) AS withSeller
            FROM c GROUP BY c.source`,
  }).fetchAll();

  // ── 2. The recoverable set: holdings that still carry ebaySeller ────────
  const byUserHandles = new Map();   // userId -> Map(cardId -> Set(handle))
  let holdingsSeen = 0, holdingsWithSeller = 0;
  const distinctSellers = new Set();
  for await (const page of db.container("portfolio").items
    .query({ query: "SELECT c.userId, c.holdings FROM c" }, { maxItemCount: 20 })
    .getAsyncIterator()) {
    for (const doc of page.resources) {
      const holdings = doc && doc.holdings;
      if (!holdings || typeof holdings !== "object") continue;
      for (const key of Object.keys(holdings)) {
        const h = holdings[key];
        if (!h || typeof h !== "object") continue;
        holdingsSeen++;
        const handle = handleOf(h);
        if (!handle) continue;
        holdingsWithSeller++;
        distinctSellers.add(handle);
        const cardId = h.hobbyiqCardId || h.cardId || null;
        if (!cardId) continue;
        let byCard = byUserHandles.get(doc.userId);
        if (!byCard) { byCard = new Map(); byUserHandles.set(doc.userId, byCard); }
        let set = byCard.get(cardId);
        if (!set) { set = new Set(); byCard.set(cardId, set); }
        set.add(handle);
      }
    }
  }

  // ── 3. Match user-contributed pool rows against that set ────────────────
  let recoverable = 0, ambiguous = 0, noCandidate = 0, alreadyHas = 0, considered = 0;
  const { resources: userRows } = await db.container("sold_comps").items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.contributorUserId, c.sellerHandle
            FROM c WHERE IS_DEFINED(c.contributorUserId) AND NOT IS_NULL(c.contributorUserId)`,
  }).fetchAll();
  for (const r of userRows) {
    considered++;
    if (r.sellerHandle) { alreadyHas++; continue; }
    const byCard = byUserHandles.get(r.contributorUserId);
    const set = byCard && (byCard.get(r.hobbyiqCardId) || byCard.get(r.cardId));
    if (!set || set.size === 0) { noCandidate++; continue; }
    // More than one seller for the same (user, card): unresolvable without
    // guessing. Never counted as recoverable.
    if (set.size > 1) { ambiguous++; continue; }
    recoverable++;
  }

  const forwardOnly = bySource
    .filter((s) => s.source === "ebay-account" || s.source === "ebay-user-sale")
    .reduce((a, s) => a + (s.rows - s.withSeller), 0);

  console.log(JSON.stringify({
    event: "seller_backfill_report",
    mode: "REPORT-ONLY",
    writesPerformed: 0,
    poolBySource: bySource.map((s) => ({
      source: s.source, rows: s.rows, withSeller: s.withSeller, missing: s.rows - s.withSeller,
    })),
    holdings: { seen: holdingsSeen, withEbaySeller: holdingsWithSeller, distinctSellers: distinctSellers.size },
    userContributedRows: { considered, alreadyHas, recoverable, ambiguous, noCandidate },
    vendorSourcesRecoverable: {
      cardhedge: 0, "tca-ebay": 0, cardsight: 0,
      why: "ch_daily_sales exposes no seller field; VendorSaleRow carries none. Item id is not a seller.",
    },
    forwardOnlyRowsNowFixedAtIngest: forwardOnly,
  }, null, 2));
})().catch((e) => { console.error(JSON.stringify({ event: "seller_backfill_report_failed", error: e.message })); process.exit(1); });
