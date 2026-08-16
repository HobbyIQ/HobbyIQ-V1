#!/usr/bin/env node
/**
 * CF-CATALOG-YEAR-STRING (Drew, 2026-08-15: "fix it!!").
 *
 * card_catalog.year held 11,369 rows as a STRING against 35,382,031 as
 * numbers. Cosmos does not coerce in a predicate, so `WHERE c.year = @y`
 * with a numeric parameter never matches "2024" — those rows are invisible
 * to every year-filtered catalog query.
 *
 * All 11,369 came from `source: "cardsight"`, and all 49 distinct values
 * (1909..1999+) convert cleanly. The writer that produced them is the one-off
 * expand-catalog-from-cardsight.cjs, which now coerces with
 * Number(card.releaseYear) and is not wired to any workflow — so this is
 * historical contamination, not an ongoing leak.
 *
 * SCOPE, honestly: these rows are structurally incomplete beyond the year.
 * playerName, cardNumber and setKey are all null/absent and they carry no
 * hobbyiqCardId, so they are SEARCH-INDEX rows (searchText + searchTokens),
 * not match rows. Fixing the type removes the split and lets year-filtered
 * queries see them; it does NOT make them matchable on its own.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-catalog-string-year.cjs [--apply] [--concurrency=16]
 *
 * Defaults to DRY-RUN.
 */
const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => process.argv.includes(`--${n}`);

(async () => {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  console.log(`[catalog-year-repair] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  const iter = cat.items.query({
    query: "SELECT c.id, c.cardId, c.year FROM c WHERE IS_STRING(c.year)",
  }, { maxItemCount: 500 });

  const tot = { scanned: 0, convert: 0, skipped: 0, written: 0, failed: 0 };
  const inflight = new Set();
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const n = Number(String(row.year).trim());
      // A year outside a plausible card range is not a year we understand;
      // leave it rather than write a number we cannot justify.
      if (!Number.isFinite(n) || n < 1860 || n > 2100) { tot.skipped++; continue; }
      tot.convert++;
      if (!APPLY) continue;
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // card_catalog is partitioned by /cardId.
      const p = cat.item(row.id, row.cardId).patch([
        { op: "add", path: "/year", value: n },
        { op: "add", path: "/yearTypeRepairedAt", value: new Date().toISOString() },
      ]).then(() => { tot.written++; })
        .catch((e) => { tot.failed++; if (tot.failed <= 5) console.warn(`  patch failed id=${row.id}: ${e.code ?? e.message}`); })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");
  console.log(`\n  string-year rows   ${tot.scanned}`);
  console.log(`  convertible        ${tot.convert}`);
  console.log(`  left alone         ${tot.skipped}`);
  console.log(`  written            ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
})().catch((e) => { console.error(e); process.exit(1); });
