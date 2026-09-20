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
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rollup docs built for the days that were queried
//   written  = upserts acknowledged; failed = upserts that threw (until D18
//              an upsert error was only logged, and the DONE line could not
//              tell a day that wrote nothing from a day with no comps)
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). Rollups are built FROM
// sold_comps, so a CardHedge dual-id twin baked into a rollup doc can never
// be un-counted downstream — MARKET_MOVERS_USE_ROLLUPS reads sold_comps_daily
// straight through with no dedupe of its own (see marketMoversSnapshot.
// service.ts). The same shared rule the FMV path (unifiedPricing.service.ts)
// and every other reader use applies HERE, at build time, per (cardId,
// parallel, grade, day) group — the exact scope this script already groups
// by — before count/sum/median/min/max are computed from the group's prices.
const { dedupeSoldComps, distinctWriterShape } = require(path.join(__dirname, "..", "dist/services/portfolioiq/dedupeSoldComps.js"));

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
  let totalRollupsWritten = 0, totalRollupsIntended = 0, totalErrors = 0;

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
                       c.cardNumber, c.cardYear, c.price, c.source, c.sourceExternalId, c.sport, c.soldAt
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
          rows: [],
          sources: {},
        };
        groups.set(key, g);
      }
      g.rows.push(r);
      g.sources[r.source] = (g.sources[r.source] ?? 0) + 1;
    }

    const rollupDocs = [];
    for (const [key, g] of groups) {
      // Every row in this group already shares (cardId, parallel, grade) —
      // exactly dedupeSoldComps's gradeKey scope — so this collapses a
      // dual-id twin without ever being able to merge two different grades.
      //
      // CF-VOLUME-READERS-NEED-DISTINCT-WRITERS (2026-09-20). This is a
      // COUNT surface (`count`/`sum`/`median` feed market-movers'
      // salesInWindow and medians straight through), so the plain
      // gradeKey|price coincidence rule is too blunt: 30 genuine $1.99
      // sales of a common on the same day would collapse to 1.
      // `distinctWriterShape` restricts the collapse to pairs that are
      // ACTUALLY two different writer shapes for the same sale (the
      // CardHedge dual-id bug's real signature), never two rows the same
      // feed legitimately wrote twice. NOTE: `sources` below still counts
      // PRE-dedupe rows — an existing, pre-dedupe informational counter, not
      // load-bearing to the aggregates this reader change protects.
      const deduped = dedupeSoldComps(g.rows, { onlyWhen: distinctWriterShape });
      const sorted = deduped.map((r) => Number(r.price)).sort((a, b) => a - b);
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

    let dayWritten = 0, dayErrors = 0;
    if (args.apply) {
      totalRollupsIntended += rollupDocs.length;
      const chunks = [];
      for (let i = 0; i < rollupDocs.length; i += args.concurrency) chunks.push(rollupDocs.slice(i, i + args.concurrency));
      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (doc) => {
          try { await scDaily.items.upsert(doc); dayWritten++; }
          catch (err) { dayErrors++; if (dayErrors <= 3) console.error(`  ${dayISO}: upsert error ${err.message}`); }
        }));
      }
    } else {
      dayWritten = rollupDocs.length;
    }
    totalRollupsWritten += dayWritten;
    totalErrors += dayErrors;

    const elapsed = (Date.now() - t0) / 1000;
    const rate = totalRollupsWritten / elapsed;
    console.log(`  ${dayISO}: comps=${rows.length}  rollups=${dayWritten}${dayErrors ? `  errors=${dayErrors}` : ""}  (running total ${totalRollupsWritten.toLocaleString()} @ ${rate.toFixed(0)}/s)`);
  }

  const elapsedMin = (Date.now() - t0) / 60_000;
  console.log(`\nDONE. rollups_written=${totalRollupsWritten.toLocaleString()}  errors=${totalErrors}  time=${elapsedMin.toFixed(1)}min  apply=${args.apply}`);
  if (args.apply) reportWrites({ job: "rollup-sold-comps-daily", intended: totalRollupsIntended, written: totalRollupsWritten, failed: totalErrors });
}

main().catch((e) => { console.error(e); process.exit(1); });
