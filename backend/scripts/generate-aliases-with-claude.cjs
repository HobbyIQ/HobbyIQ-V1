#!/usr/bin/env node
/**
 * CF-LLM-ALIAS-BATCH (2026-07-08, Drew):
 *
 * Offline batch script that iterates a seed corpus, asks Claude for
 * alias candidates for each canonical term, and upserts the results
 * into the Cosmos search_aliases container.
 *
 * Idempotent: the upsertAlias merge logic in the repository preserves
 * admin-source entries (never overwritten by LLM), unions aliases
 * arrays with case-insensitive dedupe, and short-circuits re-runs on
 * canonicals that already have LLM entries at >= 12 aliases.
 *
 * ## Usage
 *
 *   CLAUDE_API_KEY=... \
 *   COSMOS_ENDPOINT=... COSMOS_KEY=... \
 *   MAX_COST_USD=5 \
 *   RATE_LIMIT_RPS=3 \
 *   node backend/scripts/generate-aliases-with-claude.cjs
 *
 * ## Seed corpora
 *
 * Runs against three sources:
 *   1. Static in-code seed (canonical parallel/set/grader terms — the
 *      same ones the migration script writes).
 *   2. Empirical parallel-premiums-latest.json (real-world canonical
 *      parallel names we've calibrated — 700+ unique).
 *   3. Optional custom list via --seed-file <path.json>.
 *
 * Safety rails:
 *   - MAX_COST_USD env var — hard cap; script aborts when the running
 *     total exceeds this.
 *   - RATE_LIMIT_RPS env var — max Claude calls per second.
 *   - --dry-run flag — hits Claude but does NOT write to Cosmos.
 *   - --limit <N> — only process the first N canonicals (test runs).
 *   - Progress checkpoints every 25 canonicals with cumulative cost.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Load compiled dist output for the service + repository.
  const distGen = path.resolve(__dirname, "..", "dist", "services", "search", "aliasGeneration.service.js");
  const distRepo = path.resolve(__dirname, "..", "dist", "repositories", "searchAliases.repository.js");
  const distStore = path.resolve(__dirname, "..", "dist", "services", "search", "aliasStore.service.js");

  let generateAliasesForCanonical, upsertAlias, staticSeedAliases;
  try {
    ({ generateAliasesForCanonical } = await import(pathToFileURL(distGen).href));
    ({ upsertAlias } = await import(pathToFileURL(distRepo).href));
    ({ staticSeedAliases } = await import(pathToFileURL(distStore).href));
  } catch (err) {
    console.error(
      "Cannot find dist output. Build with `npm run build` or invoke via tsx.",
    );
    console.error(err.message);
    process.exit(1);
  }

  const MAX_COST_USD = parseFloat(process.env.MAX_COST_USD ?? "5");
  const RATE_LIMIT_RPS = parseFloat(process.env.RATE_LIMIT_RPS ?? "3");
  const rpsDelayMs = Math.max(0, Math.round(1000 / RATE_LIMIT_RPS));

  const seedCorpus = buildSeedCorpus(args, staticSeedAliases);
  const targets = args.limit ? seedCorpus.slice(0, args.limit) : seedCorpus;

  console.log(`[batch-aliases] ${targets.length} canonicals to process`);
  console.log(`[batch-aliases] MAX_COST_USD=${MAX_COST_USD}  RATE_LIMIT_RPS=${RATE_LIMIT_RPS}  DRY_RUN=${!!args.dryRun}`);

  let cumulativeCost = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const { category, canonical } = targets[i];

    if (cumulativeCost > MAX_COST_USD) {
      console.warn(
        `[batch-aliases] cumulative cost $${cumulativeCost.toFixed(4)} exceeds cap $${MAX_COST_USD}. Aborting.`,
      );
      break;
    }

    const result = await generateAliasesForCanonical(canonical, category);
    if (!result || result.aliases.length === 0) {
      skipped++;
      if (i % 25 === 0) {
        console.log(`[batch-aliases] ${i}/${targets.length}: ${category}:${canonical} → skipped`);
      }
      await sleep(rpsDelayMs);
      continue;
    }

    cumulativeCost += result.estimatedCostUSD ?? 0;

    if (!args.dryRun) {
      try {
        await upsertAlias({
          category,
          canonical,
          aliases: result.aliases.map((a) => a.alias),
          source: "llm",
          confidence: 0.7,
          lastConfirmedAt: new Date().toISOString(),
          notes: `LLM-generated, ${result.aliases.length} candidates`,
        });
        ok++;
      } catch (err) {
        failed++;
        console.warn(`[batch-aliases] upsert failed for ${category}:${canonical}:`, err?.message ?? err);
      }
    } else {
      ok++;
    }

    if (i % 25 === 0) {
      console.log(
        `[batch-aliases] ${i}/${targets.length}: ${category}:${canonical} → ${result.aliases.length} aliases (cost so far $${cumulativeCost.toFixed(4)})`,
      );
    }

    await sleep(rpsDelayMs);
  }

  console.log(
    `[batch-aliases] DONE: ${ok} ok, ${skipped} skipped, ${failed} failed. Total cost $${cumulativeCost.toFixed(4)}.`,
  );
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, seedFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit" && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); }
    else if (a === "--seed-file" && argv[i + 1]) { args.seedFile = argv[++i]; }
  }
  return args;
}

function buildSeedCorpus(args, staticSeedAliases) {
  const seed = [];

  // Static in-code seed.
  const staticSeed = staticSeedAliases();
  for (const e of staticSeed) {
    seed.push({ category: e.category, canonical: e.canonical });
  }

  // Empirical parallel-premiums table (real-world calibrated canonicals).
  try {
    const p = path.resolve(__dirname, "..", "data", "parallel-premiums-latest.json");
    if (fs.existsSync(p)) {
      const table = JSON.parse(fs.readFileSync(p, "utf-8"));
      const seenParallels = new Set(seed.filter((s) => s.category === "parallel").map((s) => s.canonical.toLowerCase()));
      for (const e of table.entries ?? []) {
        if (!e.parallel) continue;
        const key = String(e.parallel).trim();
        if (!key || key.toLowerCase() === "base") continue;
        if (seenParallels.has(key.toLowerCase())) continue;
        seenParallels.add(key.toLowerCase());
        seed.push({ category: "parallel", canonical: key });
      }
    }
  } catch (err) {
    console.warn("[batch-aliases] parallel-premiums seed failed:", err?.message ?? err);
  }

  // Custom seed file (optional).
  if (args.seedFile) {
    try {
      const custom = JSON.parse(fs.readFileSync(args.seedFile, "utf-8"));
      if (Array.isArray(custom)) {
        for (const entry of custom) {
          if (entry?.canonical && entry?.category) {
            seed.push({ category: entry.category, canonical: entry.canonical });
          }
        }
      }
    } catch (err) {
      console.warn("[batch-aliases] custom seed load failed:", err?.message ?? err);
    }
  }

  return seed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
