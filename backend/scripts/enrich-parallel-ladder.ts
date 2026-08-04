#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST P1 — parallel ladder enrichment (Drew, 2026-08-04).
 *
 * For every distinct (cardNumber, isAuto) in card_catalog matching a
 * defined ladder, seed the FULL parallel structure — every parallel
 * that should exist per the ladder, not just the ones observed in
 * sales.
 *
 * Example: Cam Caminiti CPA-CC 2024 Bowman Chrome auto → pool has
 * ["Base", "Blue Refractor", "Refractor"]. Ladder for
 * bowman-chrome:auto:2024 says the card SHOULD have 17 parallels.
 * Enrichment seeds the 14 missing ones with source="ladder-enrich".
 *
 * Additive only — never removes existing rows; only seeds missing
 * ones via canonicalize() (which is idempotent).
 *
 * Usage:
 *   npx tsx backend/scripts/enrich-parallel-ladder.ts \
 *     --year 2024 --set-key bowman-chrome [--auto|--no-auto|both] \
 *     [--dry-run] [--auto-approve]
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";
import { canonicalize } from "../src/services/catalog/catalogMatcher.service.js";
import { findLadder } from "../src/services/catalog/parallelLadders.js";

interface Args {
  year?: number;
  setKey?: string;
  autoMode?: "auto" | "no-auto" | "both";
  dryRun?: boolean;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { autoMode: "both" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--set-key") { args.setKey = val; i++; }
    else if (flag === "--auto") { args.autoMode = "auto"; }
    else if (flag === "--no-auto") { args.autoMode = "no-auto"; }
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

interface CatalogRow {
  id: string;
  cardNumber?: string;
  parallel?: string;
  parallelSlug?: string;
  isAuto?: boolean;
  playerName?: string;
  sport?: string;
  year?: number;
  setKey?: string;
  setName?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.setKey) {
    console.error("Usage: enrich-parallel-ladder.ts --year <n> --set-key <key> [--auto|--no-auto|both] [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  console.log(`\n▸ Parallel-ladder enrichment`);
  console.log(`  year: ${args.year}, setKey: ${args.setKey}, mode: ${args.autoMode}`);
  if (args.dryRun) console.log(`  DRY RUN — no writes`);

  // Fetch every catalog row for this release.
  const { resources } = await cat.items.query<CatalogRow>({
    query: "SELECT c.id, c.cardNumber, c.parallel, c.parallelSlug, c.isAuto, c.playerName, c.sport, c.year, c.setKey, c[\"set\"] AS setName FROM c WHERE c.year = @y AND c.setKey = @sk",
    parameters: [
      { name: "@y", value: args.year },
      { name: "@sk", value: args.setKey },
    ],
  }).fetchAll();

  console.log(`\n▸ Fetched ${resources.length} catalog rows for ${args.year} ${args.setKey}`);

  // Group by (cardNumber, isAuto) → set of existing parallel slugs.
  const groups = new Map<string, { cardNumber: string; isAuto: boolean; player: string | null; sport: string; existingSlugs: Set<string> }>();
  for (const r of resources) {
    if (!r.cardNumber) continue;
    const cardNumber = r.cardNumber.toUpperCase();
    const isAuto = r.isAuto === true;
    const key = `${cardNumber}||${isAuto ? "A" : "N"}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        cardNumber,
        isAuto,
        player: r.playerName ?? null,
        sport: r.sport ?? "baseball",
        existingSlugs: new Set(),
      };
      groups.set(key, g);
    }
    if (r.parallelSlug) g.existingSlugs.add(r.parallelSlug);
    else if (r.parallel) g.existingSlugs.add(r.parallel.toLowerCase().replace(/\s+/g, "-"));
    if (!g.player && r.playerName) g.player = r.playerName;
  }

  console.log(`  ${groups.size} distinct (cardNumber, isAuto) groups`);

  // Filter by --auto flag
  const filtered = [...groups.values()].filter((g) => {
    if (args.autoMode === "auto") return g.isAuto;
    if (args.autoMode === "no-auto") return !g.isAuto;
    return true;
  });
  console.log(`  ${filtered.length} groups after --${args.autoMode} filter`);

  // Compute missing rungs per group
  let totalToSeed = 0;
  interface PlanRow {
    cardNumber: string;
    isAuto: boolean;
    player: string | null;
    sport: string;
    missingRungs: Array<{ name: string; printRun: number | null }>;
    ladderKey: string;
  }
  const plan: PlanRow[] = [];
  let noLadderCount = 0;
  for (const g of filtered) {
    const ladder = findLadder({ year: args.year!, setKey: args.setKey!, isAuto: g.isAuto });
    if (!ladder) { noLadderCount++; continue; }
    const missing: Array<{ name: string; printRun: number | null }> = [];
    for (const rung of ladder.rungs) {
      if (!g.existingSlugs.has(rung.slug)) {
        missing.push({ name: rung.name, printRun: rung.printRun });
      }
    }
    if (missing.length > 0) {
      plan.push({
        cardNumber: g.cardNumber,
        isAuto: g.isAuto,
        player: g.player,
        sport: g.sport,
        missingRungs: missing,
        ladderKey: ladder.key,
      });
      totalToSeed += missing.length;
    }
  }

  console.log(`\n▸ Plan`);
  console.log(`  cards missing ANY rungs: ${plan.length}`);
  console.log(`  total rows to seed: ${totalToSeed}`);
  if (noLadderCount > 0) console.log(`  cards with no defined ladder: ${noLadderCount}`);

  if (plan.length === 0) {
    console.log(`\n▸ Nothing to enrich.`);
    process.exit(0);
  }

  console.log(`\n▸ Sample (top 8 cards, up to 5 missing rungs each):`);
  for (const p of plan.slice(0, 8)) {
    console.log(`   #${p.cardNumber}${p.isAuto ? " (auto)" : ""} — ${p.player ?? "?"} — missing ${p.missingRungs.length}`);
    for (const r of p.missingRungs.slice(0, 5)) {
      console.log(`      + ${r.name}${r.printRun ? ` /${r.printRun}` : ""}`);
    }
  }

  if (args.dryRun) {
    console.log(`\n▸ DRY RUN — done.`);
    process.exit(0);
  }
  if (!args.autoApprove) {
    const ans = await ask(`\n  Approve seeding ${totalToSeed} catalog rows? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) {
      console.log("Aborted — nothing written.");
      process.exit(0);
    }
  }

  console.log(`\n▸ Enriching card_catalog (concurrency 8)...`);
  const startedAt = Date.now();
  let seeded = 0, matched = 0, errors = 0;
  let done = 0;
  const flat: Array<{ p: PlanRow; rung: { name: string; printRun: number | null } }> = [];
  for (const p of plan) for (const r of p.missingRungs) flat.push({ p, rung: r });
  const total = flat.length;
  const CONCURRENCY = 8;
  for (let i = 0; i < flat.length; i += CONCURRENCY) {
    const batch = flat.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ p, rung }) => {
      try {
        const r = await canonicalize({
          sport: p.sport,
          year: args.year!,
          setName: args.setKey!,      // pass setKey; canonicalize normalizes
          cardNumber: p.cardNumber,
          parallel: rung.name,
          isAuto: p.isAuto,
          printRun: rung.printRun,
          player: p.player,
          source: "checklist",
        });
        if (r.matchedBy === "seeded") seeded++;
        else if (r.found) matched++;
        else errors++;
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`  ! ${p.cardNumber}/${rung.name}: ${(err as Error).message}`);
      }
      done++;
    }));
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / elapsedSec;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(`  ...seeded ${seeded}, matched ${matched}, err ${errors} (${done}/${total}) ${rate.toFixed(1)}/s eta ${etaSec}s\r`);
  }

  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s:`);
  console.log(`   seeded: ${seeded}`);
  console.log(`   matched: ${matched}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
