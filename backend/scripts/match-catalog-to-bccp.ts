#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-BCCP-MATCH (Drew, 2026-08-04).
 *
 * Joins pool-based canonical catalog rows to their authoritative
 * baseballcardpedia product-structure. Reads BCCP JSON from disk
 * (/tmp/bccp/{year}/{slug}.json — scraped by scrape-bccp-year.ts) and
 * card_catalog rows from Cosmos, then for each pool row:
 *
 *   1. Find the matching BCCP product by (year, setKey).
 *   2. Classify the card as base / parallel / insert / auto by looking
 *      at its parallel name + card-number prefix vs BCCP's enumeration.
 *   3. Look up the specific parallel entry — canonical name equality
 *      after canonicalizeParallelName() on both sides.
 *   4. Stamp fields on the catalog row:
 *        bccpProductPage:    "2024 Bowman Chrome"
 *        bccpMatchedAs:      "base" | "parallel" | "insert" | "auto"
 *        bccpParallelName:   "Gold Refractor" (when parallel)
 *        bccpPrintRun:       50               (from BCCP if present)
 *        bccpSubsetName:     "Prospect Autographs" (when insert/auto)
 *        bccpSubsetPrefix:   "CPA"
 *        bccpMatched:        true / false
 *        bccpMatchedAt:      ISO timestamp
 *
 * Rows with no matching BCCP product (product not scraped, or setKey
 * doesn't align) get bccpMatched=false + a reason field. Those become
 * follow-up work — either fix the setKey normalization or add the
 * product to the scrape list.
 *
 * Uses container.items.bulk() patch. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx backend/scripts/match-catalog-to-bccp.ts \
 *     --year YYYY --sport baseball [--indir /tmp/bccp] [--dry-run]
 */

import { CosmosClient } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  year?: number;
  sport?: string;
  indir?: string;
  dryRun?: boolean;
}
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball", indir: "c:/tmp/bccp" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--indir") { args.indir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
  }
  return args;
}

interface BccpParallel { section: string; name: string; printRun: number | null }
interface BccpSubset { name: string; cardPrefix: string | null; parallelCount?: number }
interface BccpProduct {
  page: string;
  year: number;
  parallels: BccpParallel[];
  inserts: BccpSubset[];
  autos: BccpSubset[];
  gameUsed: BccpSubset[];
  gimmicks: BccpSubset[];
}

interface BccpIndex {
  bySetKey: Map<string, BccpProduct[]>;   // multiple products can share setKey (e.g. Chrome + Chrome Update)
  byPrefix: Map<string, { subset: BccpSubset; product: BccpProduct; subsetType: "insert" | "auto" | "gameUsed" | "gimmick" }>;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Build a fast lookup index from the scraped JSON files for a given year. */
function buildBccpIndex(indir: string, year: number): BccpIndex {
  const dir = join(indir, String(year));
  try { statSync(dir); } catch { return { bySetKey: new Map(), byPrefix: new Map() }; }
  const files = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "products.json");
  const bySetKey = new Map<string, BccpProduct[]>();
  const byPrefix = new Map<string, { subset: BccpSubset; product: BccpProduct; subsetType: "insert" | "auto" | "gameUsed" | "gimmick" }>();
  for (const f of files) {
    let sp: BccpProduct;
    try { sp = JSON.parse(readFileSync(join(dir, f), "utf8")) as BccpProduct; }
    catch { continue; }
    // Strip year from page title, normalize to setKey.
    const withoutYear = sp.page.replace(/^\d{4}[_ -]/, "").replace(/_/g, " ");
    const setKey = normalizeSetKey(withoutYear);
    let arr = bySetKey.get(setKey);
    if (!arr) { arr = []; bySetKey.set(setKey, arr); }
    arr.push(sp);
    // Prefix index — first-wins to avoid clobbering (should be rare).
    const stamp = (list: BccpSubset[], subsetType: "insert" | "auto" | "gameUsed" | "gimmick"): void => {
      for (const sub of list) {
        if (!sub.cardPrefix) continue;
        const key = `${sp.year}:${sub.cardPrefix.toUpperCase()}`;
        if (!byPrefix.has(key)) byPrefix.set(key, { subset: sub, product: sp, subsetType });
      }
    };
    stamp(sp.inserts, "insert");
    stamp(sp.autos, "auto");
    stamp(sp.gameUsed, "gameUsed");
    stamp(sp.gimmicks, "gimmick");
  }
  return { bySetKey, byPrefix };
}

