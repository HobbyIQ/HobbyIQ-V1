#!/usr/bin/env node
/**
 * CF-SOLD-COMPS-DAILY-ROLLUP (Drew, 2026-07-19). Materialize per-(cardId,
 * parallel, grade) daily aggregates into `sold_comps_daily` so
 * matched-cohort, market-movers, and player-trend queries don't hammer
 * the 1M+ raw pool.
 *
 * One row per (cardId, parallel, gradeCompany, gradeValue, day). Fields:
 *   { id, cardId, sport, playerName, product, parallel, gradeCompany,
 *     gradeValue, cardNumber, cardYear, day, count, sum, median, min,
 *     max, sources: {cardhedge, ebay-user-purchase, ...},
 *     observedAt }
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node scripts/rollup-sold-comps-daily.cjs \
 *     --from=2020-01-01 --to=2026-07-19 --sport=baseball [--apply]
 *
 * Idempotent via deterministic id: `{cardId}::{parallel}::{grade}::{day}`.
 *
 * Runtime: at 100 writes/sec sustained, ~1M base rows produces ~200K
 * rollup rows (assuming ~5 comps per unique (cardId, parallel, grade,
 * day) on average). Should complete in ~30-45min.
 */
const { CosmosClient } = require("@azure/cosmos");

function parseArgs(argv) {
  const args = { apply: false, sport: null, concurrency: 6 };
  for (const a of argv) {
    if (a.startsWith("--from=")) args.from = a.slice(7);
    else if (a.startsWith("--to=")) args.to = a.slice(5);
    else if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--sport=")) args.sport = a.slice(8).toLowerCase();
    else if (a.startsWith("--concurrency=")) args.concurrency = Math.min(32, Math.max(1, parseInt(a.slice(14), 10)));
  }
  return args;
}

function median(sortedAsc) {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

function normalizeKey(v) {
  return String(v ?? "").trim().toLowerCase() || "__null__";
}

async function ensureContainer(db) {
  const { container } = await db.containers.createIfNotExists({
    id: "sold_comps_daily",
    partitionKey: { paths: ["/cardId"] },
    defaultTtl: -1,
  });
  return container;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from) args.from = "2020-01-01";
  if (!args.to) args.to = new Date().toISOString().slice(0, 10);

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container("sold_comps");
  const scDaily = await ensureContainer(db);

  console.log(`Rollup window: ${args.from} → ${args.to}  apply=${args.apply}  sport=${args.sport ?? "(all)"}  concurrency=${args.concurrency}`);

  const t0 = Date.now();
  let totalRollupsWritten = 0;

  // Walk day-by-day. Each day's rows across ALL cardIds → one query
  // (partition-scoped read is via /cardId, but our aggregation is
  // day-scoped so cross-partition is required here). Cheap on reads
  // because the working set is bounded by daily volume, not lifetime.
  const start = new Date(args.from + "T00:00:00Z");
  const end = new Date(args.to + "T23:59:59Z");

  for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const dayISO = day.toISOString().slice(0, 10);
    const dayStart = dayISO + "T00:00:00Z";
    const dayEnd = dayISO + "T23:59:59Z";

    const parameters = [
      { name: "@from", value: dayStart },
      { name: "@to", value: dayEnd },
    ];
    let sportFilter = "";
    if (args.sport) {
      sportFilter = " AND c.sport = @sport";
      parameters.push({ name: "@sport", value: args.sport });
    }

    let rows = [];
    try {
      const iter = sc.items.query({
        query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.gradeCompany, c.gradeValue,
                       c.cardNumber, c.cardYear, c.price, c.source, c.sport
                FROM c
                WHERE c.soldAt >= @from AND c.soldAt <= @to AND c.price > 0${sportFilter}`,
        parameters,
      });
      while (iter.hasMoreResults()) {
        const { resources } = await iter.fetchNext();
        rows.push(...resources);
      }
    } catch (err) {
      console.error(`  ${dayISO}: query error ${err.message}`);
      continue;
    }

    if (rows.length === 0) { console.log(`  ${dayISO}: 0 comps`); continue; }

    // Group by (cardId, parallel, gradeCompany, gradeValue)
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.cardId}::${normalizeKey(r.parallel)}::${normalizeKey(r.gradeCompany)}::${normalizeKey(r.gradeValue)}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          cardId: r.cardId,
          sport: r.sport ?? null,
          playerName: r.playerName ?? null,
          product: r.setName ?? null,
          parallel: r.parallel ?? null,
          gradeCompany: r.gradeCompany ?? null,
          gradeValue: r.gradeValue ?? null,
          cardNumber: r.cardNumber ?? null,
          cardYear: r.cardYear ?? null,
          prices: [],
          sources: {},
        };
        groups.set(key, g);
      }
      g.prices.push(Number(r.price));
      g.sources[r.source] = (g.sources[r.source] ?? 0) + 1;
    }

    const rollupDocs = [];
    for (const [key, g] of groups) {
      const sorted = g.prices.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      rollupDocs.push({
        id: `${g.cardId}::${normalizeKey(g.parallel)}::${normalizeKey(g.gradeCompany)}::${normalizeKey(g.gradeValue)}::${dayISO}`,
        cardId: g.cardId,
        sport: g.sport,
        playerName: g.playerName,
        product: g.product,
        parallel: g.parallel,
        gradeCompany: g.gradeCompany,
        gradeValue: g.gradeValue,
        cardNumber: g.cardNumber,
        cardYear: g.cardYear,
        day: dayISO,
        count: sorted.length,
        sum: Math.round(sum * 100) / 100,
        median: Math.round(median(sorted) * 100) / 100,
        min: Math.round(sorted[0] * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
        sources: g.sources,
        observedAt: new Date().toISOString(),
      });
      void key;
    }

    let dayWritten = 0;
    if (args.apply) {
      const chunks = [];
      for (let i = 0; i < rollupDocs.length; i += args.concurrency) chunks.push(rollupDocs.slice(i, i + args.concurrency));
      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (doc) => {
          try { await scDaily.items.upsert(doc); dayWritten++; }
          catch (err) { console.error(`  ${dayISO}: upsert error ${err.message}`); }
        }));
      }
    } else {
      dayWritten = rollupDocs.length;
    }
    totalRollupsWritten += dayWritten;

    const elapsed = (Date.now() - t0) / 1000;
    const rate = totalRollupsWritten / elapsed;
    console.log(`  ${dayISO}: comps=${rows.length}  rollups=${dayWritten}  (running total ${totalRollupsWritten.toLocaleString()} @ ${rate.toFixed(0)}/s)`);
  }

  const elapsedMin = (Date.now() - t0) / 60_000;
  console.log(`\nDONE. rollups_written=${totalRollupsWritten.toLocaleString()}  time=${elapsedMin.toFixed(1)}min  apply=${args.apply}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
