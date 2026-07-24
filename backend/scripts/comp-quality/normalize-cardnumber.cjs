#!/usr/bin/env node
// CF-COMP-QUALITY-NORMALIZE-CARDNUMBER (Drew, 2026-07-24). Normalizes
// cardNumber field on sold_comps: UPPER-cases, trims whitespace, strips
// leading "#" prefix. When the normalized value differs, recomputes
// hobbyiqCardId with the corrected cardNumber and persists both.
//
// Idempotent — skips rows already normalized.
//
// Env:
//   NORM_CARDNUMBER_APPLY=true — persist. Default: dry-run.
//   NORM_CARDNUMBER_CONCURRENCY=12

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
const APPLY = process.env.NORM_CARDNUMBER_APPLY === "true";
const CONCURRENCY = Number(process.env.NORM_CARDNUMBER_CONCURRENCY || "12");

function normalizeCardNumber(s) {
  return String(s || "").trim().replace(/^#+/, "").toUpperCase();
}

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
  const all = flag("all");
  const sport = arg("sport", "baseball");
  const minYear = Number(arg("min-year", "2020")) || 2020;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[normalize-cardnumber] apply=${APPLY} scope=${all ? "all" : `${sport} year>=${minYear}`} concurrency=${CONCURRENCY}`);

  let where = "IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ''";
  const params = [];
  if (!all) {
    where += " AND c.sport = @sp AND c.cardYear >= @y";
    params.push({ name: "@sp", value: sport }, { name: "@y", value: minYear });
  }
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.setName, c.sport FROM c WHERE ${where}`;
  const it = sc.items.query({ query: q, parameters: params }, { maxItemCount: 5000 });

  const patches = [];
  let scanned = 0, alreadyNormalized = 0, missingIdentity = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      const norm = normalizeCardNumber(r.cardNumber);
      if (norm === r.cardNumber) { alreadyNormalized++; continue; }
      if (!norm || !r.playerName || !r.setName || !r.cardYear) { missingIdentity++; continue; }
      let newSlug;
      try {
        newSlug = computeHobbyIqCardId({
          sport: (r.sport || "baseball").toLowerCase(),
          year: Number(r.cardYear),
          setKey: r.setName,
          cardNumber: norm,
          parallel: r.parallel || "Base",
          isAuto: !!r.isAuto,
          printRun: r.printRun ?? null,
        });
      } catch { continue; }
      patches.push({
        id: r.id,
        partitionKey: r.cardId,
        cardNumber: norm,
        newSlug,
      });
    }
    process.stdout.write(`\r  scanned=${scanned} normalized=${alreadyNormalized} patches=${patches.length}`);
  }
  console.log();
  console.log(`\nSummary:`);
  console.log(`  scanned:              ${scanned}`);
  console.log(`  already normalized:   ${alreadyNormalized}`);
  console.log(`  missing identity:     ${missingIdentity}`);
  console.log(`  patches ready:        ${patches.length}`);

  if (patches.length === 0 || !APPLY) {
    if (!APPLY && patches.length > 0) console.log(`\n*** DRY-RUN. Set NORM_CARDNUMBER_APPLY=true to persist. ***`);
    return;
  }

  console.log(`\nPatching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/cardNumber", value: p.cardNumber },
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) process.stdout.write(`\r  patched ${done}/${patches.length}`);
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
