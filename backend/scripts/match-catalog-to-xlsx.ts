#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-XLSX-MATCH (Drew, 2026-08-05).
 *
 * Supplementary match pass. Reads parsed xlsx checklists from
 * c:/tmp/clc-xlsx-parsed/{year}/*.json and identity-matches
 * card_catalog pool rows that BCCP+CLC parallel-name matching
 * couldn't confirm.
 *
 * Identity keys tried (in order of specificity):
 *   1. (year, cardNumber, playerNameSlug) — strongest
 *   2. (year, cardNumber) — fallback when player unknown
 *
 * When a pool row's key hits any xlsx row, we mark:
 *   bccpMatchedAs → "checklist-verified"   (a real card in a real product)
 *   xlsxSet, xlsxPrintRun, xlsxTeam        (attributed to the matched xlsx row)
 *
 * Only touches rows currently classified as `parallel-unverified` or
 * `null` — never overrides a stronger BCCP/CLC match.
 *
 * Usage:
 *   npx tsx backend/scripts/match-catalog-to-xlsx.ts \
 *     --year YYYY --sport baseball [--dry-run]
 */

import { CosmosClient } from "@azure/cosmos";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

interface Args { year?: number; sport?: string; xlsxDir?: string; dryRun?: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball", xlsxDir: "c:/tmp/clc-xlsx-parsed" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--xlsx-dir") { args.xlsxDir = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
  }
  return args;
}

function slug(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface XlsxRow { set: string; cardNumber: string; playerName: string; team: string; printRun: number | null; }
interface XlsxIndex {
  byPlayerAndNumber: Map<string, XlsxRow[]>;   // key: `${cardNumberSlug}:${playerSlug}`
  byNumber: Map<string, XlsxRow[]>;             // key: cardNumberSlug
  totalRows: number;
}

function buildXlsxIndex(xlsxDir: string, year: number): XlsxIndex {
  const dir = join(xlsxDir, String(year));
  const byPlayerAndNumber = new Map<string, XlsxRow[]>();
  const byNumber = new Map<string, XlsxRow[]>();
  let totalRows = 0;
  try { statSync(dir); } catch { return { byPlayerAndNumber, byNumber, totalRows }; }
  const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
  for (const f of files) {
    let doc: { rows: XlsxRow[] };
    try { doc = JSON.parse(readFileSync(join(dir, f), "utf8")); }
    catch { continue; }
    for (const row of doc.rows) {
      if (!row.cardNumber) continue;
      totalRows++;
      const cnSlug = slug(row.cardNumber);
      const pSlug = slug(row.playerName);
      const bothKey = `${cnSlug}:${pSlug}`;
      let arr = byPlayerAndNumber.get(bothKey);
      if (!arr) { arr = []; byPlayerAndNumber.set(bothKey, arr); }
      arr.push(row);
      let arr2 = byNumber.get(cnSlug);
      if (!arr2) { arr2 = []; byNumber.set(cnSlug, arr2); }
      arr2.push(row);
    }
  }
  return { byPlayerAndNumber, byNumber, totalRows };
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

interface Enrichment { xlsxSet: string | null; xlsxPrintRun: number | null; xlsxTeam: string | null; xlsxPlayer: string | null; }

function lookupXlsx(row: CatalogRow, index: XlsxIndex): XlsxRow | null {
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
  // Multiple xlsx rows for same cardNumber (from parallel enumeration).
  // Prefer any where the set text contains a substring of the pool row's
  // parallel — otherwise fall back to first (base).
  if (row.parallel) {
    const q = slug(row.parallel);
    const scored = hits.find((h) => slug(h.set).includes(q) || q.includes(slug(h.set)));
    if (scored) return scored;
  }
  return hits[0];
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) { console.error("Usage: match-catalog-to-xlsx.ts --year YYYY --sport <sport> [--dry-run]"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const xlsxDir = args.xlsxDir ?? "c:/tmp/clc-xlsx-parsed";
  console.log(`\n▸ Building xlsx identity index for ${args.year} from ${xlsxDir}/${args.year}...`);
  const index = buildXlsxIndex(xlsxDir, args.year);
  console.log(`  ${index.totalRows.toLocaleString()} rows, ${index.byPlayerAndNumber.size} distinct (cardNumber, player) pairs`);
  if (index.totalRows === 0) { console.error("  ! no xlsx checklist data for this year"); process.exit(1); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  console.log(`\n▸ Scanning parallel-unverified + null rows for year=${args.year}...`);
  const iterator = cat.items.query<CatalogRow>({
    query: "SELECT c.id, c.cardId, c.year, c.setKey, c.cardNumber, c.parallel, c.playerName, c.bccpMatchedAs FROM c WHERE c.sport = @sport AND c.year = @year AND c.source = 'bulk-build-from-pool' AND (c.bccpMatchedAs = 'parallel-unverified' OR NOT IS_DEFINED(c.bccpMatchedAs))",
    parameters: [{ name: "@sport", value: args.sport }, { name: "@year", value: args.year }],
  }, { maxItemCount: 500 });
  const rows: CatalogRow[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  scanned ${rows.length}\r`);
  }
  console.log(`\n  ✓ ${rows.length} rows to check against xlsx`);
  if (rows.length === 0) process.exit(0);

  const hits = new Map<string, XlsxRow>();
  for (const row of rows) {
    const h = lookupXlsx(row, index);
    if (h) hits.set(row.id, h);
  }
  console.log(`  ✓ ${hits.size} identity matches (${Math.round(100 * hits.size / rows.length)}%)`);
  if (args.dryRun) { console.log("\n▸ DRY RUN — no writes."); process.exit(0); }

  console.log(`\n▸ Patching card_catalog...`);
  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  let patched = 0, errors = 0, done = 0;
  const total = hits.size;
  const entries = [...hits.entries()];
  const chunks: Array<Array<[string, XlsxRow]>> = [];
  for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));

  async function runChunk(chunk: Array<[string, XlsxRow]>): Promise<void> {
    let pending = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const now = new Date().toISOString();
      const ops = pending.map(([id, h]) => ({
        operationType: "Patch" as const,
        id, partitionKey: id,
        resourceBody: { operations: [
          { op: "set", path: "/bccpMatched", value: true },
          { op: "set", path: "/bccpMatchedAs", value: "checklist-verified" },
          { op: "set", path: "/bccpMatchedAt", value: now },
          { op: "set", path: "/xlsxSet", value: h.set },
          { op: "set", path: "/xlsxPrintRun", value: h.printRun },
          { op: "set", path: "/xlsxTeam", value: h.team },
          { op: "set", path: "/xlsxPlayer", value: h.playerName },
        ]},
      }));
      try {
        const results = await cat.items.bulk(ops);
        const next: Array<[string, XlsxRow]> = [];
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
    process.stdout.write(`  patched ${patched}, err ${errors} (${done}/${total})\r`);
  }
  console.log(`\n▸ Done: patched=${patched}, errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
