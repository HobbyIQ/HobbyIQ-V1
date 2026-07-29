#!/usr/bin/env node
// CF-RESLUG-CROSS-BRAND-FIX (Drew, 2026-07-29). Handles the case
// where a row's slug carries a bare brand root as setKey (bowman/topps/
// panini/fleer) but the vendor title is confidently identifying a
// DIFFERENT brand family. Example: Herbert 2020 Panini Mosaic row
// landed under setKey=bowman (parser fallback when older ingest didn't
// have Mosaic rules) but the title clearly says "Panini Mosaic".
//
// This is a LATERAL move (bowman → panini-mosaic), which the
// reslug-brand-root-refinement.cjs script rejects by design. But when
// the current setKey is a BARE brand root (single segment) — often a
// fallback default — a cross-brand correction is a strict improvement.
//
// Guardrails:
//   - Current setKey MUST be exactly one segment (bowman, topps, panini,
//     fleer, etc.). Rows already at a specific setKey are NEVER touched.
//   - New setKey MUST be from a DIFFERENT brand than the current one
//     (this script only handles lateral cross-brand moves; the
//     brand-root-refinement script handles same-brand deepening).
//   - New setKey MUST be a multi-segment brand-prefixed key (e.g.,
//     panini-mosaic — NOT bare panini) so we're not making a lateral
//     move without adding specificity.
//   - Also attempts sport re-inference from the title (football / nba /
//     basketball / etc. keywords). If no sport keyword, leaves sport
//     alone.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity, inferSetKeyFromTitle, inferSportFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");

const BARE_BRAND_ROOTS = ["bowman", "topps", "panini", "fleer", "donruss", "upper-deck"];

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function currentBrand(setKeySlug) {
  const parts = setKeySlug.split("-");
  return parts[0];
}

async function processBrand(sc, currentBareBrand) {
  const pattern = `:${currentBareBrand}:`;
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, "${pattern}")
      AND (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
  `;

  console.log(`\n══ ${currentBareBrand} ══`);
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanning ${candidates.length}`);
  }
  console.log(`\r  ${candidates.length} rows CONTAIN :${currentBareBrand}:`);

  const exactBrand = candidates.filter(r => {
    const parts = String(r.hobbyiqCardId ?? "").split(":");
    return parts[3] === currentBareBrand;
  });
  console.log(`  ${exactBrand.length} rows have setKey EXACTLY "${currentBareBrand}"`);
  if (exactBrand.length === 0) return { brand: currentBareBrand, scanned: candidates.length, applied: 0, errors: 0 };

  const patches = [];
  let sameFamily = 0, singleSeg = 0, parseError = 0, computeFailed = 0, noImprovement = 0;
  const distributionByNewSetKey = {};

  for (const r of exactBrand) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) continue;

    let parsedTitle, titleSet, titleSport;
    try {
      parsedTitle = parseListingIdentity(title);
      titleSet = inferSetKeyFromTitle(title, parsedTitle.cardNumber ?? null);
      titleSport = inferSportFromTitle(title, r.sport ?? "baseball");
    } catch { parseError++; continue; }

    const newSetKeySlug = slugify(titleSet);
    const newBrand = currentBrand(newSetKeySlug);

    // Only accept CROSS-BRAND moves (different brand than current).
    if (newBrand === currentBareBrand) { sameFamily++; continue; }
    // Reject single-segment new setKey (must be brand-prefixed and
    // specific — not just moving to another bare brand root).
    if (!newSetKeySlug.includes("-")) { singleSeg++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: titleSport,
        year: Number(r.cardYear),
        setKey: titleSet,
        cardNumber: parsedTitle.cardNumber || r.cardNumber || "",
        parallel: parsedTitle.parallel || r.parallel || "Base",
        isAuto: parsedTitle.isAuto ?? r.isAuto ?? false,
        printRun: parsedTitle.printRun ?? r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { noImprovement++; continue; }
    if (!newSlug.includes(`:${newSetKeySlug}:`)) { noImprovement++; continue; }

    distributionByNewSetKey[newSetKeySlug] = (distributionByNewSetKey[newSetKeySlug] ?? 0) + 1;
    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      newSport: titleSport,
      currentSport: r.sport,
    });
  }

  console.log(`  Parse error:              ${parseError}`);
  console.log(`  Compute failed:           ${computeFailed}`);
  console.log(`  Same-family (no change):  ${sameFamily}`);
  console.log(`  Single-segment (skip):    ${singleSeg}`);
  console.log(`  No improvement:           ${noImprovement}`);
  console.log(`  Ready cross-brand fix:    ${patches.length}`);
  console.log(`  Distribution:`);
  Object.entries(distributionByNewSetKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([k, v]) => console.log(`    ${k.padEnd(30)} ${v}`));

  if (patches.length > 0) {
    console.log(`  Sample 3:`);
    patches.slice(0, 3).forEach(p =>
      console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`)
    );
  }

  if (!APPLY || patches.length === 0) {
    return { brand: currentBareBrand, scanned: candidates.length, applied: 0, errors: 0 };
  }

  console.log(`  Applying ${patches.length} patches...`);
  const t0 = Date.now();
  const result = await runInParallel(patches, async (p) => {
    const ops = [{ op: "set", path: "/hobbyiqCardId", value: p.newSlug }];
    if (p.newSport !== p.currentSport) {
      ops.push({ op: "set", path: "/sport", value: p.newSport });
    }
    await sc.item(p.id, p.partitionKey).patch(ops);
  });
  console.log(`  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return { brand: currentBareBrand, scanned: candidates.length, applied: result.ok, errors: result.err };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-cross-brand-fix]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const summary = [];
  for (const brand of BARE_BRAND_ROOTS) {
    if (process.env.RESLUG_BRAND && process.env.RESLUG_BRAND !== brand) continue;
    const r = await processBrand(sc, brand);
    summary.push(r);
  }

  console.log(`\n════════════════ GRAND SUMMARY ════════════════`);
  let totalApplied = 0, totalErrors = 0;
  for (const s of summary) {
    console.log(`  ${s.brand.padEnd(12)} scanned=${String(s.scanned).padStart(7)} applied=${String(s.applied).padStart(7)} errors=${s.errors}`);
    totalApplied += s.applied;
    totalErrors += s.errors;
  }
  console.log(`  TOTAL applied=${totalApplied} errors=${totalErrors}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set RESLUG_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
