#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-CLC-IMPORT (Drew, 2026-08-05).
 *
 * Reads scraped checklistcenter JSON from c:/tmp/clc/{year}/*.json and
 * upserts each product as a product-structure doc into card_catalog
 * with source="clc-product-structure". Complements BCCP data —
 * particularly for 2026 (BCCP doesn't cover) and gap products.
 *
 * ID convention:
 *   id = "product-structure-clc:{sourceSlug}"
 *   e.g.  product-structure-clc:2026-bowman-baseball-card-checklist
 *
 * Uses bulk() upsert with 429-retry. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx backend/scripts/import-clc-to-catalog.ts [--year YYYY|--all] \
 *     [--indir c:/tmp/clc] [--dry-run] [--auto-approve]
 */

import { CosmosClient, type JSONObject } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { normalizeSetKey, deriveBrand } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args { year?: number; all?: boolean; indir?: string; dryRun?: boolean; autoApprove?: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { indir: "c:/tmp/clc" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--all") args.all = true;
    else if (f === "--indir") { args.indir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
    else if (f === "--auto-approve" || f === "-y") args.autoApprove = true;
  }
  return args;
}

interface ClcSubset {
  title: string;
  cardCount: number | null;
  parallels: Array<{ name: string; printRun: number | null }>;
}

interface ClcProduct {
  url: string;
  sourceSlug: string;
  productName: string;
  year: number | null;
  sport: string;
  subsets: ClcSubset[];
  fetchedAt: string;
}

/** Extract product base name from CLC slug: "2026-bowman-baseball-card-checklist"
 *  → "bowman". Strip year prefix + "-baseball-card-checklist" suffix. */
function productBaseName(slug: string): string {
  return slug
    .replace(/^\d{4}[-_]/, "")
    .replace(/[-_]baseball[-_]card[-_]checklist$/, "")
    .replace(/[-_]card[-_]checklist$/, "")
    .replace(/[-_]checklist$/, "");
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
  return readdirSync(yearDir).filter((n) => n.endsWith(".json")).map((n) => join(yearDir, n));
}

function buildDoc(p: ClcProduct): JSONObject | null {
  if (!p.year || Number.isNaN(p.year)) return null;
  const baseName = productBaseName(p.sourceSlug);
  const setKey = normalizeSetKey(baseName.replace(/-/g, " "));
  const brand = deriveBrand(setKey);
  const id = `product-structure-clc:${p.sourceSlug}`;
  // Flatten every parallel across every subset into one parallels array,
  // tagged with the subset title (matches BCCP scrape shape).
  const parallels = p.subsets.flatMap((s) =>
    s.parallels.map((par) => ({ section: s.title, name: par.name, printRun: par.printRun }))
  );
  const subsetsMeta = p.subsets
    .filter((s) => s.cardCount != null)
    .map((s) => ({ name: s.title, cardCount: s.cardCount }));
  return {
    id,
    cardId: id,
    productKey: `clc-${p.sourceSlug}`,
    year: p.year,
    sport: p.sport,
    brand,
    setKey,
    setName: baseName.replace(/-/g, " "),
    productName: p.productName,
    parallels,
    parallelCount: parallels.length,
    subsets: subsetsMeta,
    subsetCount: subsetsMeta.length,
    hasStructure: parallels.length > 0 || subsetsMeta.length > 0,
    source: "clc-product-structure",
    sourceUrl: p.url,
    sourceSlug: p.sourceSlug,
    fetchedAt: p.fetchedAt,
    lastImportedAt: new Date().toISOString(),
    searchTokens: Array.from(new Set([
      String(p.year), p.sport, brand,
      ...setKey.split("-").filter(Boolean),
      ...baseName.split(/[-_]/).filter(Boolean),
    ])),
  } as JSONObject;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year && !args.all) {
    console.error("Usage: import-clc-to-catalog.ts (--year YYYY | --all) [--indir c:/tmp/clc] [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn && !args.dryRun) { console.error("COSMOS_CONNECTION_STRING required unless --dry-run"); process.exit(2); }
  const indir = args.indir ?? "c:/tmp/clc";
  try { statSync(indir); } catch { console.error(`Input dir not found: ${indir}`); process.exit(2); }
  const yearDirs = collectYearDirs(indir, args);
  if (yearDirs.length === 0) { console.error("No matching year directories"); process.exit(0); }
  console.log(`\n▸ Importing ${yearDirs.length} year(s) of CLC scrapes: ${yearDirs.slice(0, 6).join(", ")}${yearDirs.length > 6 ? "..." : ""}`);

  const docs: JSONObject[] = [];
  for (const yd of yearDirs) {
    const files = collectProductFiles(join(indir, yd));
    for (const f of files) {
      try {
        const sp = JSON.parse(readFileSync(f, "utf8")) as ClcProduct;
        const doc = buildDoc(sp);
        if (doc) docs.push(doc);
      } catch (err) {
        console.warn(`  ! failed to parse ${f}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`  ✓ built ${docs.length} CLC product-structure docs`);
  const withStructure = docs.filter((d) => (d as { hasStructure: boolean }).hasStructure).length;
  console.log(`  with parallels/subsets: ${withStructure} / ${docs.length}`);

  if (args.dryRun) {
    console.log("\n▸ DRY RUN. Sample:");
    docs.slice(0, 3).forEach((d) => console.log("  " + (d as { id: string }).id + " parallels=" + (d as { parallelCount: number }).parallelCount + " subsets=" + (d as { subsetCount: number }).subsetCount));
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
  void slugify;
}

main().catch((e) => { console.error(e); process.exit(1); });
