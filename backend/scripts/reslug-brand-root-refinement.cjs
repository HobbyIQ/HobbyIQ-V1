#!/usr/bin/env node
// CF-RESLUG-BRAND-ROOT-REFINEMENT (Drew, 2026-07-29). Broad title-based
// re-parse for rows whose current setKey is a bare brand root
// (topps / bowman / panini / fleer / donruss / upper-deck) but whose
// vendor title actually specifies a more-specific product line
// ("Topps Finest", "Bowman Chrome", "Panini Prizm", etc.).
//
// Root cause: at ingest time an older parser fell through to the bare
// brand root when it didn't have a normalizeSetKey rule for that
// product. The current parser has more rules — this script re-parses
// each row's title and rewrites the slug when the newly-inferred
// setKey is a STRICT PREFIX EXTENSION of the current one (only-improve
// guardrail).
//
// Examples:
//   topps → topps-finest, topps-heritage, topps-chrome, ...
//   bowman → bowman-chrome, bowman-paper, bowman-draft, ...
//   panini → panini-prizm, panini-select, panini-donruss, ...
//
// LATERAL moves (topps → bowman) and DOWNGRADES (topps-chrome → topps)
// are rejected by the guardrail: new slug's setKey must start with
// oldSetKey + "-".
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches
//   RESLUG_BRAND=<root>       — limit to one brand root (default: all)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity, inferSetKeyFromTitle } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");
const BRAND_FILTER = (process.env.RESLUG_BRAND || "").toLowerCase();

const BRAND_ROOTS = ["topps", "bowman", "panini", "fleer", "donruss", "upper-deck"];

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

function slugifySetKey(setKey) {
  return String(setKey ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function processBrand(sc, brand) {
  const pattern = `:${brand}:`;
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, "${pattern}")
      AND (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
  `;

  console.log(`\n══ ${brand} ══`);
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanning ${candidates.length}`);
  }
  console.log(`\r  ${candidates.length} rows CONTAIN :${brand}:`);

  // Filter to rows whose setKey is EXACTLY the brand root (position
  // 4 in the colon-split slug: hiq:sport:year:{setKey}:cardNumber:...).
  // Slugs with cardNumber slot containing brand name (unlikely but possible)
  // could false-positive on CONTAINS.
  const exactBrand = candidates.filter(r => {
    const parts = String(r.hobbyiqCardId ?? "").split(":");
    return parts[3] === brand;
  });
  console.log(`  ${exactBrand.length} rows have setKey EXACTLY "${brand}"`);
  if (exactBrand.length === 0) return { brand, scanned: candidates.length, applied: 0, errors: 0, skipped: 0 };

  const patches = [];
  let noTitle = 0, noImprovement = 0, wrongPrefix = 0, computeFailed = 0, parseError = 0;
  const distributionByNewSetKey = {};

  for (const r of exactBrand) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) { noTitle++; continue; }

    let parsedTitle, titleSet;
    try {
      parsedTitle = parseListingIdentity(title);
      titleSet = inferSetKeyFromTitle(title, parsedTitle.cardNumber ?? null);
    } catch { parseError++; continue; }

    const newSetKeySlug = slugifySetKey(titleSet);
    // Guardrail: new setKey MUST be a strict prefix extension of the
    // current brand root. i.e., newSetKey starts with "${brand}-".
    if (!newSetKeySlug.startsWith(`${brand}-`)) {
      wrongPrefix++;
      continue;
    }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: titleSet,
        cardNumber: parsedTitle.cardNumber || r.cardNumber || "",
        parallel: parsedTitle.parallel || r.parallel || "Base",
        isAuto: parsedTitle.isAuto ?? r.isAuto ?? false,
        printRun: parsedTitle.printRun ?? r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { noImprovement++; continue; }
    // Second guardrail: new slug must contain the extended setKey
    if (!newSlug.includes(`:${newSetKeySlug}:`)) { wrongPrefix++; continue; }

    distributionByNewSetKey[newSetKeySlug] = (distributionByNewSetKey[newSetKeySlug] ?? 0) + 1;
    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      newSetKey: titleSet,
      newParallel: parsedTitle.parallel,
    });
  }

  console.log(`  No title:                ${noTitle}`);
  console.log(`  Parse error:             ${parseError}`);
  console.log(`  Compute failed:          ${computeFailed}`);
  console.log(`  Wrong prefix (rejected): ${wrongPrefix}`);
  console.log(`  No improvement (same):   ${noImprovement}`);
  console.log(`  Ready to re-slug:        ${patches.length}`);
  console.log(`  Distribution by new setKey:`);
  Object.entries(distributionByNewSetKey)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${k.padEnd(30)} ${v}`));

  if (patches.length > 0) {
    console.log(`  Sample 3:`);
    patches.slice(0, 3).forEach(p =>
      console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`)
    );
  }

  if (!APPLY || patches.length === 0) {
    return { brand, scanned: candidates.length, applied: 0, errors: 0, skipped: 0 };
  }

  console.log(`  Applying ${patches.length} patches...`);
  const t0 = Date.now();
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
  });
  console.log(`  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return { brand, scanned: candidates.length, applied: result.ok, errors: result.err, skipped: patches.length - result.ok - result.err };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-brand-root-refinement]`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  brand filter: ${BRAND_FILTER || "all"}`);

  const summary = [];
  for (const brand of BRAND_ROOTS) {
    if (BRAND_FILTER && brand !== BRAND_FILTER) continue;
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
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  TOTAL applied=${totalApplied} errors=${totalErrors}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set RESLUG_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
