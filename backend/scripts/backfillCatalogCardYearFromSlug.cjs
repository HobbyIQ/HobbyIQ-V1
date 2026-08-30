// CF-CATALOG-CARDYEAR-BACKFILL (Drew, 2026-08-10).
// Root cause: BCP ingest wrote `year` but the rest of the codebase reads
// `cardYear` (707 references across 234 files). 1.3M+ BCP rows shipped
// without cardYear, so every downstream query filtering by
// `WHERE c.cardYear = YYYY` bypasses them. Same risk for sold_comps →
// catalog joins on (playerName, cardYear, setName).
//
// Fix: extract year from the hobbyiqCardId slug (position 2 after
// splitting on ':') and add `cardYear` as a top-level field via
// Cosmos patch operation. Idempotent — only writes rows missing
// cardYear.
//
// Ingest itself already fixed at backend/scripts/ingestBaseballCardPedia.cjs
// so future writes carry cardYear. This script cleans up existing rows.
//
// Usage:
//   DRY_RUN=true  node backend/scripts/backfillCatalogCardYearFromSlug.cjs
//   DRY_RUN=false node backend/scripts/backfillCatalogCardYearFromSlug.cjs
//   Optional: SOURCE_FILTER=baseballcardpedia (default = all rows w/o cardYear)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows scanned
//   written  = patches acknowledged
//   skipped  = rows whose slug yields no year (left alone)
//   failed   = patches rejected
// Requires dist/ — the workflow builds before running this.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const SOURCE_FILTER = process.env.SOURCE_FILTER || "";
const CONCURRENCY = Number(process.env.CONCURRENCY || 64);

if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

function yearFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split(":");
  if (parts.length < 3 || parts[0] !== "hiq") return null;
  const year = Number(parts[2]);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

async function main() {
  const client = new CosmosClient(CONN);
  const cat = client.database("hobbyiq").container("card_catalog");
  const t0 = Date.now();

  const clauses = [
    "IS_DEFINED(c.hobbyiqCardId)",
    "(NOT IS_DEFINED(c.cardYear) OR c.cardYear = null)",
  ];
  if (SOURCE_FILTER) clauses.push(`c.source = "${SOURCE_FILTER}"`);
  const where = clauses.join(" AND ");
  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE ${where}`;

  console.log("[scan] querying:");
  console.log("  ", query);

  const iter = cat.items.query(query, { maxItemCount: 1000 });
  let scanned = 0, planned = 0, skippedBadSlug = 0;
  const patchQueue = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const y = yearFromSlug(r.hobbyiqCardId);
      if (!y) { skippedBadSlug++; continue; }
      patchQueue.push({ id: r.id, pk: r.cardId ?? r.id, year: y });
      planned++;
    }
    if (scanned % 10000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  planned=${planned.toLocaleString()}  skipped=${skippedBadSlug}`);
  }

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned         : ${scanned.toLocaleString()}`);
  console.log(`  patches planned      : ${planned.toLocaleString()}`);
  console.log(`  skipped (bad slug)   : ${skippedBadSlug.toLocaleString()}`);
  if (patchQueue.length > 0) {
    const yearCounts = new Map();
    for (const p of patchQueue) yearCounts.set(p.year, (yearCounts.get(p.year) || 0) + 1);
    const yearsSorted = [...yearCounts.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  year span            : ${yearsSorted[0][0]} - ${yearsSorted[yearsSorted.length-1][0]}  (${yearsSorted.length} distinct years)`);
    console.log(`  top years            :`);
    const topYears = [...yearCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [y, n] of topYears) console.log(`    ${y}: ${n.toLocaleString()}`);
  }

  if (DRY_RUN) {
    console.log("");
    console.log("[DRY_RUN] no writes issued. Set DRY_RUN=false to apply.");
    return;
  }

  console.log("");
  console.log("[apply] patching…");
  let patched = 0, patchFailed = 0;
  const inflight = new Set();
  for (const p of patchQueue) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = cat.item(p.id, p.pk).patch([
      { op: "add", path: "/cardYear", value: p.year },
    ])
      .then(() => {
        patched++;
        if (patched % 5000 === 0) {
          const eps = (patched / ((Date.now() - t0) / 1000)).toFixed(0);
          console.log(`  patched ${patched.toLocaleString()}/${planned.toLocaleString()}  (${eps}/sec)`);
        }
      })
      .catch((err) => {
        patchFailed++;
        if (patchFailed <= 10) console.warn(`  patch-fail id=${p.id} pk=${p.pk}: ${(err && err.message) || err}`);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  }
  await Promise.all([...inflight]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  patched        : ${patched.toLocaleString()}`);
  console.log(`  patch-failed   : ${patchFailed.toLocaleString()}`);
  console.log(`  elapsed        : ${elapsed}s`);
  reportWrites({ job: "backfillCatalogCardYearFromSlug", intended: scanned, written: patched, skipped: skippedBadSlug, failed: patchFailed });
}

main().catch((e) => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
