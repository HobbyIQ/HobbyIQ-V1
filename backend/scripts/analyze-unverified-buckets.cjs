#!/usr/bin/env node
// CF-ANALYZE-UNVERIFIED (Drew, 2026-08-05).
//
// Enumerates the two big remaining match-rate gaps and reports the
// top-N normalized-parallel strings that appear in each so we know
// exactly which parallel names / years / product-families to attack
// next. Read-only, safe to run on live.
//
// Buckets analyzed:
//   1. parallel-unverified  — we identified the product but the
//      parallel string didn't align to any known parallel on it.
//   2. null / undefined     — no bccpMatchedAs at all (never touched
//      by the matcher, or matcher skipped the row entirely).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   TOP_N                      how many rows per bucket (default 40)
//   YEAR_FROM / YEAR_TO        optional year range (default all)

const { CosmosClient } = require("@azure/cosmos");

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(1);
}

const TOP_N = Math.max(1, Number(process.env.TOP_N || 40));
const YEAR_FROM = process.env.YEAR_FROM ? Number(process.env.YEAR_FROM) : null;
const YEAR_TO = process.env.YEAR_TO ? Number(process.env.YEAR_TO) : null;

const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
const catalog = db.container("card_catalog");

function normalizeParallelForCount(s) {
  if (!s) return "(blank)";
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s\-\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function bucketReport(label, whereClause) {
  const yearFilter =
    YEAR_FROM && YEAR_TO
      ? ` AND c.year >= ${YEAR_FROM} AND c.year <= ${YEAR_TO}`
      : "";
  const q = {
    query: `SELECT c.parallel, c.year, c.setKey, c.playerName, c.bccpProductPage, c.bccpNotMatchedReason
            FROM c WHERE ${whereClause}${yearFilter}`,
  };
  const it = catalog.items.query(q, { maxItemCount: 1000 });
  const byParallel = new Map();
  const byYear = new Map();
  const bySet = new Map();
  const byReason = new Map();
  const byProductPage = new Map();
  let total = 0;
  const sampleByParallel = new Map();
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      total++;
      const pn = normalizeParallelForCount(r.parallel);
      byParallel.set(pn, (byParallel.get(pn) || 0) + 1);
      byYear.set(r.year, (byYear.get(r.year) || 0) + 1);
      const key = `${r.year}::${r.setKey || "?"}`;
      bySet.set(key, (bySet.get(key) || 0) + 1);
      const reason = r.bccpNotMatchedReason || "(none)";
      // Collapse trailing per-parallel suffix so patterns aggregate:
      //   "parallel-not-in-BCCP:Aqua Wave Refractor" → "parallel-not-in-BCCP"
      const reasonBucket = reason.includes(":") ? reason.split(":")[0] : reason;
      byReason.set(reasonBucket, (byReason.get(reasonBucket) || 0) + 1);
      if (r.bccpProductPage) {
        byProductPage.set(r.bccpProductPage, (byProductPage.get(r.bccpProductPage) || 0) + 1);
      }
      if (!sampleByParallel.has(pn) && sampleByParallel.size < 5000) {
        sampleByParallel.set(pn, {
          parallel: r.parallel,
          year: r.year,
          setKey: r.setKey,
          player: r.playerName,
          productPage: r.bccpProductPage,
        });
      }
    }
  }

  console.log(`\n═══ ${label} — ${total.toLocaleString()} rows ═══`);
  console.log(`\nBy failure reason:`);
  const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  for (const [r, c] of reasons) console.log(`  ${String(c).padStart(7)}  ${r}`);
  console.log(`\nTop ${TOP_N} normalized parallels:`);
  const parallels = [...byParallel.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
  for (const [pn, count] of parallels) {
    const sample = sampleByParallel.get(pn);
    const suffix = sample
      ? `  eg raw="${sample.parallel}"  y=${sample.year}  set=${sample.setKey}  player="${sample.player || "?"}"  page="${sample.productPage || ""}"`
      : "";
    console.log(`  ${String(count).padStart(6)}  ${pn}${suffix}`);
  }
  console.log(`\nBy year (top 20):`);
  const years = [...byYear.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [y, c] of years) console.log(`  ${String(c).padStart(6)}  y=${y}`);
  console.log(`\nBy year+setKey (top 25):`);
  const sets = [...bySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [key, c] of sets) console.log(`  ${String(c).padStart(6)}  ${key}`);
  console.log(`\nTop 20 BCCP product pages where we're stuck:`);
  const pages = [...byProductPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [p, c] of pages) console.log(`  ${String(c).padStart(6)}  ${p}`);
}

async function main() {
  console.log(`▸ Unverified-bucket analysis  TOP_N=${TOP_N}${YEAR_FROM ? `  years=${YEAR_FROM}-${YEAR_TO}` : ""}`);
  await bucketReport("parallel-unverified", `c.bccpMatchedAs = "parallel-unverified"`);
  await bucketReport("null / undefined bccpMatchedAs", `NOT IS_DEFINED(c.bccpMatchedAs)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
