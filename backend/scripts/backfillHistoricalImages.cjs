// CF-BACKFILL-HISTORICAL-IMAGES (Drew, 2026-08-08). Recover imageUrl on
// pre-fix sold_comps rows (source='tca-ebay' | 'cardsight', imageUrl
// null). The 2026-08-08 fix in persistVendorSalesToPool.service.ts
// preserves imageUrl going forward but doesn't retroactively fix the
// millions of historical rows that landed with null.
//
// Strategy: for each imageless row we still have `url` (eBay listing
// URL) and `sourceExternalId` (vendor's row id). Two candidate lookup
// paths:
//
//   A. eBay Browse API — for source='tca-ebay' extract itemId from
//      `url` and query https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id
//      Returns { image.imageUrl, additionalImages[] }. Rate limited but
//      generous (5K RPS across the account, our shared cap ~1K/hr).
//      Requires OAuth token — already provisioned via existing eBay
//      service (see backend/src/services/ebay/).
//
//   B. Cardsight lookup by id — for source='cardsight', re-fetch the
//      cardsight row and pull imageUrl. Needs CARDSIGHT_API_KEY.
//
// This script implements a SKELETON — the actual fetch calls are gated
// behind TODO markers because both paths need auth token piping and
// rate-limit tuning specific to Drew's deploy. Wire the fetch when
// ready to run.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   SOURCE                     'tca-ebay' | 'cardsight' (default tca-ebay)
//   MAX_AGE_DAYS               only backfill rows soldAt >= N days ago (default 60 — older listings usually 404 on eBay)
//   BATCH_SIZE                 rows per Cosmos scan page (default 500)
//   MAX_ROWS                   total cap per run (default 5000 — set higher for full backfill)
//   CONCURRENCY                parallel fetches (default 8 — respect vendor rate limits)
//   APPLY=true                 patch imageUrl (else dry-run: fetch + log only)
//   EBAY_OAUTH_TOKEN           for TCA path (env; can be re-issued via ebay OAuth flow)

const { CosmosClient } = require("@azure/cosmos");

const SOURCE = process.env.SOURCE || "tca-ebay";
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 60);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const MAX_ROWS = Number(process.env.MAX_ROWS || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const APPLY = process.env.APPLY === "true";

// Extract eBay itemId from a listing URL. eBay URLs have the shape
// https://www.ebay.com/itm/<optional-slug>/<itemId> or /itm/<itemId>.
function extractEbayItemId(url) {
  if (!url) return null;
  const m = String(url).match(/\/itm\/(?:[^/]+\/)?(\d{10,15})/);
  return m ? m[1] : null;
}

// TODO: replace stub with real eBay Browse API call.
// The eBay path: GET https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=<id>
// Headers: Authorization: Bearer <token>, X-EBAY-C-MARKETPLACE-ID: EBAY_US
// Returns: { image: { imageUrl }, additionalImages: [{ imageUrl }, ...] }
// Rate limit: 5 calls/sec per app, 5000/hour typical.
async function fetchEbayImage(itemId) {
  // const token = process.env.EBAY_OAUTH_TOKEN;
  // if (!token) throw new Error("EBAY_OAUTH_TOKEN not set");
  // const r = await fetch(
  //   `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`,
  //   { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } }
  // );
  // if (r.status === 404) return null;
  // if (!r.ok) throw new Error(`ebay ${r.status}`);
  // const data = await r.json();
  // return data?.image?.imageUrl ?? null;
  return null; // stub
}

// TODO: replace with real Cardsight lookup.
async function fetchCardsightImage(externalId) {
  return null; // stub
}

async function fetchImageForRow(row) {
  if (SOURCE === "tca-ebay") {
    const itemId = extractEbayItemId(row.url);
    if (!itemId) return null;
    return await fetchEbayImage(itemId);
  }
  if (SOURCE === "cardsight") {
    return await fetchCardsightImage(row.sourceExternalId);
  }
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  console.log(`[backfill-images] source=${SOURCE} apply=${APPLY} max_age=${MAX_AGE_DAYS}d max_rows=${MAX_ROWS} conc=${CONCURRENCY}`);
  console.log(`[backfill-images] cutoff=${cutoff}`);

  let seen = 0, fetched = 0, recovered = 0, patched = 0, notFound = 0, errored = 0;
  const startMs = Date.now();

  // Cosmos continuation-token pagination — resume-safe on crash.
  let continuation = undefined;
  outer: while (seen < MAX_ROWS) {
    const iterator = sc.items.query({
      query: `SELECT c.id, c.cardId, c.url, c.sourceExternalId, c.soldAt
              FROM c
              WHERE c.source = @src
                AND c.soldAt >= @cutoff
                AND (NOT IS_DEFINED(c.imageUrl) OR c.imageUrl = null OR c.imageUrl = "")`,
      parameters: [{ name: "@src", value: SOURCE }, { name: "@cutoff", value: cutoff }],
    }, { maxItemCount: BATCH_SIZE, continuationToken: continuation });
    const { resources, continuationToken } = await iterator.fetchNext();
    if (!resources || resources.length === 0) break;
    continuation = continuationToken;

    // Fetch images with bounded concurrency
    for (let i = 0; i < resources.length; i += CONCURRENCY) {
      const chunk = resources.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(async (row) => {
        seen++;
        if (seen > MAX_ROWS) return { skipped: true };
        try {
          const img = await fetchImageForRow(row);
          fetched++;
          if (!img) { notFound++; return { row, img: null }; }
          recovered++;
          if (!APPLY) return { row, img };
          const partitionKey = row.cardId || row.id;
          await sc.item(row.id, partitionKey).patch([
            { op: "add", path: "/imageUrl", value: img },
          ]);
          patched++;
          return { row, img, patched: true };
        } catch (err) {
          errored++;
          if (errored <= 5) console.warn(`  err ${row.id}: ${err?.message ?? err}`);
          return { row, err };
        }
      }));
      // (results processed above)
      if (seen >= MAX_ROWS) break outer;
    }
    const elapsedSec = Math.max(1, Math.round((Date.now() - startMs) / 1000));
    console.log(`  progress: seen=${seen} fetched=${fetched} recovered=${recovered} patched=${patched} notFound=${notFound} err=${errored} rate=${(seen / elapsedSec).toFixed(1)}/s`);
    if (!continuation) break;
  }

  console.log(`\n=== BACKFILL SUMMARY ===`);
  console.log(`  source:      ${SOURCE}`);
  console.log(`  apply:       ${APPLY}`);
  console.log(`  seen:        ${seen}`);
  console.log(`  fetched:     ${fetched}`);
  console.log(`  recovered:   ${recovered}  (${fetched > 0 ? (recovered / fetched * 100).toFixed(1) : 0}% of fetch attempts)`);
  console.log(`  patched:     ${patched}`);
  console.log(`  not-found:   ${notFound}`);
  console.log(`  errored:     ${errored}`);
  console.log(`  elapsed:     ${Math.round((Date.now() - startMs) / 1000)}s`);
  if (!APPLY) console.log(`\n  [dry-run] no writes. Wire fetch stubs (see TODO markers) then rerun with APPLY=true.`);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
