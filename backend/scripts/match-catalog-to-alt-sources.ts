#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-ALT-MATCH (Drew, 2026-08-05).
 *
 * Third-pass matcher. Consumes Baseball-Almanac (`c:/tmp/ba/`) and
 * Fandom Baseball-Cards Wiki (`c:/tmp/fandom/`) checklist JSON dumps
 * and identity-matches against baseball card_catalog pool rows still
 * classified as `parallel-unverified` or `null` after BCCP + xlsx.
 *
 * These sources are BASE-CHECKLIST authoritative — they confirm a card
 * exists in a real product but usually don't enumerate parallels. Match
 * marks the row `bccpMatchedAs = "alt-verified"` with per-source
 * attribution in `altSource`, `altSourceLabel`, `altSourceSlug`.
 *
 * Identity keys tried (specificity descending):
 *   1. (year, cardNumberSlug, playerNameSlug)
 *   2. (year, cardNumberSlug)   — when player is missing/messy
 *
 * Never overrides a stronger BCCP/CLC match. Skips rows already
 * marked `checklist-verified` (xlsx pass) to preserve provenance
 * of the most-specific source.
 *
 * Usage:
 *   npx tsx backend/scripts/match-catalog-to-alt-sources.ts \
 *     --year YYYY --sport baseball [--dry-run]
 */

import { CosmosClient } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

interface Args { year?: number; sport?: string; baDir?: string; fandomDir?: string; dryRun?: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball", baDir: "c:/tmp/ba", fandomDir: "c:/tmp/fandom" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--ba-dir") { args.baDir = v; i++; }
    else if (f === "--fandom-dir") { args.fandomDir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
  }
  return args;
}

function slug(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface AltRow {
  source: "baseball-almanac" | "fandom";
  setSlug: string;
  setLabel: string;
  cardNumber: string;
  playerName: string;
}

interface AltIndex {
  byPlayerAndNumber: Map<string, AltRow[]>;
  byNumber: Map<string, AltRow[]>;
  totalRows: number;
  perSource: { ba: number; fandom: number };
}

function ingestJsonFiles(dir: string, targetYear: number, source: "baseball-almanac" | "fandom", index: AltIndex): void {
  if (!existsSync(dir)) return;
  // BA layout: dir/<mfr>/<setSlug>.json. Fandom layout: dir/<setSlug>.json.
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      try {
        const s = statSync(p);
        if (s.isDirectory()) out.push(...walk(p));
        else if (entry.endsWith(".json")) out.push(p);
      } catch { /* ignore */ }
    }
    return out;
  };
  const files = walk(dir);
  for (const f of files) {
    let doc: { year?: number | null; label?: string; slug?: string; cards?: Array<{ cardNumber: string; playerName: string }> };
    try { doc = JSON.parse(readFileSync(f, "utf8")); }
    catch { continue; }
    if (!doc.year || doc.year !== targetYear) continue;
    if (!Array.isArray(doc.cards) || doc.cards.length === 0) continue;
    for (const card of doc.cards) {
      const row: AltRow = {
        source,
        setSlug: doc.slug ?? "",
        setLabel: doc.label ?? "",
        cardNumber: card.cardNumber,
        playerName: card.playerName,
      };
      const cnSlug = slug(card.cardNumber);
      const pSlug = slug(card.playerName);
      if (!cnSlug) continue;
      index.totalRows++;
      if (source === "baseball-almanac") index.perSource.ba++; else index.perSource.fandom++;
      const bothKey = `${cnSlug}:${pSlug}`;
      let arr = index.byPlayerAndNumber.get(bothKey);
      if (!arr) { arr = []; index.byPlayerAndNumber.set(bothKey, arr); }
      arr.push(row);
      let arr2 = index.byNumber.get(cnSlug);
      if (!arr2) { arr2 = []; index.byNumber.set(cnSlug, arr2); }
      arr2.push(row);
    }
  }
}

function buildAltIndex(baDir: string, fandomDir: string, year: number): AltIndex {
  const index: AltIndex = {
    byPlayerAndNumber: new Map(),
    byNumber: new Map(),
    totalRows: 0,
    perSource: { ba: 0, fandom: 0 },
  };
  ingestJsonFiles(baDir, year, "baseball-almanac", index);
  ingestJsonFiles(fandomDir, year, "fandom", index);
  return index;
}

interface CatalogRow {
  id: string;
  cardId: string;
  year: number;
  setKey: string;
  cardNumber?: string;
  parallel?: string;
  playerName?: string;
  bccpMatchedAs?: string;
}

