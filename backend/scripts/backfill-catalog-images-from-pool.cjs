#!/usr/bin/env node
/**
 * CF-CATALOG-IMAGES-FROM-POOL (Drew, 2026-08-15). Populate
 * card_catalog.imageUrl from images we ALREADY own in sold_comps.
 *
 * WHY. The catalog is what verifies "is this the card I mean?", so a row
 * without a picture can't do its job. Measured 2026-08-15: card_catalog
 * holds 35,662,285 rows and only 279,423 carry an imageUrl (0.78%).
 * Two thirds of the catalog is text checklist scrape (baseballcardpedia
 * alone is 23.2M rows with SEVEN images between them) — those sources
 * never had pictures and never will.
 *
 * But we are not missing the data. sold_comps carries 7,344,148 rows with
 * a live image URL, covering 1,454,362 distinct hobbyiqCardIds. Those are
 * eBay listing photos we already fetched and persisted. Joining them onto
 * the catalog raises image coverage ~5.2x and does it precisely on the
 * cards that have real sale activity — which are the cards people search
 * for. This is the persist-vendor-lookups doctrine paying out: the pool we
 * grew on every lookup now backfills the moat.
 *
 * JOIN KEY. hobbyiqCardId, NOT cardId. Verified on a sample: cardId
 * matched 1/8 because many comps carry synthetic "backstop:<player>|..."
 * ids that never existed in the catalog, while hobbyiqCardId matched 6/8.
 * hobbyiqCardId is not the catalog's partition key (/cardId is), so
 * lookups are cross-partition — batched IN() clauses keep that to roughly
 * 14.5K queries rather than 1.45M.
 *
 * ONLY-FILL, NEVER-OVERWRITE. A row that already has an imageUrl is left
 * alone. Vendor art (CardHedge CDN, 95.6% coverage on its rows) is a
 * cleaner studio scan than an eBay listing photo, so an existing image
 * always wins. This mirrors the only-improve rule the slug sweep uses.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/backfill-catalog-images-from-pool.cjs
 *     [--apply] [--batch=100] [--concurrency=16] [--limit=N]
 *
 * Defaults to DRY-RUN. Nothing is written without --apply.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

/**
 * Normalize an eBay image URL to a usable, consistently-sized variant.
 *
 * eBay has two URL schemes in our pool and BOTH need rewriting:
 *
 *   modern: .../images/g/<id>/s-l<N>.jpg   — "s-l225" thumb .. "s-l1600" full
 *   legacy: .../00/s/<dims>/z/<id>/$_<N>   — size code, extension optional
 *
 * The legacy one is a trap. Comps store it bare as `/$_1` with no
 * extension, and that URL returns HTTP 200 with a 1,359-byte PLACEHOLDER
 * — identical byte count on every card tested. Backfilling as-stored
 * would have written ~1.45M blank images that render broken, which is the
 * very bug this backfill exists to fix. Adding the extension returns real
 * bytes: `$_1.JPG` 33KB, `$_12.JPG` ~47KB, `$_57.JPG` 88KB-507KB.
 *
 * Target ~45-50KB: sharp enough to confirm "yes, that's my card" (the
 * catalog's whole job) without making a 20-row search grid multi-megabyte.
 * `$_12.JPG` measured 45.8/47.0/48.8KB across samples and `s-l500` 43KB,
 * so the two schemes land at a matched weight.
 */
