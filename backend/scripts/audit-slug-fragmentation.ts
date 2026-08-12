#!/usr/bin/env -S npx tsx
/**
 * CF-SLUG-FRAGMENTATION-AUDIT (Drew, 2026-08-06).
 *
 * Scans sold_comps for cards where the SAME physical card
 * (player + year + cardNumber + normalized parallel + isAuto) landed
 * across multiple hobbyiqCardId slug variants. Those are the cases
 * where our slug generator produced inconsistent output over time —
 * e.g. Eric Hartman CPA-EHA Orange Shimmer Refractor Auto shows up
 * under:
 *
 *   hiq:baseball:2026:bowman-chrome:cpa-eha:orange-shimmer-refractor:auto
 *   hiq:baseball:2026:bowman:cpa-eha:orange-shimmer-refractor:auto
 *   hiq:baseball:2026:bowman-chrome:cpa-eha:orange-shimmer-refractor:no-auto
 *   hiq:baseball:2026:bowman:cpa-eha:orange-shimmer-refractor:auto:num-25
 *   ...
 *
 * Each variant hides some sales from the direct-slug pool, forcing
 * the FMV rung to fall back to composite-neighbor (wider pool,
 * cross-player) which gives wrong prices.
 *
 * Report — no writes. Groups by fingerprint, reports top clusters by
 * (fragmentation count × total sales) impact.
 *
 * Env:
 *   FRAG_TOP     top-N clusters to print; default 30
 *   FRAG_MIN_N   ignore fingerprints with fewer than N total sales; default 3
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const TOP = Number(process.env.FRAG_TOP ?? 30);
const MIN_N = Number(process.env.FRAG_MIN_N ?? 3);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

interface Row {
  hobbyiqCardId?: string;
  playerName?: string;
  cardYear?: number;
  cardNumber?: string;
  parallelSlug?: string;
  parallel?: string;
  isAuto?: boolean;
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().trim();
}

function fingerprint(r: Row): string | null {
  if (!r.playerName || !r.cardYear || !r.cardNumber) return null;
  // parallelSlug is the post-canonicalizer form; fall back to
  // normalized parallel for legacy rows that haven't been backfilled.
  const par = r.parallelSlug ? norm(r.parallelSlug) : norm(r.parallel).replace(/\s+/g, "-");
  const auto = r.isAuto ? "auto" : "no-auto";
  return `${norm(r.playerName)}|${r.cardYear}|${norm(r.cardNumber)}|${par}|${auto}`;
}

async function main(): Promise<void> {
  console.log(`▸ Slug-fragmentation audit — scanning sold_comps`);
  const it = sc.items.query<Row>({
    query: `SELECT c.hobbyiqCardId, c.playerName, c.cardYear, c.cardNumber, c.parallelSlug, c.parallel, c.isAuto
            FROM c WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND IS_DEFINED(c.playerName) AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.cardNumber)`,
  }, { maxItemCount: 500 });

  // Map fingerprint → Map<slug, saleCount>
  const buckets = new Map<string, Map<string, number>>();
  let scanned = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    let batch: Row[] = [];
    try {
      const { resources } = await it.fetchNext();
      batch = resources;
    } catch (e) {
      console.error(`  ! fetchNext: ${(e as Error).message}`);
      continue;
    }
    for (const r of batch) {
      scanned++;
      const fp = fingerprint(r);
      if (!fp) continue;
      const slug = String(r.hobbyiqCardId);
      let slugMap = buckets.get(fp);
      if (!slugMap) { slugMap = new Map(); buckets.set(fp, slugMap); }
      slugMap.set(slug, (slugMap.get(slug) ?? 0) + 1);
    }
    const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanning: ${scanned.toLocaleString()} rows, ${buckets.size.toLocaleString()} fingerprints  ${Math.round(scanned / el)}/s\r`);
  }

  console.log(`\n\n▸ Scan complete: ${scanned.toLocaleString()} rows → ${buckets.size.toLocaleString()} unique fingerprints`);

  // Find fragmented fingerprints (more than one slug per fingerprint)
  const fragmented: Array<{ fp: string; slugs: Array<{ slug: string; n: number }>; totalSales: number; slugCount: number; impact: number }> = [];
  for (const [fp, slugMap] of buckets) {
    if (slugMap.size <= 1) continue;
    const totalSales = [...slugMap.values()].reduce((s, n) => s + n, 0);
    if (totalSales < MIN_N) continue;
    const slugs = [...slugMap.entries()].map(([slug, n]) => ({ slug, n })).sort((a, b) => b.n - a.n);
    fragmented.push({ fp, slugs, totalSales, slugCount: slugMap.size, impact: totalSales * (slugMap.size - 1) });
  }

  console.log(`▸ Fragmented fingerprints: ${fragmented.length.toLocaleString()}  (same card, multiple slugs)`);
  const totalFragmentedRows = fragmented.reduce((s, f) => s + f.totalSales, 0);
  const totalOrphanedRows = fragmented.reduce((s, f) => s + f.slugs.slice(1).reduce((ss, x) => ss + x.n, 0), 0);
  console.log(`▸ Total sales sitting on fragmented cards: ${totalFragmentedRows.toLocaleString()}`);
  console.log(`▸ Sales stranded off the majority slug: ${totalOrphanedRows.toLocaleString()}  (these hide from direct-slug lookups)`);

  console.log(`\n▸ Top ${TOP} by impact (sales × slug-variants):\n`);
  fragmented.sort((a, b) => b.impact - a.impact);
  for (const f of fragmented.slice(0, TOP)) {
    const [player, year, num, par, auto] = f.fp.split("|");
    console.log(`\n  ${player}  ${year}  #${num}  ${par}  ${auto}  — ${f.totalSales} sales across ${f.slugCount} slugs`);
    for (const s of f.slugs) console.log(`    ${String(s.n).padStart(4)}  ${s.slug}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
