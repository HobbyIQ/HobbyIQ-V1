#!/usr/bin/env node
/**
 * CF-SOLD-COMPS-CH-BACKFILL (Drew, 2026-07-19). Bulk-populate
 * sold_comps from ch_daily_sales so cross-user aggregation, /recent-
 * sales feeds, and signals see the full CH corpus — not just what
 * canonical FMV happens to have warmed on demand.
 *
 * Fixes the ch_daily_sales → sold_comps ingestion gap: previously
 * only cards someone asked FMV for got written. Now every CH sale
 * lands in the pool with its NATIVE parallel, cardNumber, and grader
 * (NOT the caller's requested parallel — that was the bug in
 * warmPoolFromCh that tagged CH cross-parallel returns with the
 * request's parallel).
 *
 * Runbook:
 *   # Dry run last 24 hours
 *   COSMOS_CONNECTION_STRING=... node scripts/backfill-sold-comps-from-ch.cjs \
 *     --from=2026-07-18 --to=2026-07-19 --dry-run
 *
 *   # Apply last 90 days
 *   COSMOS_CONNECTION_STRING=... node scripts/backfill-sold-comps-from-ch.cjs \
 *     --from=2026-04-20 --to=2026-07-19 --apply
 *
 * Flags:
 *   --from=YYYY-MM-DD   inclusive start (required)
 *   --to=YYYY-MM-DD     inclusive end (required)
 *   --apply             actually write (default: dry-run)
 *   --concurrency=N     concurrent writers (default 8, max 32)
 *   --limit=N           safety limit on rows processed (default: unlimited)
 *
 * Idempotent: uses source::sourceExternalId dedup so re-runs are safe.
 */

const { CosmosClient } = require("@azure/cosmos");

function parseArgs(argv) {
  const args = { concurrency: 4, apply: false, limit: Infinity, cardSetContains: null, sport: null };
  for (const a of argv) {
    if (a.startsWith("--from=")) args.from = a.slice(7);
    else if (a.startsWith("--to=")) args.to = a.slice(5);
    else if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--concurrency=")) args.concurrency = Math.min(32, Math.max(1, parseInt(a.slice(14), 10)));
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--card-set-contains=")) args.cardSetContains = a.slice(20).toLowerCase();
    else if (a.startsWith("--sport=")) args.sport = a.slice(8).toLowerCase();
  }
  return args;
}

/** Same sport-inference logic as soldCompsStore.inferSportFromContext,
 *  duplicated here so the backfill script has no TS import dependency. */
