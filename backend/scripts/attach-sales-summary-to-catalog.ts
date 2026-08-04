#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — sales summary attach (Drew, 2026-08-04).
 *
 * "We want the sold data attached to it, this will create trends."
 *
 * For every canonical (hiq:) catalog entry in a decade/year, query the
 * sold_comps pool for that hobbyiqCardId, compute a rolling salesSummary
 * (count, first/last sale, 30d/90d/180d median, trend direction), and
 * patch it onto the catalog row.
 *
 * Enables:
 *   - Catalog UI can render trend at-a-glance without on-demand pool query
 *   - Sort catalog by "most traded", "trending up", "high volume"
 *   - Per-card trend charts (data already available)
 *   - Player/set-level roll-ups (aggregate over catalog rows)
 *
 * Uses Cosmos patch ops (single Cosmos op per row).
 *
 * Usage:
 *   npx tsx backend/scripts/attach-sales-summary-to-catalog.ts \
 *     [--decade 2020s] [--year YYYY] [--sport baseball] \
 *     [--dry-run] [--auto-approve]
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";

interface Args {
  decade?: string;
  year?: number;
  sport?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--decade") { args.decade = val; i++; }
    else if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--sport") { args.sport = val; i++; }
    else if (flag === "--dry-run") { args.dryRun = true; }
    else if (flag === "--auto-approve" || flag === "-y") { args.autoApprove = true; }
  }
  return args;
}

function decadeYears(decade: string): [number, number] {
  const m = decade.match(/^(\d{4})s$/);
  if (m) { const s = Number(m[1]); return [s, s + 9]; }
  return [2020, 2029];
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

interface CatalogRow {
  id: string;
  cardNumber?: string;
  playerName?: string;
  sport?: string;
  year?: number;
  setKey?: string;
}

interface SoldRow {
  price: number;
  soldAt: string;
}

interface SalesSummary {
  count: number;
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  median30d: number | null;
  median90d: number | null;
  median180d: number | null;
  medianAll: number | null;
  trendDirection: "up" | "down" | "flat";
  trendPct30dVs90d: number | null;
  updatedAt: string;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function computeSummary(rows: SoldRow[]): SalesSummary {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400_000;
  const cutoff90 = now - 90 * 86400_000;
  const cutoff180 = now - 180 * 86400_000;

  let firstMs = Infinity;
  let lastMs = 0;
  const px30: number[] = [];
  const px90: number[] = [];
  const px180: number[] = [];
  const pxAll: number[] = [];

  for (const r of rows) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    const t = Date.parse(r.soldAt);
    if (!Number.isFinite(t)) continue;
    if (t < firstMs) firstMs = t;
    if (t > lastMs) lastMs = t;
    pxAll.push(r.price);
    if (t >= cutoff30) px30.push(r.price);
    if (t >= cutoff90) px90.push(r.price);
    if (t >= cutoff180) px180.push(r.price);
  }

  const m30 = median(px30);
  const m90 = median(px90);
  const m180 = median(px180);
  const mAll = median(pxAll);

  let trendDirection: SalesSummary["trendDirection"] = "flat";
  let trendPct: number | null = null;
  if (m30 !== null && m90 !== null && m90 > 0) {
    const ratio = m30 / m90;
    trendPct = Math.round((ratio - 1) * 1000) / 10;
    if (trendPct > 1) trendDirection = "up";
    else if (trendPct < -1) trendDirection = "down";
  }

  return {
    count: pxAll.length,
    firstSaleAt: firstMs === Infinity ? null : new Date(firstMs).toISOString(),
    lastSaleAt: lastMs === 0 ? null : new Date(lastMs).toISOString(),
    median30d: m30,
    median90d: m90,
    median180d: m180,
    medianAll: mAll,
    trendDirection,
    trendPct30dVs90d: trendPct,
    updatedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  let yearMin: number, yearMax: number;
  if (args.year) { yearMin = args.year; yearMax = args.year; }
  else if (args.decade) { [yearMin, yearMax] = decadeYears(args.decade); }
  else { yearMin = 2020; yearMax = 2029; }

  console.log(`\n▸ Attach sales summary to catalog rows: ${yearMin}-${yearMax}${args.sport ? ` (${args.sport})` : ""}`);
  if (args.dryRun) console.log(`  DRY RUN`);

  const whereParts: string[] = ["c.year >= @a", "c.year <= @b", "STARTSWITH(c.id, 'hiq:')"];
  const params: Array<{ name: string; value: string | number }> = [
    { name: "@a", value: yearMin },
    { name: "@b", value: yearMax },
  ];
  if (args.sport) {
    whereParts.push("c.sport = @sport");
    params.push({ name: "@sport", value: args.sport });
  }

  console.log(`\n▸ Fetching canonical catalog rows...`);
  const iterator = cat.items.query<CatalogRow>({
    query: `SELECT c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey FROM c WHERE ${whereParts.join(" AND ")}`,
    parameters: params,
  }, { maxItemCount: 500 });
  const rows: CatalogRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  fetched ${rows.length}\r`);
  }
  console.log(`\n  ✓ ${rows.length} canonical catalog rows`);

  if (rows.length === 0) {
    console.log(`\n▸ Nothing to process.`);
    process.exit(0);
  }
  if (!args.autoApprove && !args.dryRun) {
    const ans = await ask(`\n  Attach sales summary to ${rows.length} rows? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) { console.log("Aborted."); process.exit(0); }
  }

  console.log(`\n▸ Attaching (concurrency 16)...`);
  const startedAt = Date.now();
  let patched = 0, empty = 0, errors = 0;
  let done = 0;
  const total = rows.length;
  const CONCURRENCY = 16;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (r) => {
      try {
        // Query sold_comps for this canonical slug
        const { resources: comps } = await sold.items.query<SoldRow>({
          query: "SELECT c.price, c.soldAt FROM c WHERE (c.cardId = @slug OR c.hobbyiqCardId = @slug) AND c.price > 0",
          parameters: [{ name: "@slug", value: r.id }],
        }, { maxItemCount: 500 }).fetchAll();
        if (comps.length === 0) {
          empty++;
          done++;
          return;
        }
        const summary = computeSummary(comps);
        if (args.dryRun) { patched++; done++; return; }
        await cat.item(r.id, r.id).patch([
          { op: "set", path: "/salesSummary", value: summary },
        ]);
        patched++;
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`\n  ! ${r.id}: ${(err as Error).message}`);
      }
      done++;
    }));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / elapsedSec;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(`  ...patched ${patched}, empty ${empty}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s eta ${etaSec}s\r`);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n▸ Done in ${elapsedSec}s:`);
  console.log(`   patched: ${patched}`);
  console.log(`   empty (no sales for slug): ${empty}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
