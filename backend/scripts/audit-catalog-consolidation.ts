#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-CONSOLIDATION-AUDIT (Drew, 2026-08-06).
 *
 * Phase 1 of the catalog consolidation project. Read-only.
 *
 * For every physical-card fingerprint
 * (playerName + cardYear + cardNumber + parallelSlug), list every
 * card_catalog row + its sold_comps attachment count. Cases with >1
 * catalog row for the same fingerprint are the duplicates we need to
 * consolidate.
 *
 * Also identifies fingerprints where the isAuto bit disagrees across
 * catalog rows (real bug: same physical Auto card indexed once as
 * auto=true and once as auto=false, both with sales).
 *
 * Output written to scratchpad as JSON so Phase 2 can consume it
 * without re-scanning.
 *
 * Env:
 *   AUDIT_TOP    top-N messiest fingerprints to print inline; default 30
 *   AUDIT_OUT    output JSON path; default scratchpad/catalog-consolidation-audit.json
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import * as fs from "node:fs";
import * as path from "node:path";

const TOP = Number(process.env.AUDIT_TOP ?? 30);
const OUT = process.env.AUDIT_OUT ?? "C:\\Users\\dvabu\\AppData\\Local\\Temp\\claude\\c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1\\44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7\\scratchpad\\catalog-consolidation-audit.json";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const db = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const catalog: Container = db.container("card_catalog");
const soldComps: Container = db.container("sold_comps");

interface CatRow {
  id: string;
  cardId?: string;
  kind?: string;
  source?: string;
  setKey?: string;
  playerName?: string;
  player?: string;
  cardNumber?: string;
  number?: string;
  cardYear?: number;
  year?: number;
  parallel?: string;
  parallelSlug?: string;
  isAuto?: boolean;
}

interface CatalogVariant {
  catId: string;
  slug: string | null;   // hobbyiqCardId equivalent (from id or cardId)
  setKey: string;
  isAuto: boolean;
  kind: string;
  source: string;
  soldCompsCount: number;
}

interface FingerprintGroup {
  fp: string;
  playerName: string;
  cardYear: number | null;
  cardNumber: string;
  parallelSlug: string;
  variants: CatalogVariant[];
  totalCatalogRows: number;
  totalSoldComps: number;
  distinctSlugs: number;
  isAutoDisagrees: boolean;
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().trim();
}

function fingerprint(r: CatRow): { key: string; player: string; year: number | null; num: string; par: string } | null {
  const player = norm(r.playerName ?? r.player);
  const num = norm(r.cardNumber ?? r.number);
  if (!player || !num) return null;
  const year = typeof r.cardYear === "number" ? r.cardYear : typeof r.year === "number" ? r.year : null;
  const par = r.parallelSlug ? norm(r.parallelSlug) : norm(r.parallel).replace(/\s+/g, "-");
  const key = `${player}|${year ?? "?"}|${num}|${par}`;
  return { key, player, year, num, par };
}

function extractSlug(r: CatRow): string | null {
  // Card kind: id="card::hiq:...", cardId="hiq:..."; use cardId
  if (r.kind === "card" && r.cardId) return r.cardId;
  // Variant/grade: id has kind:: prefix
  if (r.kind && r.id.startsWith(r.kind + "::")) return r.id.slice(r.kind.length + 2);
  // Legacy vendor rows: id IS the slug
  if (r.id?.startsWith("hiq:")) return r.id;
  // Canonical rebuild rows: id="canonical::hiq:..."
  if (r.id?.startsWith("canonical::")) return r.id.slice("canonical::".length);
  return r.id ?? null;
}

async function countSoldComps(slug: string): Promise<number> {
  try {
    const { resources } = await soldComps.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s AND c.price > 0",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    return resources[0] ?? 0;
  } catch { return 0; }
}

