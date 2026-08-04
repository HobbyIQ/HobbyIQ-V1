#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST P0.2 — sold-comps canonical backfill (Drew, 2026-08-04).
 *
 * For every historical sold_comps row without a canonical hobbyiqCardId
 * (or with a stale/non-canonical parallel), recompute the canonical
 * slug via the catalog matcher and update in place.
 *
 * Drew: "Comps match to a cardId of ours which then can promote
 * pricing." This is the script that guarantees it — after this runs,
 * every sold_comps row queryable by canonical cardId.
 *
 * Design:
 *   1. Range-scan sold_comps by year window (chunked so a run can be
 *      resumed).
 *   2. For each row, extract identity tuple → canonicalize() → get slug.
 *   3. If slug differs from existing hobbyiqCardId, patch the row.
 *   4. Report matched / patched / skipped / errors.
 *
 * Runs are chunked BY YEAR so a full backfill is broken into small
 * scoped chunks that can be scheduled + parallelized safely. Pattern
 * matches CF-DEDUPE-SCANS-EATING-THE-SLICE (feedback rules).
 *
 * Usage:
 *   npx tsx backend/scripts/backfill-soldcomps-canonical.ts \
 *     --year 2024 [--sport baseball] [--dry-run] [--auto-approve]
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";
import { canonicalize, canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  year?: number;
  sport?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
  limit?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--sport") { args.sport = val; i++; }
    else if (flag === "--limit") { args.limit = Number(val); i++; }
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

interface SoldCompShape {
  id: string;
  cardId: string;
  hobbyiqCardId?: string;
  cardYear?: number;
  cardNumber?: string;
  parallel?: string;
  isAuto?: boolean;
  printRun?: number | null;
  playerName?: string;
  setName?: string;
  sport?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year) {
    console.error("Usage: backfill-soldcomps-canonical.ts --year <n> [--sport <sport>] [--dry-run|--auto-approve] [--limit N]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  console.log(`\n▸ Sold-comps canonical backfill`);
  console.log(`  year: ${args.year}${args.sport ? ` sport: ${args.sport}` : ""}`);
  if (args.dryRun) console.log(`  DRY RUN — no Cosmos writes`);

  const client = new CosmosClient(conn);
  const sold = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  const wherePieces: string[] = ["c.cardYear = @year", "IS_DEFINED(c.cardNumber)"];
  const params: Array<{ name: string; value: string | number }> = [{ name: "@year", value: args.year }];
  if (args.sport) {
    wherePieces.push("c.sport = @sport");
    params.push({ name: "@sport", value: args.sport });
  }
  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.setName, c.sport FROM c WHERE ${wherePieces.join(" AND ")}`;

  console.log(`\n▸ Scanning sold_comps for ${args.year}...`);
  const iterator = sold.items.query<SoldCompShape>(
    { query, parameters: params },
    { maxItemCount: 500 },
  );
  const rows: SoldCompShape[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) rows.push(r);
    process.stdout.write(`  scanned ${rows.length}\r`);
    if (args.limit && rows.length >= args.limit) break;
  }
  console.log(`\n  ✓ ${rows.length} rows to consider`);

  // Precompute what would change so we can preview before writing.
  const wouldPatch: Array<{ row: SoldCompShape; newSlug: string; newParallel: string; oldSlug: string; oldParallel: string }> = [];
  let alreadyCanonical = 0;
  let missingIdentity = 0;
  // CF-BACKFILL-PERF-FIX (Drew, 2026-08-04). Prior preview compared the
  // row's hobbyiqCardId against a synthetic key format that NEVER matches
  // the real slug — so every row was flagged as a "candidate" even when
  // fully canonical. Result: 194K row runs were touching every row when
  // only a fraction needed patching. Now we compute the ACTUAL canonical
  // slug locally via computeHobbyIqCardId (pure function, no Cosmos) and
  // skip rows where BOTH parallel + hobbyiqCardId already equal canonical.
  for (const row of rows) {
    if (!row.cardNumber || !row.sport) { missingIdentity++; continue; }
    const setName = row.setName ?? "";
    const rawParallel = row.parallel ?? "Base";
    const canonParallel = canonicalizeParallelName(rawParallel);
    const isAuto = row.isAuto === true;
    const printRun = typeof row.printRun === "number" ? row.printRun : null;
    let canonicalSlug: string;
    try {
      canonicalSlug = computeHobbyIqCardId({
        sport: row.sport,
        year: row.cardYear ?? args.year!,
        setKey: normalizeSetKey(setName),
        cardNumber: row.cardNumber,
        parallel: canonParallel,
        isAuto,
        printRun,
      });
    } catch {
      missingIdentity++;
      continue;
    }
    if (row.hobbyiqCardId === canonicalSlug && row.parallel === canonParallel) {
      alreadyCanonical++;
      continue;
    }
    wouldPatch.push({
      row,
      newSlug: canonicalSlug,
      newParallel: canonParallel,
      oldSlug: row.hobbyiqCardId ?? "(none)",
      oldParallel: row.parallel ?? "(none)",
    });
  }

  console.log(`\n▸ Preview`);
  console.log(`  already canonical: ${alreadyCanonical}`);
  console.log(`  candidate to patch: ${wouldPatch.length}`);
  console.log(`  skipped (missing identity): ${missingIdentity}`);

  const sampleParallel = new Map<string, number>();
  for (const p of wouldPatch) {
    const k = `${p.oldParallel} → ${p.newParallel}`;
    sampleParallel.set(k, (sampleParallel.get(k) ?? 0) + 1);
  }
  const topDeltas = [...sampleParallel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topDeltas.length > 0) {
    console.log(`\n▸ Top parallel canonicalizations (old → new):`);
    for (const [k, n] of topDeltas) console.log(`  ${n.toString().padStart(6)}  ${k}`);
  }

  if (args.dryRun) {
    console.log(`\n▸ DRY RUN — done.`);
    process.exit(0);
  }
  if (wouldPatch.length === 0) {
    console.log(`\n▸ Nothing to patch — every row already canonical.`);
    process.exit(0);
  }

  if (!args.autoApprove) {
    const ans = await ask(`\n  Approve patching ${wouldPatch.length} sold_comps rows? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) {
      console.log("Aborted — nothing written.");
      process.exit(0);
    }
  }

  console.log(`\n▸ Patching sold_comps (concurrency 8)...`);
  const startedAt = Date.now();
  let patched = 0, matched = 0, errors = 0;
  let done = 0;
  const total = wouldPatch.length;
  const CONCURRENCY = 8;
  for (let i = 0; i < wouldPatch.length; i += CONCURRENCY) {
    const batch = wouldPatch.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (item) => {
      const row = item.row;
      try {
        // Get the canonical slug via matcher (also creates the catalog
        // row if it didn't exist — trusted source since it's already
        // in the pool).
        const match = await canonicalize({
          sport: row.sport!,
          year: row.cardYear ?? args.year!,
          setName: row.setName ?? "",
          cardNumber: row.cardNumber!,
          parallel: item.newParallel,
          isAuto: row.isAuto === true,
          printRun: typeof row.printRun === "number" ? row.printRun : null,
          player: row.playerName ?? null,
          source: "checklist",   // trusted — pool is our authoritative signal
        });
        // Patch the row in place — set parallel + hobbyiqCardId to canonical.
        // We use a partial-update via read + replace since patchOperations
        // don't cross partitions and the pk is /cardId which we're not changing.
        const { resource: existing } = await sold.item(row.id, row.cardId).read();
        if (!existing) { errors++; done++; return; }
        existing.parallel = item.newParallel;
        existing.hobbyiqCardId = match.slug;
        await sold.item(row.id, row.cardId).replace(existing);
        patched++;
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`\n  ! ${row.id}: ${(err as Error).message}`);
      }
      done++;
    }));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / elapsedSec;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(`  ...patched ${patched}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s eta ${etaSec}s\r`);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n▸ Done in ${elapsedSec}s:`);
  console.log(`   patched: ${patched}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
