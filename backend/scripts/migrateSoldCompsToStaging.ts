#!/usr/bin/env -S npx tsx
// CF-LEGACY-MIGRATION (Drew, 2026-07-28). Full migration per Drew's
// call: recreate every sold_comps row as a staging row with
// `provenance: "backfill-from-sold-comps"`. The standard pipeline
// (data-clean → image-verify → promotion) then processes them the
// same as fresh vendor ingest.
//
// Expected outcomes on legacy rows:
//   - Rows with a live imageUrl (recent CH/CS ingest) → get mirrored,
//     pass image-verify, promote with lineage.
//   - Rows with dead imageUrl (old eBay listings that 404 now) →
//     mirror fails → data-clean flags "no-image" anomaly →
//     image-verify can't run without image → pending-manual queue.
//   - Rows without any imageUrl → same as above.
//
// Real-world estimate: 60-90% of legacy rows end up in pending-manual.
// That's fine — the no-reject rule means nothing gets thrown away,
// Drew triages what he wants when he wants.
//
// Idempotent: staging row id is deterministic (sha of source+
// sourceExternalId), so re-running skips already-migrated rows via
// Cosmos upsert semantics.
//
// Dry-run by default. --apply to actually write.

import { CosmosClient } from "@azure/cosmos";
import { randomUUID, createHash } from "crypto";
import { computeStagingContentHash, type StagingDoc, type StagingVendor } from "../src/services/portfolioiq/compsStaging.service.js";

interface LegacyRow {
  id: string;
  cardId: string;
  hobbyiqCardId?: string;
  playerName?: string;
  cardYear?: number;
  setName?: string;
  parallel?: string;
  cardNumber?: string;
  isAuto?: boolean;
  sport?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price?: number;
  soldAt?: string;
  source?: string;
  sourceExternalId?: string | null;
  title?: string;
  url?: string;
  imageUrl?: string | null;
  observedAt?: string;
  verifiedByUser?: boolean;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const cutoffDays = Number(process.argv.find((a) => a.startsWith("--cutoff-days="))?.split("=")[1] ?? Infinity);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY" : "dry-run"}${limit !== Infinity ? `  limit=${limit}` : ""}${cutoffDays !== Infinity ? `  cutoffDays=${cutoffDays}` : ""}`);

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
  const staging = db.container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");

  const validSources: Set<StagingVendor> = new Set(["cardhedge", "cardsight", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "ebay-browse-ended"]);

  let scanned = 0;
  let migrated = 0;
  let skippedNoSlug = 0;
  let skippedInvalidSource = 0;
  let skippedNoPrice = 0;
  let errors = 0;
  const withImage: Record<string, number> = { yes: 0, no: 0 };

  const q = cutoffDays !== Infinity
    ? {
        query: "SELECT * FROM c WHERE c.soldAt >= @cutoff",
        parameters: [{ name: "@cutoff", value: new Date(Date.now() - cutoffDays * 86_400_000).toISOString() }],
      }
    : { query: "SELECT * FROM c", parameters: [] };
  const iter = sc.items.query<LegacyRow>(q);
  const CONCURRENCY = 20;
  const pending: Promise<void>[] = [];

  while (iter.hasMoreResults() && scanned < limit) {
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      if (scanned >= limit) break;
      scanned += 1;

      const slug = row.hobbyiqCardId;
      if (!slug || !slug.startsWith("hiq:")) { skippedNoSlug += 1; continue; }
      const source = String(row.source ?? "").trim();
      if (!validSources.has(source as StagingVendor)) { skippedInvalidSource += 1; continue; }
      const price = Number(row.price ?? 0);
      if (!Number.isFinite(price) || price <= 0) { skippedNoPrice += 1; continue; }

      const hasImage = Boolean(row.imageUrl);
      withImage[hasImage ? "yes" : "no"] += 1;

      // Deterministic staging id — sha of (source, sourceExternalId, soldCompsId).
      // Re-runs land on same doc so upsert dedups.
      const idParts = [source, row.sourceExternalId ?? "", row.id];
      const stagingId = createHash("sha1").update(idParts.join("|")).digest("hex");

      if (apply) {
        const doc: StagingDoc = {
          id: stagingId,
          hobbyiqCardId: slug,
          status: "pending",
          observedAt: row.observedAt ?? new Date().toISOString(),
          raw: {
            vendor: source as StagingVendor,
            vendorRawId: row.sourceExternalId ?? null,
            vendorPayload: {
              title: row.title ?? null,
              price,
              soldAt: row.soldAt ?? new Date().toISOString(),
              url: row.url ?? null,
              imageUrl: row.imageUrl ?? null,
              externalId: row.sourceExternalId ?? null,
            },
            identityHint: {
              playerName: row.playerName ?? null,
              cardYear: row.cardYear ?? null,
              sport: row.sport ?? null,
              vendorCardId: row.cardId,
            },
            fetchedAt: row.observedAt ?? new Date().toISOString(),
            contentHash: computeStagingContentHash({
              cardYear: row.cardYear,
              cardNumber: row.cardNumber,
              parallel: row.parallel,
              isAuto: row.isAuto ?? false,
              price,
              soldAt: row.soldAt ?? new Date().toISOString(),
            }),
          },
        };
        const p = staging.items.upsert(doc as unknown as Record<string, unknown>).then(() => {
          migrated += 1;
        }).catch((err) => {
          errors += 1;
          if (errors < 10) console.warn(`  upsert failed ${slug}: ${(err as Error)?.message ?? err}`);
        });
        pending.push(p);
        if (pending.length >= CONCURRENCY) await Promise.all(pending.splice(0, pending.length));
      } else {
        migrated += 1;
      }
      if (scanned % 5000 === 0) console.log(`  scanned ${scanned}  ${apply ? "migrated" : "would-migrate"} ${migrated}  no-slug ${skippedNoSlug}  invalid-source ${skippedInvalidSource}  no-price ${skippedNoPrice}  errors ${errors}`);
    }
    if (scanned >= limit) break;
  }
  if (pending.length > 0) await Promise.all(pending);

  console.log(`\n▸ Summary`);
  console.log(`  scanned:              ${scanned}`);
  console.log(`  ${apply ? "migrated" : "would-migrate"}: ${migrated}  (${Math.round((migrated / Math.max(1, scanned)) * 100)}%)`);
  console.log(`  skipped no-slug:      ${skippedNoSlug}`);
  console.log(`  skipped invalid-src:  ${skippedInvalidSource}`);
  console.log(`  skipped no-price:     ${skippedNoPrice}`);
  console.log(`  errors:               ${errors}`);
  console.log(`\n▸ Image coverage`);
  console.log(`  with imageUrl:    ${withImage.yes}  (${Math.round((withImage.yes / Math.max(1, migrated)) * 100)}%)`);
  console.log(`  without imageUrl: ${withImage.no}   (${Math.round((withImage.no / Math.max(1, migrated)) * 100)}%)`);
  console.log(`\n${apply ? "✓ Wrote to comps_staging." : "Dry-run only. Pass --apply to actually migrate."}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
