#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — price anomaly detection (Drew, 2026-08-04).
 *
 * "Card info first then we look at price to see if it matches and if it
 * doesn't we will throw into a verification."
 *
 * For every sold_comps row in a year+sport:
 *   1. Look up its catalog entry by canonical hobbyiqCardId
 *   2. Read the catalog entry's salesSummary (median180d, IQR, etc.)
 *   3. If sale price is outside the reasonable band, flag the comp:
 *        priceAnomaly = true
 *        priceAnomalyReason = "price-too-low" | "price-too-high"
 *        expectedMedian, expectedLow, expectedHigh
 *   4. Comps land in the verification queue via priceAnomaly=true.
 *
 * Rules (initial pass — tunable):
 *   - Skip when catalog entry has < 4 comps (not enough to judge)
 *   - Skip when sale is the ONLY comp for the slug (nothing to compare)
 *   - Bounds: 25% - 400% of median180d. Anything outside gets flagged.
 *   - Reason "price-too-low" when < 25%, "price-too-high" when > 400%.
 *
 * Usage:
 *   npx tsx backend/scripts/flag-price-anomalies.ts \
 *     --year YYYY --sport baseball [--dry-run] [--auto-approve]
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";

interface Args {
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
    if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--sport") { args.sport = val; i++; }
    else if (flag === "--dry-run") { args.dryRun = true; }
    else if (flag === "--auto-approve" || flag === "-y") { args.autoApprove = true; }
  }
  return args;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

interface SoldRow {
  id: string;
  cardId: string;
  hobbyiqCardId?: string;
  price: number;
  soldAt: string;
  playerName?: string;
  parallel?: string;
  cardNumber?: string;
}

interface SalesSummary {
  count: number;
  median180d: number | null;
  median90d: number | null;
  median30d: number | null;
  medianAll: number | null;
}

const LOW_FLOOR = 0.25;    // < 25% of median → flag as too-low
const HIGH_CEIL = 4.0;     // > 400% of median → flag as too-high
const MIN_CATALOG_COUNT = 4;

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) {
    console.error("Usage: flag-price-anomalies.ts --year <n> --sport <sport> [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`\n▸ Flag price anomalies for ${args.year} ${args.sport}`);
  if (args.dryRun) console.log(`  DRY RUN — no writes`);

  console.log(`\n▸ Scanning sold_comps...`);
  const iterator = sold.items.query<SoldRow>({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.price, c.soldAt, c.playerName, c.parallel, c.cardNumber FROM c WHERE c.cardYear = @y AND c.sport = @sport AND c.price > 0 AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)",
    parameters: [{ name: "@y", value: args.year }, { name: "@sport", value: args.sport }],
  }, { maxItemCount: 500 });
  const comps: SoldRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) comps.push(r);
    process.stdout.write(`  scanned ${comps.length}\r`);
  }
  console.log(`\n  ✓ ${comps.length} un-flagged comps to consider`);

  if (comps.length === 0) { console.log(`\n▸ Nothing to check.`); process.exit(0); }

  // Group comps by hobbyiqCardId (canonical slug) so we do one catalog
  // lookup per group.
  const bySlug = new Map<string, SoldRow[]>();
  for (const c of comps) {
    const key = c.hobbyiqCardId ?? c.cardId;
    if (!key) continue;
    let arr = bySlug.get(key);
    if (!arr) { arr = []; bySlug.set(key, arr); }
    arr.push(c);
  }
  console.log(`  ${bySlug.size} distinct catalog slugs`);

  console.log(`\n▸ Looking up catalog salesSummaries + flagging...`);
  const startedAt = Date.now();
  let flaggedLow = 0, flaggedHigh = 0, skippedThin = 0, skippedNoCatalog = 0, errors = 0;
  let done = 0;
  const total = bySlug.size;

  const CONCURRENCY = 16;
  const slugs = [...bySlug.entries()];
  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ([slug, groupComps]) => {
      try {
        // Read catalog entry
        const { resource: catEntry } = await cat.item(slug, slug).read();
        if (!catEntry) { skippedNoCatalog += groupComps.length; done++; return; }
        const summary = (catEntry as { salesSummary?: SalesSummary }).salesSummary;
        if (!summary || summary.count < MIN_CATALOG_COUNT) { skippedThin += groupComps.length; done++; return; }
        const median = summary.median180d ?? summary.medianAll ?? summary.median90d;
        if (!median || median <= 0) { skippedThin += groupComps.length; done++; return; }

        const lowBound = median * LOW_FLOOR;
        const highBound = median * HIGH_CEIL;

        for (const comp of groupComps) {
          if (comp.price < lowBound) {
            if (!args.dryRun) {
              await sold.item(comp.id, comp.cardId).patch([
                { op: "set", path: "/priceAnomaly", value: true },
                { op: "set", path: "/priceAnomalyReason", value: "price-too-low" },
                { op: "set", path: "/priceAnomalyMeta", value: {
                  expectedMedian: median,
                  expectedLow: lowBound,
                  expectedHigh: highBound,
                  actualPrice: comp.price,
                  flaggedAt: new Date().toISOString(),
                }},
              ]);
            }
            flaggedLow++;
          } else if (comp.price > highBound) {
            if (!args.dryRun) {
              await sold.item(comp.id, comp.cardId).patch([
                { op: "set", path: "/priceAnomaly", value: true },
                { op: "set", path: "/priceAnomalyReason", value: "price-too-high" },
                { op: "set", path: "/priceAnomalyMeta", value: {
                  expectedMedian: median,
                  expectedLow: lowBound,
                  expectedHigh: highBound,
                  actualPrice: comp.price,
                  flaggedAt: new Date().toISOString(),
                }},
              ]);
            }
            flaggedHigh++;
          }
        }
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`\n  ! ${slug}: ${(err as Error).message}`);
      }
      done++;
    }));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / elapsedSec;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(`  ...groups ${done}/${total} — flagged low ${flaggedLow}, high ${flaggedHigh} — ${rate.toFixed(1)}/s eta ${etaSec}s\r`);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n▸ Done in ${elapsedSec}s:`);
  console.log(`   flagged too-low:  ${flaggedLow}`);
  console.log(`   flagged too-high: ${flaggedHigh}`);
  console.log(`   skipped (thin catalog):    ${skippedThin}`);
  console.log(`   skipped (no catalog row):  ${skippedNoCatalog}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
