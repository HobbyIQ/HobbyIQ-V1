#!/usr/bin/env node
// CF-SOLD-COMPS-MISSING-SLUG (Drew, 2026-07-24). Recompute hobbyiqCardId
// on sold_comps rows where the slug is missing but the structured
// identity fields are present. Never overwrites an existing non-null slug
// (per feedback_slug_recompute_only_improve). Safe to rerun; only touches
// null/missing slugs.
//
// Scope on first run: baseball 2020+ (~4,944 identity groups / ~307k rows
// from the audit). Widen with --sport / --min-year / --all flags.
//
// Env:
//   COSMOS_CONNECTION_STRING — Cosmos DB
//   RECOMPUTE_APPLY=true      — actually write. Default: dry-run.
//   RECOMPUTE_CONCURRENCY=16  — parallel upserts. Default 16.
//
// Usage:
//   node backend/scripts/sold-comps-missing-slug-recompute.cjs             # dry-run baseball 2020+
//   RECOMPUTE_APPLY=true node ... --sport baseball --min-year 2020         # apply
//   RECOMPUTE_APPLY=true node ... --all                                    # all sports/years

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const APPLY = process.env.RECOMPUTE_APPLY === "true";
const CONCURRENCY = Number(process.env.RECOMPUTE_CONCURRENCY || "16");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0;
  let ok = 0, err = 0;
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

async function main() {
  const sport = arg("sport", "baseball");
  const minYear = Number(arg("min-year", "2020")) || 2020;
  const all = flag("all");

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  let where = "(NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')";
  const params = [];
  if (!all) {
    where += " AND c.sport = @sp AND c.cardYear >= @y";
    params.push({ name: "@sp", value: sport }, { name: "@y", value: minYear });
  }
  const q = `SELECT c.id, c.cardId, c.sport, c.cardYear, c.cardNumber, c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.hobbyiqCardId FROM c WHERE ${where}`;

  console.log(`[missing-slug-recompute] scanning sold_comps for null-slug rows...`);
  console.log(`  scope: ${all ? "all sports / all years" : `sport=${sport} year>=${minYear}`}`);
  console.log(`  apply: ${APPLY} (set RECOMPUTE_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const it = sc.items.query({ query: q, parameters: params }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows with missing slug\n`);

  // Compute proposed slug for each
  let computed = 0, skippedMissingIdentity = 0, errored = 0;
  const patches = [];
  for (const r of candidates) {
    if (!r.playerName || !r.cardYear || !r.cardNumber || !r.setName) {
      skippedMissingIdentity++;
      continue;
    }
    try {
      const slug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: r.setName,
        cardNumber: r.cardNumber,
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
      if (!slug) { errored++; continue; }
      patches.push({ id: r.id, partitionKey: r.cardId, slug });
      computed++;
    } catch { errored++; }
  }

  console.log(`Slugs computed:              ${computed}`);
  console.log(`Skipped (missing identity):  ${skippedMissingIdentity}`);
  console.log(`Errored (compute failed):    ${errored}`);
  console.log(`Total ready to upsert:       ${patches.length}\n`);

  if (patches.length === 0) return;

  // Sample first 20 for visual sanity check
  console.log("Sample 20 patches (before apply):");
  patches.slice(0, 20).forEach(p => console.log(`  ${p.slug}`));

  if (!APPLY) {
    console.log("\n*** DRY-RUN COMPLETE. Set RECOMPUTE_APPLY=true to write. ***");
    return;
  }

  console.log(`\nApplying ${patches.length} upserts at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    // Cosmos partial patch — set the hobbyiqCardId field only.
    await sc.item(p.id, p.partitionKey).patch([{ op: "add", path: "/hobbyiqCardId", value: p.slug }]);
    done++;
    if (done % 1000 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
