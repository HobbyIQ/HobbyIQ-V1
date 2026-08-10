// CF-CATALOG-ORPHAN-SLUG-BACKFILL (Drew, 2026-08-10).
// Catalog rows without a hobbyiqCardId can't be matched to sold_comps —
// they're invisible to every downstream FMV and mapping path. This
// script recomputes the slug from the row's own fields and patches it
// in, unlocking those rows.
//
// Method:
//   1. Query card_catalog for rows where hobbyiqCardId is null/missing
//   2. For each, compute the deterministic slug from sport + year +
//      setKey + cardNumber + parallel + isAuto + printRun via the
//      canonical hobbyIqCardId.service helper
//   3. Skip rows that lack the minimum identity fields (no slug possible)
//   4. Patch valid rows: { op: "add", path: "/hobbyiqCardId", value: slug }
//
// Idempotent: filter guarantees we only touch rows without a slug.
// The computeHobbyIqCardId helper is deterministic, so re-running with
// the same field set produces the same slug (no drift).
//
// Usage:
//   DRY_RUN=true  node backend/scripts/backfillOrphanCatalogSlugs.cjs
//   DRY_RUN=false node backend/scripts/backfillOrphanCatalogSlugs.cjs
//   Optional: SOURCE_FILTER=cardhedge  (default = all sources)
//   Optional: CONCURRENCY=32  (default 32; card_catalog has heavy
//     concurrent load — turn down if you see 429 storms)
//
// Snapshot 2026-08-10 pre-run: 300K orphan rows across all sources.

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const SOURCE_FILTER = process.env.SOURCE_FILTER || "";
const CONCURRENCY = Math.min(128, Number(process.env.CONCURRENCY || 32));

if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

let computeHobbyIqCardId;
try {
  ({ computeHobbyIqCardId } = require(path.resolve(
    __dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js",
  )));
} catch (e) {
  console.error("hobbyIqCardId.service not built — run `npm run build` first");
  process.exit(1);
}

async function main() {
  const client = new CosmosClient(CONN);
  const cat = client.database("hobbyiq").container("card_catalog");
  const t0 = Date.now();

  const clauses = [
    "(NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = \"\")",
  ];
  if (SOURCE_FILTER) clauses.push(`c.source = "${SOURCE_FILTER}"`);
  const query = `SELECT c.id, c.cardId, c.sport, c.cardYear, c.year, c.setKey, c.setName,
                        c.cardNumber, c.parallel, c.isAuto, c.printRun, c.source
                 FROM c WHERE ${clauses.join(" AND ")}`;

  console.log("[scan] querying orphan rows (card_catalog is under heavy load — this can take minutes)");
  console.log("  ", query);

  const iter = cat.items.query(query, { maxItemCount: 1000 });
  let scanned = 0, planned = 0, skippedMissingFields = 0;
  const patchQueue = [];
  const skipReasons = { noSport: 0, noYear: 0, noSetKey: 0, noNumber: 0 };
  const sourceCounts = new Map();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const src = r.source ?? "(null)";
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
      const sport = r.sport;
      const year = r.cardYear ?? r.year;
      const setKey = r.setKey ?? (r.setName ? String(r.setName).toLowerCase().trim().replace(/\s+/g, "-") : null);
      const cardNumber = r.cardNumber;
      if (!sport) { skipReasons.noSport++; skippedMissingFields++; continue; }
      if (typeof year !== "number") { skipReasons.noYear++; skippedMissingFields++; continue; }
      if (!setKey) { skipReasons.noSetKey++; skippedMissingFields++; continue; }
      if (!cardNumber) { skipReasons.noNumber++; skippedMissingFields++; continue; }
      let slug;
      try {
        slug = computeHobbyIqCardId({
          sport, year, setKey, cardNumber,
          parallel: r.parallel || "Base",
          isAuto: r.isAuto ?? false,
          printRun: r.printRun ?? null,
        });
      } catch (e) {
        skippedMissingFields++;
        continue;
      }
      if (!slug) { skippedMissingFields++; continue; }
      patchQueue.push({ id: r.id, pk: r.cardId ?? r.id, slug });
      planned++;
    }
    if (scanned % 10000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  planned=${planned.toLocaleString()}  skipped=${skippedMissingFields.toLocaleString()}`);
  }

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned                     : ${scanned.toLocaleString()}`);
  console.log(`  patches planned                  : ${planned.toLocaleString()}`);
  console.log(`  skipped (missing identity fields): ${skippedMissingFields.toLocaleString()}`);
  console.log(`    no sport   : ${skipReasons.noSport.toLocaleString()}`);
  console.log(`    no year    : ${skipReasons.noYear.toLocaleString()}`);
  console.log(`    no setKey  : ${skipReasons.noSetKey.toLocaleString()}`);
  console.log(`    no number  : ${skipReasons.noNumber.toLocaleString()}`);
  const topSources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("");
  console.log("[top orphan sources]");
  for (const [src, n] of topSources) console.log(`  ${String(src).padEnd(30)} ${n.toLocaleString().padStart(10)}`);

  if (DRY_RUN) {
    console.log("");
    console.log("[DRY_RUN] no writes issued. Set DRY_RUN=false to apply.");
    if (patchQueue.length > 0) {
      console.log("");
      console.log("[sample patches]");
      for (const p of patchQueue.slice(0, 5)) console.log(`  ${p.id.slice(0, 60)}...  →  ${p.slug}`);
    }
    return;
  }

  console.log("");
  console.log("[apply] patching (429 backoff enabled)…");
  let patched = 0, patchFailed = 0;
  const inflight = new Set();
  for (const p of patchQueue) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await cat.item(p.id, p.pk).patch([
            { op: "add", path: "/hobbyiqCardId", value: p.slug },
          ]);
          return true;
        } catch (err) {
          const code = err && (err.code ?? err.statusCode);
          if (code === 429 && attempt < 4) {
            const wait = Number(err.retryAfterInMs ?? 500 * Math.pow(2, attempt));
            await new Promise(r => setTimeout(r, wait));
            continue;
          }
          if (attempt === 4) return { failed: true, err };
          return { failed: true, err };
        }
      }
    })()
      .then((r) => {
        if (r === true) {
          patched++;
          if (patched % 5000 === 0) {
            const eps = (patched / ((Date.now() - t0) / 1000)).toFixed(0);
            console.log(`  patched ${patched.toLocaleString()}/${planned.toLocaleString()}  (${eps}/sec)`);
          }
        } else if (r && r.failed) {
          patchFailed++;
          if (patchFailed <= 10) console.warn(`  patch-fail id=${p.id}: ${r.err && r.err.message}`);
        }
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
}

main().catch(e => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
