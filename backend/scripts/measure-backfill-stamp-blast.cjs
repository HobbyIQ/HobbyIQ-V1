#!/usr/bin/env node
/**
 * measure-backfill-stamp-blast.cjs -- READ-ONLY. Sizes the blast radius of the
 * historicalBackfill parallel-stamping defect (Drew, 2026-08-31).
 *
 * Not a repair. Runs SELECTs only; there is no APPLY path in this file.
 *
 * The fingerprint, per the diagnosis journal:
 *   (a) sourceExternalId does NOT start with "ch-daily::" -- the fanout's
 *       shape; AND historicalBackfill's OWN 4-part composite shape
 *       "<vendorCardId>::<ISO date>::<priceCents>::<grade>" (service ~115/~184);
 *   (b) the stored parallel is NOT allowed by the title under the shared rule
 *       parallelTheTitleAllows.
 *
 * MEASURED 2026-08-31 against prod: the prefix half alone matches 30,431 rows,
 * but only 130 carry historicalBackfill's shape. The other 30,301 are OTHER
 * writers -- 29,181 one-part cardsight ids, 659 "ch-comp::" three-part
 * CardHedge ids -- whose title/tag disagreements have separate causes and are
 * NOT this defect. This script reports both populations so the difference stays
 * visible and no repair is scoped on the prefix alone.
 *
 * Counts by slug and by source, all sports/years, and reports the CPA-VF 50 as
 * its own line so the known case is visible against the whole.
 *
 * Env: COSMOS_CONNECTION_STRING (required); SOURCES; SCAN_LIMIT (0 = no bound).
 */
"use strict";
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { parseListingTitle } = require(path.join(backend, "dist", "services", "portfolioiq", "ebayTitleParser.service.js"));
const { parallelTheTitleAllows } = require(path.join(backend, "dist", "services", "portfolioiq", "titleOutranksVendorTag.js"));

const SOURCES = String(process.env.SOURCES || "cardhedge,cardsight").split(",").map((s) => s.trim()).filter(Boolean);
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT || 0);
const CPA_VF = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto";
/** historicalBackfill's own externalId shape -- mirrors the repair's gate. */
const BF_GRADE_RE = /^(raw|[A-Z]+ [0-9.]+)$/i;
const isBackfillShape = (ext) => {
  const parts = String(ext ?? "").split("::");
  return parts.length === 4 && /\d{4}-\d{2}-\d{2}/.test(parts[1]) && /^\d+$/.test(parts[2]) && BF_GRADE_RE.test(parts[3]);
};
const f = (n) => Number(n).toLocaleString();
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const pool = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } })
    .database("hobbyiq").container("sold_comps");

  console.log(`measure-backfill-stamp-blast  READ-ONLY  sources=${SOURCES.join(",")}${SCAN_LIMIT ? `  scanLimit ${f(SCAN_LIMIT)}` : ""}`);

  const stats = { scanned: 0, noSlug: 0, allowed: 0, poisoned: 0, toBase: 0, toOther: 0, backfillShaped: 0, otherWriter: 0 };
  const otherShapes = new Map();
  const bySlug = new Map();
  const bySource = new Map();
  const byParallel = new Map();
  const bySport = new Map();
  const examples = [];
  let cpaVf = 0;

  for (const source of SOURCES) {
    const q = {
      query: `SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.price, c.soldAt, c.source, c.sourceExternalId, c.observedAt
              FROM c
              WHERE c.source = @s
                AND IS_DEFINED(c.parallel) AND c.parallel != '' AND c.parallel != 'Base'
                AND IS_DEFINED(c.sourceExternalId) AND NOT STARTSWITH(c.sourceExternalId, 'ch-daily::')`,
      parameters: [{ name: "@s", value: source }],
    };
    const it = pool.items.query(q, { maxItemCount: 1000 });
    while (it.hasMoreResults()) {
      const { resources } = await retry(() => it.fetchNext());
      for (const r of resources ?? []) {
        stats.scanned++;
        if (SCAN_LIMIT && stats.scanned > SCAN_LIMIT) break;
        const slug = String(r.hobbyiqCardId ?? "");
        if (!slug.startsWith("hiq:")) { stats.noSlug++; continue; }
        const parsed = parseListingTitle(r.title);
        const d = parallelTheTitleAllows(parsed && parsed.parallel, r.parallel, { variationMarker: (parsed && parsed.variationMarker) || null });
        if (!d.vendorTagOverruled) { stats.allowed++; continue; }
        const newParallel = d.parallel ?? "Base";
        if (newParallel.toLowerCase() === String(r.parallel ?? "").toLowerCase()) { stats.allowed++; continue; }
        stats.poisoned++;
        // Split by writer: only the 4-part composite is historicalBackfill's.
        if (!isBackfillShape(r.sourceExternalId)) {
          stats.otherWriter++;
          const n = String(r.sourceExternalId ?? "").split("::").length;
          otherShapes.set(`${n} part${n === 1 ? "" : "s"}`, (otherShapes.get(`${n} part${n === 1 ? "" : "s"}`) || 0) + 1);
          continue;
        }
        stats.backfillShaped++;
        if (newParallel === "Base") stats.toBase++; else stats.toOther++;
        if (slug === CPA_VF) cpaVf++;
        bySlug.set(slug, (bySlug.get(slug) || 0) + 1);
        bySource.set(source, (bySource.get(source) || 0) + 1);
        byParallel.set(String(r.parallel), (byParallel.get(String(r.parallel)) || 0) + 1);
        const sport = slug.split(":")[1] ?? "(none)";
        bySport.set(sport, (bySport.get(sport) || 0) + 1);
        if (examples.length < 20) examples.push(`  ${source}  ${r.parallel} -> ${newParallel}  ${slug}  $${r.price}  ${String(r.soldAt ?? "").slice(0, 10)}  "${String(r.title ?? "").slice(0, 70)}"`);
      }
      if (SCAN_LIMIT && stats.scanned > SCAN_LIMIT) break;
    }
  }

  console.log(`\nBLAST RADIUS (read-only; nothing written)`);
  console.log(`  candidate rows scanned   ${f(stats.scanned)}   <- non-Base, no 'ch-daily::' prefix`);
  console.log(`  title ALLOWS the stored  ${f(stats.allowed)}   <- untouched by any repair`);
  console.log(`  title REFUSES the stored ${f(stats.poisoned)}   <- prefix half of the fingerprint only`);
  console.log(`    of these, OTHER writers ${f(stats.otherWriter)}   <- not historicalBackfill's shape; a separate question, NOT repaired here`);
  console.log(`    THIS DEFECT             ${f(stats.backfillShaped)}   <- to Base ${f(stats.toBase)}, to another finish ${f(stats.toOther)}`);
  console.log(`  no hiq slug              ${f(stats.noSlug)}`);
  console.log(`  CPA-VF Red Ink slug      ${f(cpaVf)}   <- the known case`);
  console.log(`\n  other writers by id shape (left alone):`);
  for (const [k, n] of [...otherShapes.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(8)}  ${k}`);
  console.log(`\n  by source:`);
  for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(8)}  ${k}`);
  console.log(`  by sport:`);
  for (const [k, n] of [...bySport.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(8)}  ${k}`);
  console.log(`  top 30 stamped parallels:`);
  for (const [k, n] of [...byParallel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${String(n).padStart(8)}  ${k}`);
  console.log(`  distinct slugs affected  ${f(bySlug.size)}`);
  console.log(`  top 30 slugs:`);
  for (const [k, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${String(n).padStart(8)}  ${k}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