/** Extract the leading alphanumeric prefix from a card number: "BCP-150" → "BCP". */
function extractCardNumberPrefix(cardNumber: string | null | undefined): string | null {
  if (!cardNumber) return null;
  const m = String(cardNumber).match(/^([A-Za-z0-9]{2,6})-/);
  return m ? m[1].toUpperCase() : null;
}

/** Given a catalog row and BCCP index, decide what it matches. */
function classify(row: CatalogRow, index: BccpIndex): MatchResult {
  const prefix = extractCardNumberPrefix(row.cardNumber);
  // 1. If card number has a prefix that matches a known insert/auto/gu/gimmick subset for this year, that wins.
  if (prefix) {
    const hit = index.byPrefix.get(`${row.year}:${prefix}`);
    if (hit) {
      return {
        matched: true,
        matchedAs: hit.subsetType === "insert" ? "insert" : hit.subsetType === "auto" ? "auto" : hit.subsetType === "gameUsed" ? "gameUsed" : "gimmick",
        productPage: hit.product.page,
        subsetName: hit.subset.name,
        subsetPrefix: hit.subset.cardPrefix,
        parallelName: null,
        printRun: null,
      };
    }
  }
  // 2. Otherwise, look up the pool row's setKey in BCCP index.
  const products = index.bySetKey.get(row.setKey);
  if (!products || products.length === 0) {
    return { matched: false, reason: `no-BCCP-product-for-setKey-${row.setKey}` };
  }
  const product = products[0]; // pick first — refine later with cardNumber range matching if we need it
  // 3. If parallel is "Base" or empty, this is a base card.
  const parallelCanon = canonicalizeParallelName(row.parallel);
  if (!parallelCanon || parallelCanon.toLowerCase() === "base") {
    return {
      matched: true,
      matchedAs: "base",
      productPage: product.page,
      subsetName: null,
      subsetPrefix: null,
      parallelName: null,
      printRun: null,
    };
  }
  // 4. Look up the parallel in the product's parallel list — canonical name equality.
  const parallelCanonLower = parallelCanon.toLowerCase();
  for (const p of product.parallels) {
    if (canonicalizeParallelName(p.name).toLowerCase() === parallelCanonLower) {
      return {
        matched: true,
        matchedAs: "parallel",
        productPage: product.page,
        subsetName: null,
        subsetPrefix: null,
        parallelName: p.name,
        printRun: p.printRun,
      };
    }
  }
  // 5. Parallel not found in BCCP — still a parallel, but with no BCCP-verified name.
  return {
    matched: false,
    reason: `parallel-not-in-BCCP:${parallelCanon}`,
    matchedAs: "parallel-unverified",
    productPage: product.page,
  };
}

