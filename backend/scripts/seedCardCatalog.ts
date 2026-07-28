#!/usr/bin/env -S node --experimental-strip-types
// CF-CARD-CATALOG-SEED (Drew, 2026-07-28).
//
// Bootstrap `card_catalog` from the existing sold_comps pool.
// Aggregates every distinct (sport, year, setKey, cardNumber,
// parallel, isAuto, printRun, playerName) tuple, produces one catalog
// entry per tuple, and upserts.
//
// Default: dry-run — prints the count of distinct entries that
// WOULD be created + a sample of the top-volume slugs. Zero writes.
//
// Pass --apply to actually upsert into card_catalog.
//
// Cross-vendor `vendorIds` are populated when a row happens to carry
// a stable vendor cardId (CH's UUID). Cardsight rows with the
// backstop-shaped cardId get skipped for vendorIds (backstop IDs
// aren't stable references).
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
//     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
//     --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
//   node --experimental-strip-types backend/scripts/seedCardCatalog.ts          # dry-run
//   node --experimental-strip-types backend/scripts/seedCardCatalog.ts --apply  # writes

import { CosmosClient } from "@azure/cosmos";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface CompRow {
  hobbyiqCardId?: string;
  sport?: string;
  cardYear?: number;
  setName?: string;
  cardNumber?: string;
  parallel?: string;
  isAuto?: boolean;
  printRun?: number | null;
  playerName?: string;
  source?: string;
  cardId?: string;
  verifiedByUser?: boolean;
}

interface Aggregate {
  slug: string;
  sport: string;
  year: number;
  setName: string;
  cardNumber: string;
  parallel: string;
  isAuto: boolean;
  printRun: number | null;
  playerName: string;
  vendorIds: Record<string, string>;
  compCount: number;
  verifiedCount: number;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY (will upsert into card_catalog)" : "dry-run"}${limit !== Infinity ? `  limit=${limit}` : ""}`);

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
  const cat = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog");

  const agg = new Map<string, Aggregate>();
  let scanned = 0;
  let skippedNoContext = 0;

  const q = sc.items.query<CompRow>({
    query:
      "SELECT c.hobbyiqCardId, c.sport, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.source, c.cardId, c.verifiedByUser FROM c",
  });
  while (q.hasMoreResults()) {
    const { resources } = await q.fetchNext();
    for (const r of resources) {
      if (scanned >= limit) break;
      scanned += 1;
      if (!r.sport || !r.cardYear || !r.setName || !r.cardNumber || !r.playerName) {
        skippedNoContext += 1;
        continue;
      }
      let slug = String(r.hobbyiqCardId ?? "").trim();
      if (!slug.startsWith("hiq:")) {
        try {
          slug = computeHobbyIqCardId({
            sport: r.sport,
            year: r.cardYear,
            setKey: r.setName,
            cardNumber: r.cardNumber,
            parallel: r.parallel ?? "Base",
            isAuto: r.isAuto === true,
            printRun: r.printRun ?? null,
          });
        } catch {
          skippedNoContext += 1;
          continue;
        }
      }
      const isBackstopCardId = typeof r.cardId === "string" && r.cardId.startsWith("backstop:");
      const existing = agg.get(slug);
      if (existing) {
        existing.compCount += 1;
        if (r.verifiedByUser === true) existing.verifiedCount += 1;
        if (r.source && r.cardId && !isBackstopCardId && !existing.vendorIds[r.source] && !r.cardId.startsWith("hiq:")) {
          existing.vendorIds[r.source] = r.cardId;
        }
      } else {
        const vendorIds: Record<string, string> = {};
        if (r.source && r.cardId && !isBackstopCardId && !r.cardId.startsWith("hiq:")) {
          vendorIds[r.source] = r.cardId;
        }
        agg.set(slug, {
          slug,
          sport: r.sport,
          year: r.cardYear,
          setName: r.setName,
          cardNumber: r.cardNumber,
          parallel: r.parallel ?? "Base",
          isAuto: r.isAuto === true,
          printRun: r.printRun ?? null,
          playerName: r.playerName,
          vendorIds,
          compCount: 1,
          verifiedCount: r.verifiedByUser === true ? 1 : 0,
        });
      }
    }
    if (scanned >= limit) break;
    if (scanned % 20000 === 0) {
      console.log(`  scanned ${scanned}  distinct-slugs ${agg.size}  skipped ${skippedNoContext}`);
    }
  }

  console.log(`\n▸ Aggregation complete`);
  console.log(`  rows scanned:         ${scanned}`);
  console.log(`  distinct slugs:       ${agg.size}`);
  console.log(`  skipped (no context): ${skippedNoContext}`);

  const now = new Date().toISOString();
  const sorted = [...agg.values()].sort((a, b) => b.compCount - a.compCount);
  console.log(`\n▸ Top 15 slugs by comp count:`);
  for (const a of sorted.slice(0, 15)) {
    console.log(`  n=${String(a.compCount).padStart(5)}  ${a.slug}`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Pass --apply to seed card_catalog.`);
    return;
  }

  console.log(`\n▸ Seeding card_catalog...`);
  let upserted = 0;
  let failed = 0;
  const CONCURRENCY = 20;
  const pending: Promise<void>[] = [];
  for (const a of sorted) {
    const parallelSlug = a.slug.split(":")[5] ?? "base";
    const doc = {
      id: a.slug,
      sport: a.sport,
      year: a.year,
      setKey: a.setName,
      cardNumber: a.cardNumber.toUpperCase(),
      parallel: a.parallel,
      parallelSlug,
      isAuto: a.isAuto,
      printRun: a.printRun,
      playerName: a.playerName,
      playerSlug: a.playerName.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-"),
      vendorIds: a.vendorIds,
      source: (a.verifiedCount > 0 ? "user-verified" : "seed") as "seed" | "user-verified",
      confidence: a.verifiedCount > 0 ? 1.0 : Math.min(0.9, 0.5 + a.compCount / 200),
      observedAt: now,
      lastSeenAt: now,
      compCount: a.compCount,
    };
    const p = cat.items.upsert(doc as unknown as Record<string, unknown>).then(() => {
      upserted += 1;
      if (upserted % 500 === 0) console.log(`  upserted ${upserted} / ${sorted.length}`);
    }).catch((err: unknown) => {
      failed += 1;
      if (failed < 10) console.warn(`  failed ${a.slug}: ${(err as Error)?.message ?? String(err)}`);
    });
    pending.push(p);
    if (pending.length >= CONCURRENCY) {
      await Promise.all(pending.splice(0, pending.length));
    }
  }
  if (pending.length > 0) await Promise.all(pending);
  console.log(`\n▸ Seed complete: upserted ${upserted}, failed ${failed}, total ${sorted.length}`);
}

main().catch((err: unknown) => {
  console.error(`fatal:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
