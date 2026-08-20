#!/usr/bin/env node
// CF-CATALOG-ATTACH-IMAGES (Drew, 2026-08-13: "Images should show here, we have
// them" / "we need to attach these to the card in the catalog").
//
// Catalog rows carry imageUrl, and CatalogSearchHit documents it as "attached
// from sold_comps" — but nothing had attached it, so every result rendered a
// broken placeholder. Measured: 0 of 8 2018 Ohtani catalog rows had an image,
// while their comps carried several.
//
// Search now fills this in live as a fallback, but that is a read-time patch:
// it only helps the search surface, re-does the work on every query, and leaves
// the card itself imageless for every other consumer. This writes the picture
// ONTO the card, once.
//
// WHY IT IS CHEAP. sold_comps partitions on /cardId, so "give me this card's
// comps" is a single-partition query, and canonical catalog rows are keyed
// id === cardId so we walk them by point read. No cross-partition scans, which
// on this container time out (a bare COUNT ran past 9 minutes).
//
// IMAGE PREFERENCE. Our blob mirror first, vendor URL second. eBay image links
// expire and are hotlink-restricted, so a vendor URL is a placeholder waiting
// to happen — but it is better than nothing until the mirror runs.
//
// Dry-run by default.
//
//   node scripts/attachImagesToCatalog.cjs --year 2018 --set topps-chrome
//   node scripts/attachImagesToCatalog.cjs --year 2018 --set topps-chrome --apply

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const YEAR = Number(val("--year", "0"));
const SET = val("--set", "");
const SPORT = val("--sport", "baseball");
const LIMIT = Number(val("--limit", "500"));
const CONCURRENCY = Number(val("--concurrency", "12"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const cat = db.container("card_catalog");
const sc = db.container("sold_comps");

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = { scanned: 0, alreadyHad: 0, found: 0, written: 0, noComps: 0, noImage: 0, errors: 0 };
const samples = [];

async function handle(row) {
  stats.scanned++;
  if (row.imageUrl) { stats.alreadyHad++; return; }
  const id = row.id;
  try {
    const { resources } = await sc.items.query({
      query: "SELECT TOP 25 c.imageUrl, c.blobUrl, c.soldAt FROM c WHERE c.cardId = @id ORDER BY c.soldAt DESC",
      parameters: [{ name: "@id", value: id }],
    }, { partitionKey: id }).fetchAll();

    if (!resources || resources.length === 0) { stats.noComps++; return; }
    const blob = resources.find((r) => typeof r.blobUrl === "string" && r.blobUrl);
    const vend = resources.find((r) => typeof r.imageUrl === "string" && r.imageUrl);
    const pick = blob?.blobUrl ?? vend?.imageUrl ?? null;
    if (!pick) { stats.noImage++; return; }

    stats.found++;
    if (samples.length < 6) {
      samples.push(`${id}\n      ${blob ? "blob " : "vendor"} ${String(pick).slice(0, 76)}`);
    }
    if (!APPLY) return;

    await cat.items.upsert({
      ...row,
      imageUrl: pick,
      imageSource: blob ? "blob-mirror" : "vendor",
      imageAttachedAt: new Date().toISOString(),
    });
    stats.written++;
  } catch { stats.errors++; }
}

(async () => {
  if (!YEAR || !SET) { console.error("required: --year and --set"); process.exit(2); }
  console.log(`attach images — ${APPLY ? "APPLY" : "DRY RUN"}  ${YEAR} ${SET} (${SPORT})\n`);

  // Scoped query: year + setKey is selective enough to avoid a full scan.
  const { resources: rows } = await cat.items.query({
    query: `SELECT TOP @n * FROM c WHERE c.year = @y AND c.setKey = @sk AND c.sport = @sp AND STARTSWITH(c.id, 'hiq:')`,
    parameters: [
      { name: "@n", value: LIMIT }, { name: "@y", value: YEAR },
      { name: "@sk", value: SET }, { name: "@sp", value: SPORT },
    ],
  }, { maxItemCount: LIMIT }).fetchAll();

  console.log(`catalog rows in scope: ${rows.length}`);
  await mapLimit(rows, CONCURRENCY, handle);

  console.log(`\nscanned          : ${stats.scanned}`);
  console.log(`  already had one: ${stats.alreadyHad}`);
  console.log(`  image found    : ${stats.found}`);
  console.log(`  ${APPLY ? "WRITTEN      " : "would write  "}  : ${APPLY ? stats.written : stats.found}`);
  console.log(`  no comps       : ${stats.noComps}`);
  console.log(`  comps, no image: ${stats.noImage}`);
  console.log(`  errors         : ${stats.errors}`);
  if (samples.length) { console.log("\nexamples:"); for (const s of samples) console.log("   " + s); }
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