function lookupAlt(row: CatalogRow, index: AltIndex): AltRow | null {
  if (!row.cardNumber) return null;
  const cnSlug = slug(row.cardNumber);
  if (!cnSlug) return null;
  const pSlug = slug(row.playerName);
  if (pSlug) {
    const hits = index.byPlayerAndNumber.get(`${cnSlug}:${pSlug}`);
    if (hits && hits.length > 0) return hits[0];
  }
  const hits = index.byNumber.get(cnSlug);
  if (!hits || hits.length === 0) return null;
  return hits[0];
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) {
    console.error("Usage: match-catalog-to-alt-sources.ts --year YYYY --sport <sport> [--dry-run]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const baDir = args.baDir ?? "c:/tmp/ba";
  const fandomDir = args.fandomDir ?? "c:/tmp/fandom";
  console.log(`\n▸ Building alt-source identity index for ${args.year} (BA=${baDir}, Fandom=${fandomDir})...`);
  const index = buildAltIndex(baDir, fandomDir, args.year);
  console.log(`  ${index.totalRows.toLocaleString()} rows total  (BA=${index.perSource.ba}, Fandom=${index.perSource.fandom})`);
  console.log(`  ${index.byPlayerAndNumber.size} distinct (cardNumber, player) pairs`);
  if (index.totalRows === 0) { console.log("  (no alt-source data for this year — nothing to do)"); process.exit(0); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n▸ Scanning still-unverified pool rows for year=${args.year}...`);
  const iterator = cat.items.query<CatalogRow>({
    query: `SELECT c.id, c.cardId, c.year, c.setKey, c.cardNumber, c.parallel, c.playerName, c.bccpMatchedAs
            FROM c
            WHERE c.sport = @sport AND c.year = @year
              AND c.source = 'bulk-build-from-pool'
              AND (c.bccpMatchedAs = 'parallel-unverified' OR NOT IS_DEFINED(c.bccpMatchedAs))`,
    parameters: [{ name: "@sport", value: args.sport }, { name: "@year", value: args.year }],
  }, { maxItemCount: 500 });
  const rows: CatalogRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  scanned ${rows.length}\r`);
  }
  console.log(`\n  ✓ ${rows.length} rows to check against alt sources`);
  if (rows.length === 0) process.exit(0);

  const hits = new Map<string, AltRow>();
  for (const row of rows) {
    const h = lookupAlt(row, index);
    if (h) hits.set(row.id, h);
  }
  const perSourceHits = { ba: 0, fandom: 0 };
  for (const h of hits.values()) {
    if (h.source === "baseball-almanac") perSourceHits.ba++; else perSourceHits.fandom++;
  }
  console.log(`  ✓ ${hits.size} identity matches (${Math.round(100 * hits.size / rows.length)}%)  BA=${perSourceHits.ba} Fandom=${perSourceHits.fandom}`);
  if (args.dryRun) { console.log("\n▸ DRY RUN — no writes."); process.exit(0); }
  if (hits.size === 0) { console.log("\n▸ No matches. Nothing to write."); process.exit(0); }

  console.log(`\n▸ Patching card_catalog...`);
  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  let patched = 0, errors = 0, done = 0;
  const total = hits.size;
  const entries = [...hits.entries()];
  const chunks: Array<Array<[string, AltRow]>> = [];
  for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));

  async function runChunk(chunk: Array<[string, AltRow]>): Promise<void> {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const now = new Date().toISOString();
      const ops = pending.map(([id, h]) => ({
        operationType: "Patch" as const,
        id,
        partitionKey: id,
        resourceBody: {
          operations: [
            { op: "set" as const, path: "/bccpMatchedAs", value: "alt-verified" },
            { op: "set" as const, path: "/bccpMatchedAt", value: now },
            { op: "set" as const, path: "/altSource", value: h.source },
            { op: "set" as const, path: "/altSourceLabel", value: h.setLabel },
            { op: "set" as const, path: "/altSourceSlug", value: h.setSlug },
          ],
        },
      }));
      let results;
      try {
        results = await cat.items.bulk(ops as never);
      } catch (e) {
        errors += pending.length;
        return;
      }
      const nextPending: typeof pending = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.statusCode >= 200 && r.statusCode < 300) patched++;
        else if (r.statusCode === 429 || r.statusCode === 408 || r.statusCode >= 500) nextPending.push(pending[i]);
        else errors++;
      }
      pending = nextPending;
      attempt++;
      if (pending.length > 0) await new Promise((r) => setTimeout(r, 500 * Math.min(4, attempt)));
    }
    if (pending.length > 0) errors += pending.length;
  }

  for (let i = 0; i < chunks.length; i += PARALLEL_BULKS) {
    const batch = chunks.slice(i, i + PARALLEL_BULKS);
    await Promise.all(batch.map(runChunk));
    done += batch.reduce((n, c) => n + c.length, 0);
    process.stdout.write(`  patched ${patched}/${total}  errors ${errors}\r`);
  }
  console.log(`\n  ✓ patched=${patched}, errors=${errors}`);
  console.log(`\n▸ DONE — year=${args.year}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
