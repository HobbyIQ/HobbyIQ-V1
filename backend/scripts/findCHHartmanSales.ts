#!/usr/bin/env -S node --experimental-strip-types
// CF-CH-HARTMAN-GAP-DIAG (Drew, 2026-07-28). Compare Hartman CPA-EHA
// sales in ch_daily_sales vs sold_comps to see what CH knows about but
// we haven't unified into the pool. Also breaks down by parallel and
// print run so we can tell which specific pool would benefit most from
// a fill.
//
// Read-only. No writes.

import { CosmosClient } from "@azure/cosmos";

interface Row {
  price?: number;
  price_usd?: number;
  date?: string;
  sold_at?: string;
  card_set?: string;
  variant?: string;
  parallel?: string;
  parallel_name?: string;
  parallelName?: string;
  print_run?: number;
  printRun?: number;
  card_id?: string;
  cardId?: string;
  title?: string;
  hobbyiqCardId?: string;
  source?: string;
}

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const chDaily = db.container(process.env.COSMOS_CH_DAILY_CONTAINER ?? "ch_daily_sales");
  const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  // ─── ch_daily_sales scan ──────────────────────────────────────
  // Partitioned by /card_id — cross-partition query on cardNumber
  // substring is the pragmatic path. Also try player name.
  console.log(`\n▸ ch_daily_sales — Hartman CPA-EHA scan (last 180d)`);
  const cutoff180 = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const { resources: chRows } = await chDaily.items.query({
    query: `SELECT c.card_id, c.card_set, c.variant, c.price, c.price_usd, c.date, c.parallel, c.parallel_name, c.print_run, c.title
            FROM c
            WHERE (CONTAINS(UPPER(c.card_id), 'CPA-EHA') OR CONTAINS(UPPER(c.title ?? ''), 'CPA-EHA'))
              AND c.date >= @cutoff`,
    parameters: [{ name: "@cutoff", value: cutoff180 }],
  }).fetchAll();
  console.log(`  total rows: ${chRows.length}`);

  const byParallel: Record<string, { count: number; prices: number[]; sampleTitles: Set<string> }> = {};
  for (const r of chRows as Row[]) {
    const par = String(r.parallel ?? r.parallel_name ?? "unknown").toLowerCase();
    const key = `${par}${r.print_run ? " /" + r.print_run : ""}`;
    const price = Number(r.price ?? r.price_usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    (byParallel[key] ??= { count: 0, prices: [], sampleTitles: new Set() });
    byParallel[key].count += 1;
    byParallel[key].prices.push(price);
    if (r.card_set) byParallel[key].sampleTitles.add(String(r.card_set));
  }
  for (const [key, v] of Object.entries(byParallel).sort((a, b) => b[1].count - a[1].count)) {
    v.prices.sort((a, b) => a - b);
    const median = v.prices[Math.floor(v.prices.length / 2)];
    console.log(`  ${key.padEnd(48)}  n=${v.count.toString().padStart(4)}  median=$${median.toFixed(2).padStart(9)}  range=$${v.prices[0].toFixed(0)}-$${v.prices[v.prices.length - 1].toFixed(0)}`);
  }

  // ─── sold_comps CH count for the same identity ──────────────
  console.log(`\n▸ sold_comps — Hartman CPA-EHA (source=cardhedge), last 180d`);
  const cutoffIso = new Date(Date.now() - 180 * 86400000).toISOString();
  const { resources: scRows } = await soldComps.items.query({
    query: `SELECT c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.printRun
            FROM c
            WHERE UPPER(c.cardNumber ?? '') = 'CPA-EHA'
              AND c.source = 'cardhedge'
              AND c.soldAt >= @cutoff`,
    parameters: [{ name: "@cutoff", value: cutoffIso }],
  }).fetchAll();
  console.log(`  total rows: ${scRows.length}`);
  const scByParallel: Record<string, number> = {};
  for (const r of scRows as Row[]) {
    const key = `${String(r.parallel ?? "unknown").toLowerCase()}${r.printRun ? " /" + r.printRun : ""}`;
    scByParallel[key] = (scByParallel[key] ?? 0) + 1;
  }
  for (const [key, n] of Object.entries(scByParallel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(48)}  n=${n.toString().padStart(4)}`);
  }

  // ─── Gap analysis ───────────────────────────────────────────
  console.log(`\n▸ Gap: parallels/print-runs CH knows about that sold_comps missing OR under-counting`);
  for (const [chKey, chData] of Object.entries(byParallel)) {
    const scCount = scByParallel[chKey] ?? 0;
    const gap = chData.count - scCount;
    if (gap > 0) {
      console.log(`  ${chKey.padEnd(48)}  CH=${chData.count.toString().padStart(4)}  sold_comps=${scCount.toString().padStart(4)}  gap=+${gap}`);
    }
  }
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
