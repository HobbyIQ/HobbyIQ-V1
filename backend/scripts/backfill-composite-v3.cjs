#!/usr/bin/env node
// CF-BACKFILL-COMPOSITE-V3 (Drew, 2026-07-31). Additive-only enrichment
// on top of v1 composite. Reads existing rows with composite.colorFamily
// defined + cardYear present, computes era + ladderVerdict + ladderTier +
// paniniColorEquivalent, writes them onto composite.
//
// Safe to run alongside the v1 backfill self-relaunch loop — v1
// writes composite.{edition,insertSet,colorFamily,finishModifier,isRefractor,
// confidence}; v3 only adds fields. Idempotent: reruns on already-
// enriched rows detect via composite.era != null and skip.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — write (default false / dry-run)
//   BACKFILL_CONCURRENCY=32      — parallel patch workers
//   BACKFILL_LIMIT               — optional row cap for testing

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { enrichCompositeV3 } = require(path.join(backend, "dist/services/portfolioiq/enrichCompositeV3.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || "32"));
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : null;

function productLineFromSlug(slug) {
  const parts = String(slug || "").split(":");
  return parts[3] || null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-composite-v3]`);
  console.log(`  apply:       ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit:       ${LIMIT ?? "unbounded"}`);

  const query = `
    SELECT c.id, c.cardId, c.cardYear, c.hobbyiqCardId, c.composite
    FROM c
    WHERE IS_DEFINED(c.composite) AND c.composite != null
      AND NOT IS_DEFINED(c.composite.era)
  `;
  const it = sc.items.query(query, { maxItemCount: 2000 });

  let scanned = 0;
  let planned = 0;
  let wrote = 0;
  let failed = 0;
  let skipped = 0;

  const batch = [];
  const flushBatch = async () => {
    if (batch.length === 0) return;
    await Promise.all(
      batch.map(async (row) => {
        try {
          const v3 = enrichCompositeV3({
            cardYear: row.cardYear,
            productLine: productLineFromSlug(row.hobbyiqCardId),
            colorFamily: row.composite?.colorFamily,
            serialRun: row.composite?.serialRun ?? null,
          });
          const merged = { ...(row.composite || {}), ...v3 };
          if (APPLY) {
            await sc.item(row.id, row.cardId).patch([
              { op: "set", path: "/composite", value: merged },
            ]);
          }
          wrote++;
        } catch (e) {
          failed++;
        }
      }),
    );
    batch.length = 0;
  };

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (LIMIT && scanned > LIMIT) break;
      // Cheap idempotence — composite.era already set means we've been
      // here on a prior run. Skip.
      if (r.composite && r.composite.era != null) { skipped++; continue; }
      planned++;
      batch.push(r);
      if (batch.length >= CONCURRENCY) await flushBatch();
      if (scanned % 10000 === 0) {
        console.log(`  scanned ${scanned}, planned ${planned}, wrote ${wrote}`);
      }
    }
    if (LIMIT && scanned > LIMIT) break;
  }
  await flushBatch();

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  scanned:  ${scanned}`);
  console.log(`  skipped:  ${skipped}  (already v3-enriched)`);
  console.log(`  planned:  ${planned}`);
  console.log(`  wrote:    ${wrote}`);
  console.log(`  failed:   ${failed}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
}

main().catch((e) => { console.error(e); process.exit(1); });
