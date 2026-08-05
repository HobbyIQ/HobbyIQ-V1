#!/usr/bin/env -S npx tsx
/**
 * CF-RELINK-SOLDCOMPS (Drew, 2026-08-05).
 *
 * Adds explicit tree pointer fields to every sold_comp so downstream
 * queries can navigate the Card→Variant→Grade tree without walking
 * from hobbyiqCardId + gradeCompany + gradeValue every time. Adds:
 *
 *   cardTreeId  — root Card doc id  ("card::hiq:baseball:2018:...")
 *   variantId   — Variant doc id     ("variant::hiq:baseball:2018:...")
 *   gradeId     — Grade doc id       ("grade::hiq:baseball:2018:...")
 *
 * Derived from sold_comp fields we already have:
 *   variantId = "variant::" + hobbyiqCardId
 *   cardTreeId = "card::" + (hobbyiqCardId trimmed at last ":<parallel>:")
 *   gradeId = "grade::" + hobbyiqCardId + ":" + gradeSlug
 *
 * Skips rows where hobbyiqCardId is missing, malformed ("::" segments),
 * or already carries a gradeId field. Idempotent.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   RELINK_APPLY              true = write; default = dry-run
 *   RELINK_YEAR               only rows where cardYear = N
 *   RELINK_SPORT              default: baseball
 *   MAX_ROWS                  hard cap for slice tests
 *   CONCURRENCY               parallel bulk operations (default 4)
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.RELINK_APPLY === "true";
const RELINK_YEAR = process.env.RELINK_YEAR ? Number(process.env.RELINK_YEAR) : null;
const RELINK_SPORT = process.env.RELINK_SPORT || "baseball";
const MAX_ROWS = process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : 0;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const client = new CosmosClient(conn);
const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const soldComps = db.container("sold_comps");

// Parse a flat hobbyiqCardId slug into its (cardTreeId, variantId,
// gradeSlug) tree pointers. Assumes the slug shape produced by
// computeHobbyIqCardId:
//   hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallelSlug}:{auto}[:num-N]
// The Card node id drops parallel/auto/printRun; the Variant node id
// mirrors the whole flat slug.
function parseSlug(slug: string): { cardTreeId: string; variantId: string; variantSlug: string } | null {
  if (!slug || slug.includes("::")) return null; // malformed
  const parts = slug.split(":");
  if (parts.length < 6) return null;
  const [hiq, sport, yearStr, setKey, cardNumber, ...rest] = parts;
  if (hiq !== "hiq" || !sport || !yearStr || !setKey || !cardNumber || rest.length === 0) return null;
  const cardCanonical = `hiq:${sport}:${yearStr}:${setKey}:${cardNumber}`;
  return {
    cardTreeId: `card::${cardCanonical}`,
    variantId: `variant::${slug}`,
    variantSlug: slug,
  };
}

function gradeIdOf(variantSlug: string, gradeCompany: string | null | undefined, gradeValue: number | string | null | undefined): string {
  const gv = gradeValue == null ? null : Number(gradeValue);
  const g = gradeCompany
    ? `${String(gradeCompany).toLowerCase()}${String(gv ?? "").replace(".", "-")}`
    : "raw";
  return `grade::${variantSlug}:${g}`;
}

interface SoldCompRow {
  id: string;
  cardId: string;
  hobbyiqCardId?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | string | null;
  cardYear?: number | null;
  sport?: string | null;
  gradeId?: string | null;
}

interface Stats {
  scanned: number;
  eligible: number;
  written: number;
  skipMalformed: number;
  skipAlreadyLinked: number;
  errors: number;
}

async function processBatch(batch: SoldCompRow[], stats: Stats): Promise<void> {
  const opsByPk = new Map<string, Array<{
    operationType: "Patch";
    id: string;
    partitionKey: string;
    resourceBody: { operations: Array<{ op: "set"; path: string; value: string }> };
  }>>();

  for (const row of batch) {
    stats.scanned++;
    if (row.gradeId) { stats.skipAlreadyLinked++; continue; }
    if (!row.hobbyiqCardId) { stats.skipMalformed++; continue; }
    const parsed = parseSlug(row.hobbyiqCardId);
    if (!parsed) { stats.skipMalformed++; continue; }
    stats.eligible++;
    const gid = gradeIdOf(parsed.variantSlug, row.gradeCompany, row.gradeValue);
    const patch = {
      operationType: "Patch" as const,
      id: row.id,
      partitionKey: row.cardId,
      resourceBody: {
        operations: [
          { op: "set" as const, path: "/cardTreeId", value: parsed.cardTreeId },
          { op: "set" as const, path: "/variantId", value: parsed.variantId },
          { op: "set" as const, path: "/gradeId", value: gid },
        ],
      },
    };
    let arr = opsByPk.get(row.cardId);
    if (!arr) { arr = []; opsByPk.set(row.cardId, arr); }
    arr.push(patch);
  }

  if (!APPLY) return;

  const chunks: Array<Array<typeof opsByPk extends Map<string, infer V> ? V[number] : never>> = [];
  for (const arr of opsByPk.values()) {
    for (let i = 0; i < arr.length; i += 50) chunks.push(arr.slice(i, i + 50));
  }

  const iterator = chunks[Symbol.iterator]();
  async function worker(): Promise<void> {
    while (true) {
      const next = iterator.next();
      if (next.done) return;
      const chunk = next.value;
      try {
        const results = await soldComps.items.bulk(chunk as never);
        for (const r of results) {
          if (r.statusCode >= 200 && r.statusCode < 300) stats.written++;
          else stats.errors++;
        }
      } catch { stats.errors += chunk.length; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function main(): Promise<void> {
  console.log(`▸ sold_comps re-link — sport=${RELINK_SPORT}${RELINK_YEAR ? ` year=${RELINK_YEAR}` : ""} ${APPLY ? "APPLY" : "DRY-RUN"}`);
  const clauses = ["c.sport = @sport", "IS_DEFINED(c.hobbyiqCardId)", "c.hobbyiqCardId != null", "NOT IS_DEFINED(c.gradeId)"];
  const params: Array<{ name: string; value: string | number }> = [{ name: "@sport", value: RELINK_SPORT }];
  if (RELINK_YEAR) {
    clauses.push("c.cardYear = @year");
    params.push({ name: "@year", value: RELINK_YEAR });
  }
  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.cardYear, c.sport, c.gradeId
                 FROM c WHERE ${clauses.join(" AND ")}`;
  const it = soldComps.items.query<SoldCompRow>({ query, parameters: params }, { maxItemCount: 500 });

  const stats: Stats = { scanned: 0, eligible: 0, written: 0, skipMalformed: 0, skipAlreadyLinked: 0, errors: 0 };
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (resources.length === 0) break;
    await processBatch(resources, stats);
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const rate = Math.round(stats.scanned / elapsed);
    process.stderr.write(`  scanned=${stats.scanned} eligible=${stats.eligible} written=${stats.written} err=${stats.errors} skip=${stats.skipMalformed + stats.skipAlreadyLinked} · ${rate}/s\r`);
    if (MAX_ROWS && stats.scanned >= MAX_ROWS) break;
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n\n▸ Done in ${elapsed}s`);
  console.log(`  scanned:      ${stats.scanned.toLocaleString()}`);
  console.log(`  eligible:     ${stats.eligible.toLocaleString()}`);
  console.log(`  written:      ${stats.written.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  skip malf:    ${stats.skipMalformed.toLocaleString()}`);
  console.log(`  skip linked:  ${stats.skipAlreadyLinked.toLocaleString()}`);
  console.log(`  errors:       ${stats.errors.toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