interface CatalogRow { id: string; cardId: string; year: number; setKey: string; cardNumber?: string; parallel?: string; isAuto?: boolean }
interface MatchResult {
  matched: boolean;
  matchedAs?: "base" | "parallel" | "insert" | "auto" | "gameUsed" | "gimmick" | "parallel-unverified";
  productPage?: string;
  subsetName?: string | null;
  subsetPrefix?: string | null;
  parallelName?: string | null;
  printRun?: number | null;
  reason?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) { console.error("Usage: match-catalog-to-bccp.ts --year YYYY --sport <sport> [--dry-run]"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const indir = args.indir ?? "/tmp/bccp";
  console.log(`\n▸ Building BCCP index from ${indir}/${args.year}...`);
  const index = buildBccpIndex(indir, args.year);
  console.log(`  ${index.bySetKey.size} distinct BCCP setKeys, ${index.byPrefix.size} insert/auto prefixes`);
  if (index.bySetKey.size === 0) { console.error("  ! No BCCP data for this year — run scrape-bccp-year first."); process.exit(1); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n▸ Scanning card_catalog for pool-based rows (year=${args.year}, sport=${args.sport}, source=bulk-build-from-pool)...`);
  const iterator = cat.items.query<CatalogRow>({
    query: "SELECT c.id, c.cardId, c.year, c.setKey, c.cardNumber, c.parallel, c.isAuto FROM c WHERE c.sport = @sport AND c.year = @year AND c.source = 'bulk-build-from-pool'",
    parameters: [{ name: "@sport", value: args.sport }, { name: "@year", value: args.year }],
  }, { maxItemCount: 500 });
  const rows: CatalogRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  scanned ${rows.length}\r`);
  }
  console.log(`\n  ✓ ${rows.length} rows to match`);
  if (rows.length === 0) process.exit(0);

  // Classify all rows.
  const classifications = new Map<string, MatchResult>();
  const stats = { base: 0, parallel: 0, insert: 0, auto: 0, gameUsed: 0, gimmick: 0, "parallel-unverified": 0, unmatched: 0 };
  for (const row of rows) {
    const result = classify(row, index);
    classifications.set(row.id, result);
    if (result.matched) stats[result.matchedAs as keyof typeof stats]++;
    else if (result.matchedAs) stats[result.matchedAs as keyof typeof stats]++;
    else stats.unmatched++;
  }
  console.log(`\n▸ Classification totals:`);
  for (const [k, v] of Object.entries(stats)) console.log(`   ${k.padEnd(22)} ${v}`);

  if (args.dryRun) { console.log("\n▸ DRY RUN — no writes."); process.exit(0); }

  console.log(`\n▸ Patching card_catalog...`);
  const startedAt = Date.now();
  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  let patched = 0, errors = 0, done = 0;
  const total = rows.length;
  const chunks: CatalogRow[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  async function runChunk(chunk: CatalogRow[]): Promise<void> {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const now = new Date().toISOString();
      const ops = pending.map((row) => {
        const m = classifications.get(row.id)!;
        const setOps: Array<{ op: "set" | "add"; path: string; value: unknown }> = [
          { op: "set", path: "/bccpMatched", value: m.matched },
          { op: "set", path: "/bccpMatchedAt", value: now },
        ];
        if (m.matchedAs) setOps.push({ op: "set", path: "/bccpMatchedAs", value: m.matchedAs });
        if (m.productPage) setOps.push({ op: "set", path: "/bccpProductPage", value: m.productPage });
        if (m.parallelName) setOps.push({ op: "set", path: "/bccpParallelName", value: m.parallelName });
        if (m.printRun !== null && m.printRun !== undefined) setOps.push({ op: "set", path: "/bccpPrintRun", value: m.printRun });
        if (m.subsetName) setOps.push({ op: "set", path: "/bccpSubsetName", value: m.subsetName });
        if (m.subsetPrefix) setOps.push({ op: "set", path: "/bccpSubsetPrefix", value: m.subsetPrefix });
        if (m.reason) setOps.push({ op: "set", path: "/bccpNotMatchedReason", value: m.reason });
        return { operationType: "Patch" as const, id: row.id, partitionKey: row.id, resourceBody: { operations: setOps } };
      });
      try {
        const results = await cat.items.bulk(ops);
        const next: CatalogRow[] = [];
        let maxRetryAfterMs = 0;
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.statusCode >= 200 && r.statusCode < 300) { patched++; done++; }
          else if (r.statusCode === 429) {
            next.push(pending[j]);
            const ra = (r as { retryAfterMilliseconds?: number }).retryAfterMilliseconds;
            if (typeof ra === "number" && ra > maxRetryAfterMs) maxRetryAfterMs = ra;
          } else { errors++; done++; }
        }
        pending = next;
        if (pending.length > 0) {
          attempt++;
          const wait = Math.max(maxRetryAfterMs, 200 * Math.pow(2, Math.min(attempt, 6)));
          await new Promise((r) => setTimeout(r, wait));
        }
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/request rate is too large/i.test(msg) && attempt < MAX_RETRIES) {
          attempt++;
          const wait = 200 * Math.pow(2, Math.min(attempt, 6));
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        errors += pending.length; done += pending.length;
        return;
      }
    }
    if (pending.length > 0) { errors += pending.length; done += pending.length; }
  }

  for (let i = 0; i < chunks.length; i += PARALLEL_BULKS) {
    const batch = chunks.slice(i, i + PARALLEL_BULKS);
    await Promise.all(batch.map(runChunk));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(1, elapsedSec);
    process.stdout.write(`  ...patched ${patched}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s\r`);
  }
  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s: patched=${patched}, errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
