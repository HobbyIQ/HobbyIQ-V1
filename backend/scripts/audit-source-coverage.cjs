#!/usr/bin/env node
/**
 * audit-source-coverage.cjs -- READ-ONLY. Before a whole source is retired
 * because a cleaner re-ingest "replaced" it: for every product the old
 * sources hold, does the new source hold the same (cardNumber, parallel,
 * printRun) keys?
 *
 * Built from the 2026-08-29 D3b scratch measurement that stopped the
 * checklistcenter retire: over the 60 largest old products the new source
 * covered 23% of 551,845 keys; 2025 Bowman Draft 0%, 2025 Topps Chrome 20%,
 * 2024 Leaf Metal / 2018 Bowman / 2020 Bowman nothing at all. Part of the gap
 * is a NAME shape (old rows glued a subset prefix: "prizms blue", "set
 * concourse gold prizms") -- the normalised key shows that part; the rest is
 * rows the merge kept under the old label (lib/sourceCoverage.cjs explains).
 *
 * The measurement is lib/sourceCoverage.cjs, the SAME one retire-exploded-
 * checklist-rows MODE=source applies as its per-product floor.
 *
 * CF-THE-LABEL-IS-NOT-THE-IDENTITY (2026-08-30, D3c). The first run of this
 * audit (33278726520) flagged 349 of 406 products; the rows it called
 * uncovered were in the catalog at their canonical ids under an earlier
 * checklist label (bcp ladders, checklistinsider, beckett -- the merge keeps
 * the existing row on an exact tie, and the ingest's id collapses the setKey
 * so the old raw-upserted row is a different document). Coverage is measured
 * on the canonical id now, held by any checklist-authority source that is
 * not being retired; every product line says who holds its keys.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING   required
 *   OLD_SOURCES (or SOURCES)   comma-separated, REQUIRED -- a whole-source
 *                              question needs its name (the runner's `sources`)
 *   NEW_SOURCE (or REPLACED_BY, or the runner's `scope`)   default
 *                              checklistcenter-2026-08-29
 *   COVER_BY                   any-checklist (default) | replacement (only rows
 *                              labelled NEW_SOURCE count -- the D3b reading)
 *   LIMIT                      largest N products (0 = every product)
 *   MIN_COVERAGE_PCT           the floor the retire will apply (default 95);
 *                              products under it are flagged
 *   UNCOVERED_PER_PRODUCT      uncovered keys printed per product (default 8)
 */
const path = require("node:path");
const { CosmosClient } = require(path.join(__dirname, "..", "node_modules", "@azure/cosmos"));
const { measureProductCoverage, productsOf, resolveNewSource, resolveCoverBy, coverageLine } = require("./lib/sourceCoverage.cjs");

const f = (n) => Number(n).toLocaleString();
const OLD_SOURCES = String(process.env.OLD_SOURCES || process.env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
const NEW_SOURCE = resolveNewSource(process.env);
const COVER_BY = resolveCoverBy(process.env);
const LIMIT = Number(process.env.LIMIT || 0);
const MIN_COVERAGE_PCT = Number(process.env.MIN_COVERAGE_PCT || 95);
const UNCOVERED_PER_PRODUCT = Number(process.env.UNCOVERED_PER_PRODUCT || 8);

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!OLD_SOURCES.length) { console.error("FATAL: OLD_SOURCES (or SOURCES) is required -- e.g. OLD_SOURCES=checklistcenter,checklistcenter-html"); process.exit(1); }
  const cat = new CosmosClient({ connectionString: process.env.COSMOS_CONNECTION_STRING, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } } }).database("hobbyiq").container("card_catalog");
  console.log(`[audit-source-coverage] READ-ONLY  old=${OLD_SOURCES.join(",")}  new=${NEW_SOURCE}  cover-by=${COVER_BY === "replacement" ? "the replacement label only" : "any checklist-authority source at the canonical id"}  floor=${MIN_COVERAGE_PCT}%  limit=${LIMIT || "all"}\n`);

  const products = await productsOf(cat, retry, OLD_SOURCES);
  console.log(`old-source products: ${f(products.length)}, rows: ${f(products.reduce((s, p) => s + p.n, 0))}\n`);
  const scope = LIMIT ? products.slice(0, LIMIT) : products;
  let totOldRows = 0, totNewRows = 0, totKeys = 0, totLegend = 0, totExact = 0, totNorm = 0, atFloor = 0, belowFloor = 0, nothing = 0, done = 0;
  const heldBy = new Map();
  for (const p of scope) {
    const c = await measureProductCoverage(cat, retry, p, OLD_SOURCES, NEW_SOURCE, { coverBy: COVER_BY });
    if (!c) continue;
    done++;
    totOldRows += c.oldRows; totNewRows += c.newRows; totKeys += c.keys; totLegend += c.legendRows; totExact += c.coveredExact; totNorm += c.coveredNorm;
    for (const [s, n] of c.heldBy) heldBy.set(s, (heldBy.get(s) || 0) + n);
    const ok = c.pctNorm >= MIN_COVERAGE_PCT;
    if (ok) atFloor++; else belowFloor++;
    if (c.newRows === 0 && !c.heldBy.length) nothing++;
    console.log(`${ok ? "   " : "!! "}${coverageLine(c)}${ok ? "" : `  <-- BELOW ${MIN_COVERAGE_PCT}% floor: the retire KEEPS this product`}`);
    if (c.uncovered.length && UNCOVERED_PER_PRODUCT > 0) console.log(`      uncovered: ${c.uncovered.slice(0, UNCOVERED_PER_PRODUCT).join("  |  ")}${c.uncovered.length > UNCOVERED_PER_PRODUCT ? `  … +${f(c.uncovered.length - UNCOVERED_PER_PRODUCT)} more` : ""}`);
  }
  console.log(`\nTOTAL (${f(done)} products${LIMIT ? `, largest ${LIMIT}` : ""}): old ${f(totOldRows)} rows / ${f(totKeys)} keys${totLegend ? ` (${f(totLegend)} legend rows left out)` : ""}, new ${f(totNewRows)} rows, covered exact ${f(totExact)} (${totKeys ? Math.round((100 * totExact) / totKeys) : 0}%) normalised ${f(totNorm)} (${totKeys ? Math.round((100 * totNorm) / totKeys) : 0}%)`);
  console.log(`  products at or above the ${MIN_COVERAGE_PCT}% floor: ${f(atFloor)}   below (the retire keeps them): ${f(belowFloor)}   nothing holds the product: ${f(nothing)}`);
  console.log(`  covered keys held by: ${[...heldBy.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${f(n)}`).join(", ") || "(none)"}`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
