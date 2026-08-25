#!/usr/bin/env node
// CF-A-MATCH-AGAINST-OUR-OWN-GUESS-IS-NOT-A-MATCH (Drew, 2026-08-25).
//
// "Does a sale land on a catalog row" is not a quality measure, because a large
// part of the catalog was BUILT FROM sales: 3,405,953 rows are DERIVED
// (`ingest-auto-seed`, `sold-comps-stub`, `sales-attested`,
// `catalog-explode-actuals`). A mis-slugged comp seeds a row and that row then
// confirms the comp. Measured naively, that reads as a match.
//
// catalogAuthority.service.ts already draws the line, and canonicalCardSearch /
// catalogVisibility / resolveSetKey already respect it. What was missing is a
// MEASUREMENT that does. This is that measurement:
//
//   LANDED-ON-EVIDENCE   the slug hits a row transcribed from a checklist
//   landed-on-vendor     hits a row that records how a vendor types
//   landed-on-derived    hits a row we generated ourselves  <- NOT a match
//   orphan               hits nothing
//
// Only the first is a match anyone should quote.
//
// ON SAMPLING, because it has already burned this work twice today: `SELECT TOP
// n` WITHOUT `ORDER BY` is not a sample. It returns whatever the index hands
// back first and it produced both a fake 100% landing rate and a 12x
// overstatement of the anime-tcg problem in one afternoon. This walks YEAR
// buckets and reports per-year, so a skew in one year cannot masquerade as the
// whole picture, and it prints its own n so the number is never read as exact.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   YEARS=...                 comma-separated (default: a spread 1990..2026)
//   PER_YEAR=250              distinct slugs to check per year

const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const PER_YEAR = Number(process.env.PER_YEAR || 250);
const YEARS = String(process.env.YEARS || "1990,1995,2000,2005,2010,2015,2019,2021,2023,2024,2025,2026")
  .split(",").map((y) => Number(y.trim())).filter(Boolean);

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const sc = db.container("sold_comps"), cat = db.container("card_catalog");

  const tot = { checklist: 0, vendor: 0, derived: 0, unknown: 0, orphan: 0 };
  console.log("year    n    evidence   vendor  derived   orphan     EVIDENCE%");

  for (const y of YEARS) {
    const { resources } = await sc.items.query({
      query: `SELECT TOP ${PER_YEAR * 4} c.hobbyiqCardId AS s FROM c
              WHERE c.cardYear = ${y} AND IS_DEFINED(c.hobbyiqCardId)
                AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''`,
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const slugs = [...new Set(resources.map((r) => r.s))].slice(0, PER_YEAR);
    if (!slugs.length) { console.log(String(y).padEnd(6) + "  (no rows)"); continue; }

    const c = { checklist: 0, vendor: 0, derived: 0, unknown: 0, orphan: 0 };
    await Promise.all(slugs.map(async (s) => {
      let row = null;
      try { row = (await cat.item(s, s).read()).resource ?? null; } catch (e) { if (e.code !== 404) throw e; }
      if (!row) { c.orphan++; return; }
      c[catalogAuthorityOf(row.source)]++;
    }));
    for (const k of Object.keys(tot)) tot[k] += c[k];
    const n = slugs.length;
    console.log(
      String(y).padEnd(6) + String(n).padStart(5) +
      String(c.checklist).padStart(11) + String(c.vendor).padStart(9) +
      String(c.derived).padStart(9) + String(c.orphan).padStart(9) +
      (100 * c.checklist / n).toFixed(1).padStart(13) + "%");
  }

  const n = Object.values(tot).reduce((a, b) => a + b, 0);
  const pct = (x) => (100 * x / n).toFixed(2) + "%";
  console.log("\nAcross " + n.toLocaleString() + " distinct slugs sampled (NOT an exact population count):");
  console.log("  LANDED ON EVIDENCE   " + String(tot.checklist).padStart(6) + "   " + pct(tot.checklist) + "   <- the only one worth quoting");
  console.log("  landed on vendor     " + String(tot.vendor).padStart(6) + "   " + pct(tot.vendor));
  console.log("  landed on DERIVED    " + String(tot.derived).padStart(6) + "   " + pct(tot.derived) + "   <- the sale confirming itself");
  console.log("  landed on unknown    " + String(tot.unknown).padStart(6) + "   " + pct(tot.unknown));
  console.log("  orphan (no row)      " + String(tot.orphan).padStart(6) + "   " + pct(tot.orphan));
  const naive = tot.checklist + tot.vendor + tot.derived + tot.unknown;
  console.log("\n  naive 'landed on anything' would report " + pct(naive) +
              " -- inflated by " + pct(tot.derived + tot.unknown) + " of rows we or a vendor invented.");
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