function inferSport(setName, title) {
  const text = `${setName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (text.includes("soccer") || text.includes("mls") || text.includes("premier league")) return "soccer";
  if (/\bbowman\b/.test(text)) return "baseball";
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  return null;
}

function parseGrader(grader) {
  // ch_daily_sales stores grader as e.g. "Raw" | "PSA 10" | "BGS 9.5"
  const g = String(grader ?? "").trim();
  if (!g || g.toLowerCase() === "raw") return { gradeCompany: null, gradeValue: null };
  const m = g.match(/^([A-Z]+)\s+([0-9.]+)$/i);
  if (!m) return { gradeCompany: null, gradeValue: null };
  const value = Number(m[2]);
  return { gradeCompany: m[1].toUpperCase(), gradeValue: Number.isFinite(value) ? value : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Default the window to "all-time from CH earliest to today" when not supplied
  if (!args.from) args.from = "2018-01-01";
  if (!args.to) args.to = new Date().toISOString().slice(0, 10);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const ch = db.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  console.log(`Backfill window: ${args.from} → ${args.to}  apply=${args.apply}  concurrency=${args.concurrency}  limit=${args.limit}  cardSetContains=${args.cardSetContains ?? "(none)"}`);

  // Walk ch_daily_sales day-by-day so we get bounded result sets per
  // query. Cross-partition GROUP BY on 2M rows would stack-overflow
  // the SDK; per-day slices are ~15-20K rows each — manageable.
  const start = new Date(args.from + "T00:00:00Z");
  const end = new Date(args.to + "T23:59:59Z");
  const t0 = Date.now();
  let totalProcessed = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const dayStart = day.toISOString().slice(0, 10) + "T00:00:00Z";
    const dayEnd = day.toISOString().slice(0, 10) + "T23:59:59Z";
    const rows = [];
    try {
      const parameters = [
        { name: "@from", value: dayStart },
        { name: "@to", value: dayEnd },
      ];
      let whereExtra = "";
      if (args.cardSetContains) {
        whereExtra = " AND CONTAINS(LOWER(c.card_set), @setToken)";
        parameters.push({ name: "@setToken", value: args.cardSetContains });
      }
      const iter = ch.items.query({
        query: `SELECT c.card_id, c.player, c.year, c.card_set, c.variant, c.number,
                       c.price, c.grader, c.sale_date, c.image_url
                FROM c
                WHERE c.sale_date >= @from AND c.sale_date <= @to AND c.price > 0${whereExtra}`,
        parameters,
      });
      while (iter.hasMoreResults()) {
        const { resources } = await iter.fetchNext();
        rows.push(...resources);
        if (totalProcessed + rows.length >= args.limit) break;
      }
    } catch (err) {
      console.error(`  ${day.toISOString().slice(0, 10)}: query error ${err.message}`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`  ${day.toISOString().slice(0, 10)}: 0 rows`);
      continue;
    }

    // Bounded-concurrency writes. Each write is idempotent via the
    // deterministic id, so re-runs are safe.
    let dayWritten = 0;
    let daySkipped = 0;
    let dayErrors = 0;

    const chunks = [];
    for (let i = 0; i < rows.length; i += args.concurrency) chunks.push(rows.slice(i, i + args.concurrency));

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (r) => {
        if (!r.card_id || !(Number(r.price) > 0) || !r.sale_date) { daySkipped++; return; }
        const { gradeCompany, gradeValue } = parseGrader(r.grader);
        const sourceExternalId = `ch-daily::${r.card_id}::${r.sale_date}::${Math.round(Number(r.price) * 100)}`;
        const title = `${r.year} ${r.card_set} #${r.number} ${r.variant}`.trim();
        const sport = args.sport ?? inferSport(r.card_set, title);
        const doc = {
          id: `cardhedge::${sourceExternalId}`,
          cardId: r.card_id,
          playerName: r.player ?? "Unknown",
          cardYear: typeof r.year === "number" ? r.year : (Number.isFinite(Number(r.year)) ? Number(r.year) : null),
          setName: r.card_set ?? null,
          parallel: r.variant ?? null,       // NATIVE parallel — the fix vs warmPoolFromCh pollution
          cardNumber: r.number ?? null,       // NATIVE cardNumber
          isAuto: /auto/i.test(r.variant ?? "") || /auto/i.test(r.card_set ?? ""),
          sport,                              // sport tag for cross-sport filtering
          gradeCompany,
          gradeValue,
          price: Number(r.price),
          soldAt: r.sale_date,
          observedAt: new Date().toISOString(),
          source: "cardhedge",
          sourceExternalId,
          contributorUserId: null,
          title,
          imageUrl: r.image_url ?? null,
          sellerHandle: null,
          verifiedByUser: false,
          confidence: 0.8,
        };
        if (!args.apply) { dayWritten++; return; }
        try {
          await sc.items.upsert(doc);
          dayWritten++;
        } catch (err) {
          dayErrors++;
          if (dayErrors <= 3) console.error(`  ${day.toISOString().slice(0, 10)}: upsert error ${err.message}`);
        }
      }));
    }

    totalProcessed += rows.length;
    totalWritten += dayWritten;
    totalSkipped += daySkipped;
    totalErrors += dayErrors;

    const elapsedSec = (Date.now() - t0) / 1000;
    const rate = totalProcessed / elapsedSec;
    console.log(`  ${day.toISOString().slice(0, 10)}: rows=${rows.length}  wrote=${dayWritten}  skip=${daySkipped}  err=${dayErrors}  (running total ${totalWritten.toLocaleString()} @ ${rate.toFixed(0)}/s)`);

    if (totalProcessed >= args.limit) {
      console.log(`Limit ${args.limit} reached, stopping.`);
      break;
    }
  }

  const elapsedMin = (Date.now() - t0) / 60_000;
  console.log(`\nDONE. processed=${totalProcessed.toLocaleString()}  wrote=${totalWritten.toLocaleString()}  skipped=${totalSkipped.toLocaleString()}  errors=${totalErrors.toLocaleString()}  time=${elapsedMin.toFixed(1)}min`);
  console.log(`apply=${args.apply}${args.apply ? "" : " (dry-run — no writes)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
