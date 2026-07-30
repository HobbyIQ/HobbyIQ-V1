#!/usr/bin/env node
// CF-BACKFILL-ISAUTO-CROSS-SPORT (Drew, 2026-07-30). Cross-sport
// isAuto backfill using the unified inferIsAuto detector:
//
//   - Basketball (Panini era 2009-2024): setName-keyword based
//     ("Signatures", "Autographs", "Ink", "Penmanship", "Rookie
//     Ticket", "Sensational Signatures", etc.)
//   - Football (Panini era 2016-2025): setName-keyword + a few
//     prefixed inserts (WT for Winning Ticket)
//   - Any sport where setName matches the AUTO_SETNAME_RE keyword
//     regex
//
// Baseball is handled by backfill-isauto-from-cardnumber.cjs (already
// ran; 37,462 rows fixed). This script is the counterpart for the
// other sports.
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=100000       — max rows scanned
//   BACKFILL_SPORT=basketball   — restrict to one sport (default: all
//                                 non-baseball sports)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { inferIsAuto } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");
const SPORT_FILTER = (process.env.BACKFILL_SPORT || "").toLowerCase();

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

async function processSport(sc, sport) {
  console.log(`\n══ ${sport} ══`);
  // Fetch isAuto=false rows for this sport where either setName or
  // cardNumber might carry an auto signal. Broad Cosmos filter; the
  // JS-side inferIsAuto is the strict test.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE c.isAuto = false
      AND c.sport = @sport
      AND (
        IS_STRING(c.setName)
        OR IS_STRING(c.cardNumber)
      )
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }, { name: "@sport", value: sport }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} isAuto=false ${sport} rows fetched.        `);

  const patches = [];
  const setNameHits = {};
  let noSignal = 0, computeFailed = 0, noSlugChange = 0;

  for (const r of rows) {
    const isAutoInferred = inferIsAuto({
      sport,
      cardNumber: r.cardNumber ?? null,
      setName: r.setName ?? null,
      titleHasAutoText: false, // don't double-count title; we already have isAuto=false
    });
    if (!isAutoInferred) { noSignal++; continue; }

    // Recompute slug with isAuto=true.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport,
        year: Number(r.cardYear),
        setKey: (r.hobbyiqCardId || "").split(":")[3] || sport,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSlugChange++; continue; }

    // Track WHY it matched (for eyeballing).
    const key = r.setName ? String(r.setName).slice(0, 40) : `#${r.cardNumber}`;
    setNameHits[key] = (setNameHits[key] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  no signal:      ${noSignal}`);
  console.log(`  compute failed: ${computeFailed}`);
  console.log(`  no slug change: ${noSlugChange}`);
  console.log(`  Ready to patch: ${patches.length}\n`);
  console.log(`  Top match sources (top 20):`);
  Object.entries(setNameHits)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([k,c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0, 5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
  }

  if (!APPLY || patches.length === 0) {
    return { sport, ready: patches.length, applied: 0, errors: 0 };
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/isAuto", value: true },
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return { sport, ready: patches.length, applied: result.ok, errors: result.err };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-isauto-cross-sport]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  scan-limit-per-sport: ${LIMIT}`);
  console.log(`  sport filter: ${SPORT_FILTER || "all non-baseball"}`);

  const sports = SPORT_FILTER
    ? [SPORT_FILTER]
    : ["basketball", "football", "hockey"];
  const summary = [];
  for (const sp of sports) {
    const r = await processSport(sc, sp);
    summary.push(r);
  }

  console.log(`\n════════════════ GRAND SUMMARY ════════════════`);
  summary.forEach(s => console.log(`  ${s.sport.padEnd(12)} ready=${String(s.ready).padStart(6)} applied=${String(s.applied).padStart(6)} errors=${s.errors}`));
  if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
