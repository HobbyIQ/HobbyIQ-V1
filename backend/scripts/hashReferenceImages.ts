#!/usr/bin/env -S npx tsx
// CF-REFERENCE-IMAGE-HASH-BACKFILL (Drew, 2026-07-28).
// Compute pHash for every catalog entry that has a referenceImage.url
// but no referenceImage.phash yet. Idempotent — skips entries that
// already have a phash unless --force is passed.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list ...)"
//   npx tsx backend/scripts/hashReferenceImages.ts          # dry-run
//   npx tsx backend/scripts/hashReferenceImages.ts --apply   # writes phash to catalog

import { CosmosClient } from "@azure/cosmos";
import { computeImageHash } from "../src/services/portfolioiq/imageVerify.service.js";

interface CatalogRow {
  id: string;
  sport: string;
  referenceImage?: { url: string; phash?: string; verifiedAt?: string };
  playerName?: string;
  parallel?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY (writes phash)" : "dry-run"}  force=${force}${limit !== Infinity ? `  limit=${limit}` : ""}`);

  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog");

  const query = force
    ? "SELECT c.id, c.sport, c.referenceImage, c.playerName, c.parallel FROM c WHERE IS_DEFINED(c.referenceImage)"
    : "SELECT c.id, c.sport, c.referenceImage, c.playerName, c.parallel FROM c WHERE IS_DEFINED(c.referenceImage) AND NOT IS_DEFINED(c.referenceImage.phash)";
  const iter = cat.items.query<CatalogRow>(query);

  const CONCURRENCY = 6;
  const queue: CatalogRow[] = [];
  let hashed = 0;
  let failed = 0;
  let skipped = 0;
  let scanned = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row || !row.referenceImage?.url) { skipped += 1; continue; }
      if (scanned >= limit) return;
      scanned += 1;
      const hash = await computeImageHash(row.referenceImage.url);
      if (!hash) { failed += 1; continue; }
      if (apply) {
        try {
          await cat.item(row.id, row.sport).patch([
            { op: "set", path: "/referenceImage/phash", value: hash },
            { op: "set", path: "/referenceImage/verifiedAt", value: new Date().toISOString() },
          ]);
          hashed += 1;
        } catch (err) {
          failed += 1;
          if (failed < 5) console.warn(`  patch failed ${row.id}: ${(err as Error)?.message ?? err}`);
        }
      } else {
        hashed += 1;
      }
      if (hashed % 100 === 0) console.log(`  ${hashed} hashed, ${failed} failed, ${skipped} skipped`);
    }
  };

  while (iter.hasMoreResults() && scanned < limit) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      if (scanned + queue.length >= limit) break;
      queue.push(r);
    }
    // Kick a fresh worker pool per batch
    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
  }

  console.log(`\n▸ Summary`);
  console.log(`  scanned:  ${scanned}`);
  console.log(`  ${apply ? "hashed + written" : "would hash"}: ${hashed}`);
  console.log(`  failed:   ${failed}`);
  console.log(`  skipped:  ${skipped}`);
  console.log(`\n${apply ? "✓ Wrote phash to catalog entries." : "Dry-run only. Pass --apply to write."}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
