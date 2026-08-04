#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — bulk-build (Drew, 2026-08-04).
 *
 * "Our goal is to build a catalog for all 2020's baseball cards today.
 * Period. ALL of them."
 *
 * Fast path: skip canonicalize()'s fuzzy-parallel + family-fallback
 * lookups. For each year+sport, scan sold_comps, reduce to unique
 * (year, setKey, cardNumber, parallel, isAuto, printRun) tuples, compute
 * the canonical slug locally, bulk upsert to card_catalog.
 *
 * Rate: ~250 upserts/sec (Cosmos patch/upsert throughput). 2020s
 * baseball across 7 years ≈ 30-50K unique tuples → completes in
 * minutes per year.
 *
 * Usage:
 *   npx tsx backend/scripts/bulk-build-catalog.ts \
 *     --year YYYY --sport baseball [--dry-run] [--auto-approve]
 */

import { CosmosClient, type JSONObject } from "@azure/cosmos";
import { createInterface } from "readline";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";
import { computeHobbyIqCardId, normalizeSetKey, slugify } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Args {
  year?: number;
  sport?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--sport") { args.sport = val; i++; }
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

interface CompRow {
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  playerName: string | null;
  setName: string | null;
  sport: string | null;
}

interface Tuple {
  slug: string;
  sport: string;
  year: number;
  setKey: string;
  setName: string;
  cardNumber: string;
  parallel: string;
  parallelSlug: string;
  isAuto: boolean;
  printRun: number | null;
  playerName: string | null;
  compCount: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.sport) {
    console.error("Usage: bulk-build-catalog.ts --year <n> --sport <sport> [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`\n▸ Bulk catalog build for ${args.year} ${args.sport}`);
  if (args.dryRun) console.log(`  DRY RUN — no writes`);

  console.log(`\n▸ Scanning sold_comps...`);
  const iterator = sold.items.query<CompRow>({
    query: "SELECT c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName, c.setName, c.sport FROM c WHERE c.cardYear = @y AND c.sport = @sport",
    parameters: [{ name: "@y", value: args.year }, { name: "@sport", value: args.sport }],
  }, { maxItemCount: 500 });

  const tuples = new Map<string, Tuple>();
  let scanned = 0, skipped = 0;
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) {
      scanned++;
      if (!r.cardNumber || !r.sport || !r.setName) { skipped++; continue; }
      const cardNumber = String(r.cardNumber).trim().toUpperCase();
      if (!cardNumber) { skipped++; continue; }
      const setKey = normalizeSetKey(r.setName);
      if (!setKey) { skipped++; continue; }
      const parallel = canonicalizeParallelName(r.parallel);
      const isAuto = r.isAuto === true;
      const printRun = typeof r.printRun === "number" ? r.printRun : null;
      let slug: string;
      try {
        slug = computeHobbyIqCardId({
          sport: r.sport,
          year: args.year!,
          setKey,
          cardNumber,
          parallel,
          isAuto,
          printRun,
        });
      } catch { skipped++; continue; }
      let t = tuples.get(slug);
      if (!t) {
        t = {
          slug,
          sport: r.sport,
          year: args.year!,
          setKey,
          setName: r.setName,
          cardNumber,
          parallel,
          parallelSlug: slugify(parallel),
          isAuto,
          printRun,
          playerName: r.playerName ?? null,
          compCount: 0,
        };
        tuples.set(slug, t);
      }
      t.compCount++;
      if (!t.playerName && r.playerName) t.playerName = r.playerName;
    }
    process.stdout.write(`  ...scanned ${scanned}, tuples ${tuples.size}\r`);
  }
  console.log(`\n  ✓ ${scanned} comps → ${tuples.size} unique tuples (skipped ${skipped})`);

  if (tuples.size === 0) { console.log(`\n▸ Nothing to build.`); process.exit(0); }

  if (!args.autoApprove && !args.dryRun) {
    const ans = await ask(`\n  Upsert ${tuples.size} canonical catalog rows? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) { console.log("Aborted."); process.exit(0); }
  }
  if (args.dryRun) { console.log(`\n▸ DRY RUN — done.`); process.exit(0); }

  // CF-CATALOG-FIRST speedup (Drew, 2026-08-04): switched from per-item
  // upsert to Cosmos `container.items.bulk()` API. Batches 100 ops per
  // HTTP round-trip and groups server-side by partition. Combined with
  // 4-way parallel bulk() calls, throughput jumps from ~20/s per process
  // to ~400-800/s per process. Same 429-retry-with-backoff pattern as
  // referenceCatalog.repository.ts.
  // CHUNK/PARALLEL_BULKS tuned to 50/2 after the 100/4 smoke-test threw
  // batch-level 429s. The SDK throws on partition RU exhaustion (does
  // NOT return per-op statuses like the referenceCatalog pattern). Fewer
  // in-flight ops → fewer whole-batch throws. Retry logic below handles
  // both per-op 429s AND whole-batch throws with exponential backoff.
  const CHUNK = 50;
  const PARALLEL_BULKS = 2;
  const MAX_RETRIES = 12;
  console.log(`\n▸ Upserting via bulk() (chunk ${CHUNK}, parallel ${PARALLEL_BULKS}, max ${MAX_RETRIES} retries)...`);
  const startedAt = Date.now();
  let upserted = 0, errors = 0;
  let done = 0;
  const all = [...tuples.values()];
  const total = all.length;

  const buildDoc = (t: Tuple): JSONObject => {
    const now = new Date().toISOString();
    return {
      id: t.slug,
      cardId: t.slug,
      hobbyiqCardId: t.slug,
      sport: t.sport,
      year: t.year,
      setKey: t.setKey,
      setName: t.setName,
      cardNumber: t.cardNumber,
      parallel: t.parallel,
      parallelSlug: t.parallelSlug,
      isAuto: t.isAuto,
      printRun: t.printRun,
      playerName: t.playerName,
      playerSlug: t.playerName ? slugify(t.playerName) : null,
      source: "bulk-build-from-pool",
      confidence: 0.9,
      observedCompCount: t.compCount,
      lastSeenAt: now,
      searchText: [t.year, t.cardNumber, t.playerName ?? "", t.parallel].filter(Boolean).join(" ").toLowerCase(),
      searchTokens: Array.from(new Set([
        String(t.year),
        t.cardNumber.toLowerCase(),
        ...(t.playerName ? t.playerName.toLowerCase().split(/\s+/) : []),
        ...t.parallel.toLowerCase().split(/\s+/).filter(Boolean),
        ...t.setKey.split("-").filter(Boolean),
      ])),
    } as JSONObject;
  };

  // Split the full list into chunks, then run PARALLEL_BULKS chunks at a time.
  const chunks: Tuple[][] = [];
  for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));

  async function runChunk(chunk: Tuple[]): Promise<void> {
    let pending: Tuple[] = chunk;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const ops = pending.map((t) => ({
        operationType: "Upsert" as const,
        partitionKey: t.slug,
        resourceBody: buildDoc(t),
      }));
      try {
        const results = await cat.items.bulk(ops);
        const nextPending: Tuple[] = [];
        let maxRetryAfterMs = 0;
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.statusCode >= 200 && r.statusCode < 300) {
            upserted++;
            done++;
          } else if (r.statusCode === 429) {
            nextPending.push(pending[j]);
            const ra = (r as { retryAfterMilliseconds?: number }).retryAfterMilliseconds;
            if (typeof ra === "number" && ra > maxRetryAfterMs) maxRetryAfterMs = ra;
          } else {
            errors++;
            done++;
          }
        }
        pending = nextPending;
        if (pending.length > 0) {
          attempt++;
          const wait = Math.max(maxRetryAfterMs, 100 * Math.pow(2, Math.min(attempt, 6)));
          await new Promise((r) => setTimeout(r, wait));
        }
      } catch (err) {
        // Cosmos JS SDK throws on batch-level 429 instead of returning
        // per-op statuses. Detect + retry the same pending batch. Any
        // other error → give up on this chunk.
        const msg = (err as Error).message ?? "";
        if (/request rate is too large/i.test(msg) && attempt < MAX_RETRIES) {
          attempt++;
          const wait = 200 * Math.pow(2, Math.min(attempt, 6));
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        errors += pending.length;
        done += pending.length;
        if (errors < 5) console.warn(`\n  ! bulk failed: ${msg}`);
        return;
      }
    }
    // Anything still pending after MAX_RETRIES gets marked failed.
    if (pending.length > 0) {
      errors += pending.length;
      done += pending.length;
    }
  }

  for (let i = 0; i < chunks.length; i += PARALLEL_BULKS) {
    const batch = chunks.slice(i, i + PARALLEL_BULKS);
    await Promise.all(batch.map(runChunk));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / elapsedSec;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(`  ...upserted ${upserted}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s eta ${etaSec}s\r`);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n▸ Done in ${elapsedSec}s:`);
  console.log(`   upserted: ${upserted}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