function normalizeImageUrl(url) {
  let u = String(url || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  // Force TLS. Some pool rows carry http:// (older eBay captures), and a
  // browser on our https site blocks mixed-content images outright — the
  // picture silently never renders. The http origin also 301s, so this
  // saves a redirect hop as well.
  u = u.replace(/^http:\/\//i, "https://");
  // Legacy scheme — rewrite the size code AND force the extension.
  if (/\/\$_\d+(\.[a-z]+)?(\?|$)/i.test(u)) {
    return u.replace(/\/\$_\d+(\.[a-z]+)?(\?|$)/i, "/\$_12.JPG$2");
  }
  // Modern scheme.
  if (/\/s-l\d+\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) {
    return u.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)(\?|$)/i, "/s-l500.$1$2");
  }
  return u;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const APPLY = has("apply");
  const BATCH = Math.max(1, Number(arg("batch", "100")));
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  const LIMIT = Number(arg("limit", "0")) || Infinity;

  console.log(`[catalog-images] mode=${APPLY ? "APPLY" : "DRY-RUN"} batch=${BATCH} concurrency=${CONCURRENCY}${LIMIT !== Infinity ? ` limit=${LIMIT}` : ""}`);

  // STREAM, DON'T GROUP BY. The obvious query here is
  // `... MAX(c.imageUrl) ... GROUP BY c.hobbyiqCardId`, and it does not
  // work at this scale: Cosmos materializes every group before it yields
  // a single row, so 1.45M groups produced a 49MB response and died with
  // "Maximum call stack size exceeded" after burning 22,139 RU without
  // emitting anything. Streaming the raw rows and de-duplicating client
  // side costs one pass and constant memory per page instead.
  const FROM = arg("from", "2019-01");
  const TO = arg("to", new Date().toISOString().slice(0, 7));
  const seen = new Set();
  const iter = sold.items.query({
    query: `SELECT c.hobbyiqCardId, c.imageUrl
            FROM c
            WHERE c.soldAt >= @from AND c.soldAt < @to
              AND IS_DEFINED(c.imageUrl) AND NOT IS_NULL(c.imageUrl)
              AND IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)`,
    parameters: [{ name: "@from", value: `${FROM}-01` }, { name: "@to", value: `${TO}-32` }],
  }, { maxItemCount: 1000 });

  const tot = { groups: 0, looked: 0, catalogHits: 0, needImage: 0, patched: 0, failed: 0, skippedBadUrl: 0 };
  const samples = [];
  const inflight = new Set();
  let buf = [];

  async function flush() {
    if (!buf.length) return;
    const chunk = buf; buf = [];
    const byId = new Map();
    for (const g of chunk) {
      const img = normalizeImageUrl(g.imageUrl);
      if (!img) { tot.skippedBadUrl++; continue; }
      byId.set(g.hobbyiqCardId, img);
    }
    if (!byId.size) return;

    const ids = [...byId.keys()];
    const params = ids.map((v, i) => ({ name: `@p${i}`, value: v }));
    // Only pull rows that still need an image — never overwrite.
    const q = {
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId
              FROM c
              WHERE c.hobbyiqCardId IN (${params.map((p) => p.name).join(",")})
                AND (NOT IS_DEFINED(c.imageUrl) OR IS_NULL(c.imageUrl) OR c.imageUrl = "")`,
      parameters: params,
    };
    tot.looked += ids.length;

    const rows = [];
    const it = cat.items.query(q, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await it.fetchNext();
      rows.push(...(resources || []));
    }
    tot.catalogHits += rows.length;

    for (const row of rows) {
      const img = byId.get(row.hobbyiqCardId);
      if (!img) continue;
      tot.needImage++;
      if (samples.length < 8) samples.push(`${String(row.hobbyiqCardId).slice(0, 52).padEnd(52)} <- ${img.slice(0, 62)}`);
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // card_catalog is partitioned by /cardId.
      const p = cat.item(row.id, row.cardId).patch([
        { op: "add", path: "/imageUrl", value: img },
        { op: "add", path: "/imageSource", value: "sold-comps-pool" },
        { op: "add", path: "/imageBackfilledAt", value: new Date().toISOString() },
      ])
        .then(() => { tot.patched++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
  }

  while (iter.hasMoreResults() && tot.groups < LIMIT) {
    const { resources } = await iter.fetchNext();
    for (const g of resources || []) {
      if (tot.groups >= LIMIT) break;
      // First image wins per card — one lookup per distinct card, not per comp.
      if (seen.has(g.hobbyiqCardId)) continue;
      seen.add(g.hobbyiqCardId);
      tot.groups++;
      buf.push(g);
      if (buf.length >= BATCH) await flush();
    }
    process.stderr.write(`\rgroups=${tot.groups} catalogRowsNeedingImage=${tot.needImage} patched=${tot.patched}`);
  }
  await flush();
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  comp groups scanned        ${tot.groups}`);
  console.log(`  hobbyiqCardIds looked up   ${tot.looked}`);
  console.log(`  catalog rows missing image ${tot.needImage}`);
  console.log(`  patched                    ${APPLY ? `${tot.patched} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log(`  skipped (unusable url)     ${tot.skippedBadUrl}`);
  console.log("\n  sample fills:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
