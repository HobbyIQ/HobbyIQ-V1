#!/usr/bin/env node
/**
 * CF-EBAY-LINK-INDEX-BACKFILL-P0.5 (Drew, 2026-07-26). One-shot backfill
 * of the ebay_link_index container from every eBay-linked holding that
 * pre-dates PR #785. After this runs, the fallback cross-partition scan
 * in findHoldingByEbayOfferIdAcrossUsers / findHoldingByEbayListingIdAcrossUsers
 * should stop firing for legitimate lookups.
 *
 * Cross-partition-scans the `portfolio` container (once, at backfill
 * time — the whole point of this script is to eliminate that pattern
 * from the hot per-webhook path), walks each user's holdings, upserts
 * (offer, listing) index rows for anything that carries `ebayOfferId`
 * or `ebayListingId`.
 *
 * Idempotent — upserts overwrite the same id. Safe to re-run.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... \
 *     node backend/scripts/backfill-ebay-link-index.cjs \
 *       [--apply] [--limit=N] [--userId=X]
 *
 *   Default is DRY-RUN. --apply required to write.
 *
 * Rate-limited via BACKFILL_RATE_MS (default 30ms per index row).
 */
const { CosmosClient } = require("@azure/cosmos");

const RATE_MS = Number(process.env.BACKFILL_RATE_MS ?? "30");
const CONTAINER_ID = process.env.COSMOS_EBAY_LINK_INDEX_CONTAINER ?? "ebay_link_index";

function parseArgs(argv) {
  const args = { apply: false, limit: Infinity, userId: null };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--userId=")) args.userId = a.slice(9);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const portfolio = db.container(process.env.COSMOS_PORTFOLIO_CONTAINER ?? "portfolio");

  // Create-if-not-exists in APPLY mode only. Dry-run stays read-only.
  let index = null;
  if (args.apply) {
    const { container } = await db.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/ebayId"] },
      defaultTtl: -1,
    });
    index = container;
    console.error(`[backfill] index container ready: ${CONTAINER_ID}`);
  } else {
    console.error(`[backfill] DRY-RUN — would createIfNotExists container ${CONTAINER_ID}`);
  }

  console.error(
    `Mode: ${args.apply ? "APPLY" : "DRY-RUN"}  ` +
    `userId=${args.userId ?? "(all)"}  limit=${args.limit}  rate=${RATE_MS}ms`,
  );

  const params = [];
  let whereExtra = "";
  if (args.userId) {
    whereExtra = " WHERE c.userId = @uid";
    params.push({ name: "@uid", value: args.userId });
  }

  const iter = portfolio.items.query(
    { query: `SELECT c.userId, c.holdings FROM c${whereExtra}`, parameters: params },
    { maxItemCount: 50 },
  );

  const stats = {
    usersScanned: 0,
    holdingsScanned: 0,
    holdingsWithOfferId: 0,
    holdingsWithListingId: 0,
    offerRowsWritten: 0,
    listingRowsWritten: 0,
    upsertFailures: 0,
  };

  const linkedAt = new Date().toISOString();

  outer: while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!resources) continue;
    for (const row of resources) {
      if (!row?.holdings) continue;
      stats.usersScanned++;
      for (const [holdingId, holding] of Object.entries(row.holdings)) {
        if (!holding) continue;
        stats.holdingsScanned++;
        const offerId = holding.ebayOfferId ?? null;
        const listingId = holding.ebayListingId ?? null;
        if (!offerId && !listingId) continue;

        if (offerId) {
          stats.holdingsWithOfferId++;
          if (args.apply && index) {
            const ok = await upsertOne(index, {
              id: `offer::${offerId}`,
              ebayId: offerId,
              ebayIdKind: "offer",
              userId: row.userId,
              holdingId,
              linkedAt,
              ttl: -1,
            });
            if (ok) stats.offerRowsWritten++;
            else stats.upsertFailures++;
            await sleep(RATE_MS);
          }
        }
        if (listingId) {
          stats.holdingsWithListingId++;
          if (args.apply && index) {
            const ok = await upsertOne(index, {
              id: `listing::${listingId}`,
              ebayId: listingId,
              ebayIdKind: "listing",
              userId: row.userId,
              holdingId,
              linkedAt,
              ttl: -1,
            });
            if (ok) stats.listingRowsWritten++;
            else stats.upsertFailures++;
            await sleep(RATE_MS);
          }
        }

        const writes = (offerId ? 1 : 0) + (listingId ? 1 : 0);
        if (stats.offerRowsWritten + stats.listingRowsWritten >= args.limit && args.apply) {
          console.error(`[backfill] hit --limit=${args.limit}, stopping`);
          break outer;
        }
        void writes;
      }
    }
  }

  console.error("\n[backfill] Summary:");
  console.error(JSON.stringify(stats, null, 2));

  if (!args.apply) {
    console.error(
      "\n[backfill] DRY-RUN complete. Re-run with --apply to write index rows.",
    );
  }
}

async function upsertOne(container, doc) {
  try {
    await container.items.upsert(doc);
    return true;
  } catch (err) {
    console.error(
      `[backfill] upsert failed for ${doc.id}: ${err?.message ?? String(err)}`,
    );
    return false;
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
