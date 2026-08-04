#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — decade organization analysis (Drew, 2026-08-04).
 *
 * Scans card_catalog for a decade (default 2020s), counts how many
 * rows are canonical (hiq: slug id) vs non-canonical (vendor UUID),
 * groups non-canonical rows by their would-be canonical slug to find
 * duplicate clusters, and reports the top redundancy.
 *
 * Read-only — no writes. Use this to decide whether to run a dedup pass.
 *
 * Usage:
 *   npx tsx backend/scripts/analyze-catalog-decade.ts \
 *     [--decade 2020s] [--year YYYY]
 */

import { CosmosClient } from "@azure/cosmos";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  decade?: string;   // "2020s", "2010s", "2000s"
  year?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--decade") { args.decade = val; i++; }
    else if (flag === "--year") { args.year = Number(val); i++; }
  }
  return args;
}

interface CatalogRow {
  id: string;
  cardNumber?: string;
  parallel?: string;
  parallelSlug?: string;
  isAuto?: boolean;
  playerName?: string;
  sport?: string;
  year?: number;
  setKey?: string;
  setName?: string;
  source?: string;
  hobbyiqCardId?: string;
}

function decadeYears(decade: string): [number, number] {
  const m = decade.match(/^(\d{4})s$/);
  if (m) {
    const start = Number(m[1]);
    return [start, start + 9];
  }
  return [2020, 2029];
}

async function main(): Promise<void> {
  const args = parseArgs();
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  let yearMin: number, yearMax: number;
  if (args.year) { yearMin = args.year; yearMax = args.year; }
  else if (args.decade) { [yearMin, yearMax] = decadeYears(args.decade); }
  else { yearMin = 2020; yearMax = 2029; }

  console.log(`\n▸ Analyzing card_catalog for ${yearMin}-${yearMax}...`);

  // Scan all catalog rows in the year range.
  const { resources: rows } = await cat.items.query<CatalogRow>({
    query: "SELECT c.id, c.cardNumber, c.parallel, c.parallelSlug, c.isAuto, c.playerName, c.sport, c.year, c.setKey, c[\"set\"] AS setName, c.source, c.hobbyiqCardId FROM c WHERE c.year >= @a AND c.year <= @b",
    parameters: [{ name: "@a", value: yearMin }, { name: "@b", value: yearMax }],
  }).fetchAll();

  console.log(`  ✓ ${rows.length} total catalog rows in ${yearMin}-${yearMax}`);

  // Bucket by source
  const bySource = new Map<string, number>();
  const byCanonicalityType = { canonical: 0, vendor: 0, other: 0 };
  const missingIdentity: CatalogRow[] = [];

  // Group by target canonical slug
  const clusters = new Map<string, CatalogRow[]>();

  for (const r of rows) {
    const src = r.source ?? "(none)";
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
    if (r.id?.startsWith("hiq:")) byCanonicalityType.canonical++;
    else if (r.id?.includes("::") || r.id?.includes("x")) byCanonicalityType.vendor++;
    else byCanonicalityType.other++;

    if (!r.cardNumber || !r.sport || !r.year) {
      missingIdentity.push(r);
      continue;
    }
    const setName = r.setName ?? r.setKey ?? "";
    if (!setName) { missingIdentity.push(r); continue; }
    let canonicalSlug: string;
    try {
      canonicalSlug = computeHobbyIqCardId({
        sport: r.sport,
        year: r.year,
        setKey: normalizeSetKey(setName),
        cardNumber: r.cardNumber,
        parallel: canonicalizeParallelName(r.parallel ?? "Base"),
        isAuto: r.isAuto === true,
        printRun: null,
      });
    } catch {
      missingIdentity.push(r);
      continue;
    }
    let arr = clusters.get(canonicalSlug);
    if (!arr) { arr = []; clusters.set(canonicalSlug, arr); }
    arr.push(r);
  }

  console.log(`\n▸ By source (top 10):`);
  const sourceRows = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  for (const [src, n] of sourceRows.slice(0, 10)) {
    console.log(`  ${src.padEnd(24)} ${n.toString().padStart(8)}`);
  }

  console.log(`\n▸ By id type:`);
  console.log(`  canonical (hiq:*)         ${byCanonicalityType.canonical.toString().padStart(8)}`);
  console.log(`  vendor-format id          ${byCanonicalityType.vendor.toString().padStart(8)}`);
  console.log(`  other                     ${byCanonicalityType.other.toString().padStart(8)}`);

  console.log(`\n▸ Deduplication clusters`);
  console.log(`  distinct canonical slugs derivable:  ${clusters.size}`);
  console.log(`  rows unable to compute slug:         ${missingIdentity.length}`);

  // Duplicate depth distribution
  const depthCounts = new Map<number, number>();
  let dupTotal = 0;
  for (const arr of clusters.values()) {
    depthCounts.set(arr.length, (depthCounts.get(arr.length) ?? 0) + 1);
    if (arr.length > 1) dupTotal += arr.length - 1;
  }
  console.log(`  clusters with 1 row (no dup):        ${depthCounts.get(1) ?? 0}`);
  const dupClusters = [...depthCounts.entries()].filter(([d]) => d > 1).sort((a, b) => a[0] - b[0]);
  for (const [d, n] of dupClusters.slice(0, 10)) {
    console.log(`  clusters with ${d.toString().padStart(3)} rows:                 ${n.toString().padStart(6)}`);
  }
  console.log(`  redundant rows (would be removed):   ${dupTotal}`);

  // Top-5 largest clusters (deep dupes)
  console.log(`\n▸ Top-8 deepest duplicate clusters:`);
  const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [slug, arr] of sorted.slice(0, 8)) {
    if (arr.length <= 1) break;
    const players = new Set(arr.map((r) => r.playerName ?? "?"));
    const sources = new Set(arr.map((r) => r.source ?? "?"));
    console.log(`  ${slug}`);
    console.log(`    depth: ${arr.length}, players seen: ${[...players].slice(0, 3).join(", ")}, sources: ${[...sources].join(", ")}`);
  }

  console.log(`\n▸ Bottom line`);
  const potentialReduction = dupTotal;
  const pct = rows.length > 0 ? Math.round((potentialReduction / rows.length) * 1000) / 10 : 0;
  console.log(`  ${rows.length} rows → ${rows.length - potentialReduction} unique (drops ${potentialReduction}, ${pct}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