async function main(): Promise<void> {
  console.log(`▸ Catalog consolidation audit`);
  console.log(`  reading card_catalog...`);

  const it = catalog.items.query<CatRow>({
    query: `SELECT c.id, c.cardId, c.kind, c.source, c.setKey, c.playerName, c.player, c.cardNumber, c.number, c.cardYear, c.year, c.parallel, c.parallelSlug, c.isAuto
            FROM c WHERE (IS_DEFINED(c.playerName) OR IS_DEFINED(c.player))
              AND (IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.number))`,
  }, { maxItemCount: 500 });

  const groups = new Map<string, FingerprintGroup>();
  let scanned = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    let batch: CatRow[] = [];
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
      let g = groups.get(fp.key);
      if (!g) {
        g = {
          fp: fp.key,
          playerName: fp.player,
          cardYear: fp.year,
          cardNumber: fp.num,
          parallelSlug: fp.par,
          variants: [],
          totalCatalogRows: 0,
          totalSoldComps: 0,
          distinctSlugs: 0,
          isAutoDisagrees: false,
        };
        groups.set(fp.key, g);
      }
      const slug = extractSlug(r);
      g.variants.push({
        catId: r.id,
        slug,
        setKey: String(r.setKey ?? ""),
        isAuto: r.isAuto === true,
        kind: String(r.kind ?? "null"),
        source: String(r.source ?? "null"),
        soldCompsCount: 0, // filled below for dup groups only
      });
      g.totalCatalogRows++;
    }
    const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanning: ${scanned.toLocaleString()} rows, ${groups.size.toLocaleString()} fingerprints  ${Math.round(scanned / el)}/s\r`);
  }

  console.log(`\n\n▸ Scan complete: ${scanned.toLocaleString()} catalog rows → ${groups.size.toLocaleString()} fingerprints`);

  // Identify fragmented groups
  const fragmented: FingerprintGroup[] = [];
  for (const g of groups.values()) {
    const uniqueSlugs = new Set(g.variants.map((v) => v.slug).filter(Boolean));
    g.distinctSlugs = uniqueSlugs.size;
    const autoBits = new Set(g.variants.map((v) => v.isAuto));
    g.isAutoDisagrees = autoBits.size > 1;
    if (g.totalCatalogRows > 1) fragmented.push(g);
  }
  console.log(`▸ Fragmented fingerprints: ${fragmented.length.toLocaleString()}`);
  const totalDupRows = fragmented.reduce((s, g) => s + (g.totalCatalogRows - 1), 0);
  console.log(`▸ Duplicate catalog rows to consolidate: ${totalDupRows.toLocaleString()}`);
  const disagreesCount = fragmented.filter((g) => g.isAutoDisagrees).length;
  console.log(`▸ Fingerprints where isAuto disagrees: ${disagreesCount.toLocaleString()}`);

  // Attach sold_comps counts ONLY for fragmented groups (cost control)
  console.log(`\n▸ Attaching sold_comps counts to fragmented groups...`);
  const uniqueSlugs = new Set<string>();
  for (const g of fragmented) for (const v of g.variants) if (v.slug) uniqueSlugs.add(v.slug);
  console.log(`  ${uniqueSlugs.size.toLocaleString()} unique slugs to count`);
  const slugCounts = new Map<string, number>();
  const slugList = [...uniqueSlugs];
  const startAttach = Date.now();
  const CHUNK = 32;
  for (let i = 0; i < slugList.length; i += CHUNK) {
    const chunk = slugList.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(async (s) => ({ s, n: await countSoldComps(s) })));
    for (const res of results) {
      if (res.status === "fulfilled") slugCounts.set(res.value.s, res.value.n);
    }
    const el = Math.max(1, Math.round((Date.now() - startAttach) / 1000));
    process.stderr.write(`  attaching: ${Math.min(i + CHUNK, slugList.length)}/${slugList.length}  ${Math.round((i + CHUNK) / el)}/s\r`);
  }

  for (const g of fragmented) {
    let total = 0;
    for (const v of g.variants) {
      if (v.slug) v.soldCompsCount = slugCounts.get(v.slug) ?? 0;
      total += v.soldCompsCount;
    }
    g.totalSoldComps = total;
  }

  // Rank by (total sold comps × distinct slugs) — impact metric
  fragmented.sort((a, b) => (b.totalSoldComps * b.distinctSlugs) - (a.totalSoldComps * a.distinctSlugs));

  console.log(`\n\n▸ Top ${TOP} fragmented fingerprints by impact:`);
  for (const g of fragmented.slice(0, TOP)) {
    console.log(`\n  ${g.playerName}  ${g.cardYear ?? "?"}  #${g.cardNumber}  ${g.parallelSlug}  — ${g.totalCatalogRows} catalog rows, ${g.totalSoldComps} sales, ${g.distinctSlugs} distinct slugs${g.isAutoDisagrees ? " ⚠ AUTO-DISAGREES" : ""}`);
    for (const v of g.variants.sort((a, b) => b.soldCompsCount - a.soldCompsCount)) {
      console.log(`    ${String(v.soldCompsCount).padStart(4)} sales  set=${v.setKey.padEnd(20)} kind=${v.kind.padEnd(9)} src=${v.source.padEnd(24)}  ${v.slug}`);
    }
  }

  // Write full report
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      scannedRows: scanned,
      totalFingerprints: groups.size,
      fragmentedFingerprints: fragmented.length,
      duplicateCatalogRows: totalDupRows,
      isAutoDisagrees: disagreesCount,
      fragmented,
    };
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`\n▸ Full report written to ${OUT}`);
  } catch (e) {
    console.error(`  ! write ${OUT}: ${(e as Error).message}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
