#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-BCCP-IMPORT (Drew, 2026-08-04).
 *
 * Reads scraped baseballcardpedia JSON from /tmp/bccp/{year}/*.json and
 * upserts each product's structure into the existing card_catalog Cosmos
 * container. Uses a distinct id prefix so these product-structure docs
 * don't collide with the pool-based canonical-slug catalog rows.
 *
 * ID convention:
 *   id = "product-structure:{year}-{slugified-page}"
 *   e.g.  product-structure:2024-bowman-chrome
 *
 * A product-structure doc records EVERY parallel, insert set, and auto
 * subset for a product, with print runs where the wiki has them. Later
 * merge steps can:
 *   - enumerate canonical-slug catalog rows for parallels we haven't
 *     seen sold_comps for yet
 *   - enrich existing canonical rows with printRun / cardPrefix data
 *
 * Uses container.items.bulk() (batches of 50) with 429 retry, same
 * pattern as bulk-build-catalog.ts. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx backend/scripts/import-bccp-to-catalog.ts [--year YYYY|--all] \
 *     [--sport baseball] [--indir /tmp/bccp] [--dry-run] [--auto-approve]
 */

import { CosmosClient, type JSONObject } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { normalizeSetKey, deriveBrand, deriveParentSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  year?: number;
  all?: boolean;
  sport?: string;
  indir?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball", indir: "c:/tmp/bccp" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--all") args.all = true;
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--indir") { args.indir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
    else if (f === "--auto-approve" || f === "-y") args.autoApprove = true;
  }
  return args;
}

interface ScrapedProduct {
  page: string;
  year: number;
  parallels: Array<{ section: string; name: string; printRun: number | null }>;
  inserts: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  autos: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  gameUsed: Array<{ name: string; cardPrefix: string | null }>;
  gimmicks: Array<{ name: string; cardPrefix: string | null }>;
  fetchedAt: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function collectYearDirs(indir: string, args: Args): string[] {
  const all = readdirSync(indir).filter((n) => /^\d{4}$/.test(n));
  const dirs = args.year ? all.filter((n) => Number(n) === args.year) : all;
  return dirs.sort();
}

function collectProductFiles(yearDir: string): string[] {
  return readdirSync(yearDir)
    .filter((n) => n.endsWith(".json") && n !== "products.json")
    .map((n) => join(yearDir, n));
}

function buildDoc(sp: ScrapedProduct, sport: string): JSONObject {
  // Strip the leading year from the page title so we don't double-count
  // year in the derived setName.
  const withoutYear = sp.page.replace(/^\d{4}[_ -]/, "").replace(/_/g, " ");
  const setKey = normalizeSetKey(withoutYear);
  const brand = deriveBrand(setKey);
  const parentSetKey = deriveParentSetKey(setKey);
  const productSlug = slugify(sp.page);
  const id = `product-structure:${productSlug}`;
  return {
    id,
    cardId: id,
    productKey: `${sp.year}-${slugify(withoutYear)}`,
    year: sp.year,
    sport,
    brand,
    setKey,
    parentSetKey,
    setName: withoutYear,
    productName: sp.page.replace(/_/g, " "),
    parallels: sp.parallels,
    inserts: sp.inserts,
    autos: sp.autos,
    gameUsed: sp.gameUsed,
    gimmicks: sp.gimmicks,
    parallelCount: sp.parallels.length,
    insertCount: sp.inserts.length,
    autoCount: sp.autos.length,
    gameUsedCount: sp.gameUsed.length,
    gimmickCount: sp.gimmicks.length,
    hasStructure: (sp.parallels.length + sp.inserts.length + sp.autos.length + sp.gameUsed.length + sp.gimmicks.length) > 0,
    source: "bccp-product-structure",
    sourcePage: sp.page,
    fetchedAt: sp.fetchedAt,
    lastImportedAt: new Date().toISOString(),
    // Searchable tokens so /api/catalog/search can find product-structure
    // docs by year/brand/setKey terms.
    searchTokens: Array.from(new Set([
      String(sp.year),
      sport,
      brand,
      ...setKey.split("-").filter(Boolean),
      ...withoutYear.toLowerCase().split(/\s+/).filter(Boolean),
    ])),
  } as JSONObject;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year && !args.all) {
    console.error("Usage: import-bccp-to-catalog.ts (--year YYYY | --all) [--sport baseball] [--indir /tmp/bccp] [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn && !args.dryRun) { console.error("COSMOS_CONNECTION_STRING required unless --dry-run"); process.exit(2); }

  const indir = args.indir ?? "/tmp/bccp";
  try { statSync(indir); } catch { console.error(`Input dir not found: ${indir}`); process.exit(2); }
  const yearDirs = collectYearDirs(indir, args);
  if (yearDirs.length === 0) { console.error("No matching year directories"); process.exit(0); }
  console.log(`\n▸ Importing ${yearDirs.length} year(s) of BCCP scrapes: ${yearDirs.slice(0, 6).join(", ")}${yearDirs.length > 6 ? "..." : ""}`);

  // Collect all docs first — cheap since scraped JSON is small.
  const docs: JSONObject[] = [];
  for (const yd of yearDirs) {
    const files = collectProductFiles(join(indir, yd));
    for (const f of files) {
      try {
        const sp = JSON.parse(readFileSync(f, "utf8")) as ScrapedProduct;
        const doc = buildDoc(sp, args.sport ?? "baseball");
        docs.push(doc);
      } catch (err) {
        console.warn(`  ! failed to parse ${f}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`  ✓ built ${docs.length} product-structure docs from JSON`);
  if (docs.length === 0) process.exit(0);

  // Quick doc stats.
  const withStructure = docs.filter((d) => (d as { hasStructure: boolean }).hasStructure).length;
  console.log(`  with parallels/inserts/autos: ${withStructure} / ${docs.length}`);

  if (args.dryRun) {
    console.log("\n▸ DRY RUN — no writes. First 3 docs:");
    docs.slice(0, 3).forEach((d) => console.log("  " + (d as { id: string }).id + " parallels=" + (d as { parallelCount: number }).parallelCount + " inserts=" + (d as { insertCount: number }).insertCount + " autos=" + (d as { autoCount: number }).autoCount));
    process.exit(0);
  }

  const client = new CosmosClient(conn as string);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  console.log(`\n▸ Upserting via bulk() (chunk ${CHUNK}, parallel ${PARALLEL_BULKS}, max ${MAX_RETRIES} retries)...`);
  const startedAt = Date.now();
  let upserted = 0, errors = 0, done = 0;
  const total = docs.length;
  const chunks: JSONObject[][] = [];
  for (let i = 0; i < docs.length; i += CHUNK) chunks.push(docs.slice(i, i + CHUNK));

  async function runChunk(chunk: JSONObject[]): Promise<void> {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const ops = pending.map((d) => ({
        operationType: "Upsert" as const,
        partitionKey: (d as { id: string }).id,
        resourceBody: d,
      }));
      try {
        const results = await cat.items.bulk(ops);
        const next: JSONObject[] = [];
        let maxRetryAfterMs = 0;
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.statusCode >= 200 && r.statusCode < 300) { upserted++; done++; }
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
    const rate = done / Math.max(1, (Date.now() - startedAt) / 1000);
    process.stdout.write(`  ...upserted ${upserted}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s\r`);
  }

  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s: upserted=${upserted}, errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
