#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — Rollup path (Drew, 2026-08-04).
 *
 * We already have 117K sales/day from TCA + CH + CS. For any release
 * that has been trading for weeks or months, every card that CAN
 * exist has already sold at least once — meaning our sold_comps pool
 * IS the checklist. This script rolls up sold_comps into canonical
 * card_catalog rows without any external checklist source or LLM.
 *
 * Design:
 *   1. Query sold_comps for a target (year, sport, setKey) with
 *      cross-partition scan.
 *   2. Group by (cardNumber, parallel-canonicalized, isAuto, printRun).
 *   3. For each group, canonicalize via catalogMatcher (which handles
 *      slug generation + upsert).
 *   4. Print rollup summary — cards seen, parallels seen, rows seeded,
 *      rows matched, top players by comp count.
 *
 * Usage:
 *   npx tsx backend/scripts/rollup-catalog-from-pool.ts \
 *     --year 2024 --set-key "bowman-chrome" --sport baseball \
 *     [--dry-run] [--auto-approve]
 *
 * Requires: COSMOS_CONNECTION_STRING. Prompts for approval before
 * seeding to Cosmos unless --auto-approve.
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";
import { canonicalize, canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";

interface Args {
  year?: number;
  setKey?: string;
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
    else if (flag === "--set-key") { args.setKey = val; i++; }
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
  cardYear: number | null;
  sport: string | null;
  source: string;
}

interface GroupKey {
  cardNumber: string;
  parallel: string;    // canonicalized
  isAuto: boolean;
  printRun: number | null;
}

interface GroupData {
  key: GroupKey;
  compCount: number;
  players: Map<string, number>;   // player → count
  setNames: Map<string, number>;  // setName → count (canonical setName)
  sources: Map<string, number>;   // source → count
}

function keyOf(row: CompRow): GroupKey {
  return {
    cardNumber: String(row.cardNumber ?? "").trim().toUpperCase(),
    parallel: canonicalizeParallelName(row.parallel),
    isAuto: !!row.isAuto,
    printRun: typeof row.printRun === "number" ? row.printRun : null,
  };
}

function keyStr(k: GroupKey): string {
  return `${k.cardNumber}||${k.parallel}||${k.isAuto ? "A" : "N"}||${k.printRun ?? "u"}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.setKey || !args.sport) {
    console.error("Usage: rollup-catalog-from-pool.ts --year <n> --set-key <key> --sport <sport> [--dry-run|--auto-approve]");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  console.log(`\n▸ Rollup catalog from pool`);
  console.log(`  year: ${args.year}, setKey: ${args.setKey}, sport: ${args.sport}`);
  if (args.dryRun) console.log(`  DRY RUN — no Cosmos writes`);

  const client = new CosmosClient(conn);
  const sold = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  // Query sold_comps for the target release. Cross-partition (partition
  // is /cardId; we're filtering on year+setKey).
  //
  // We accept multiple ways the setName may be stored:
  //   c.setKey = @sk exactly
  //   c.setName contains a family form ("Bowman Chrome" for setKey "bowman-chrome")
  //   c.hobbyiqCardId contains the setKey
  console.log(`\n▸ Scanning sold_comps for ${args.year} ${args.setKey}...`);
  const setNamePattern = args.setKey.replace(/-/g, " ").toLowerCase();
  const query = `
    SELECT c.cardNumber, c.parallel, c.isAuto, c.printRun, c.playerName,
           c.setName, c.cardYear, c.sport, c.source
    FROM c
    WHERE c.cardYear = @year
      AND (
        c.setKey = @sk
        OR CONTAINS(LOWER(c.setName ?? ''), @snPattern)
        OR CONTAINS(LOWER(c.hobbyiqCardId ?? ''), @skPattern)
      )
  `;
  const params = [
    { name: "@year", value: args.year },
    { name: "@sk", value: args.setKey },
    { name: "@snPattern", value: setNamePattern },
    { name: "@skPattern", value: `:${args.setKey}:` },
  ];
  const iterator = sold.items.query<CompRow>({ query, parameters: params }, { maxItemCount: 500 });

  const groups = new Map<string, GroupData>();
  let scanned = 0;
  let discarded = 0;
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const row of resources) {
      scanned++;
      if (!row.cardNumber || !String(row.cardNumber).trim()) {
        discarded++;
        continue;
      }
      const key = keyOf(row);
      if (!key.cardNumber) {
        discarded++;
        continue;
      }
      const ks = keyStr(key);
      let g = groups.get(ks);
      if (!g) {
        g = {
          key,
          compCount: 0,
          players: new Map(),
          setNames: new Map(),
          sources: new Map(),
        };
        groups.set(ks, g);
      }
      g.compCount++;
      if (row.playerName) {
        const p = row.playerName.trim();
        g.players.set(p, (g.players.get(p) ?? 0) + 1);
      }
      if (row.setName) {
        const s = row.setName.trim();
        g.setNames.set(s, (g.setNames.get(s) ?? 0) + 1);
      }
      if (row.source) {
        g.sources.set(row.source, (g.sources.get(row.source) ?? 0) + 1);
      }
      if (scanned % 5000 === 0) {
        process.stdout.write(`  ...scanned ${scanned}, groups so far ${groups.size}\r`);
      }
    }
  }
  console.log(`  ✓ Scanned ${scanned} comps → ${groups.size} unique (cardNumber × parallel × isAuto × printRun) groups`);
  if (discarded > 0) console.log(`  ⚠ Discarded ${discarded} rows (missing cardNumber)`);

  // Sort groups by comp count so the summary shows most-traded first.
  const sorted = [...groups.values()].sort((a, b) => b.compCount - a.compCount);

  // Preview
  console.log(`\n▸ Preview — top 25 groups (most traded first):`);
  console.log(`   ${"cardNumber".padEnd(12)} ${"parallel".padEnd(30)} ${"auto".padStart(4)} ${"prN".padStart(4)} ${"comps".padStart(6)} player`);
  for (const g of sorted.slice(0, 25)) {
    const topPlayer = [...g.players.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "(unknown)";
    console.log(
      `   ${g.key.cardNumber.padEnd(12)} ${g.key.parallel.padEnd(30)} ${(g.key.isAuto ? "yes" : "no").padStart(4)} ${(g.key.printRun ?? "—").toString().padStart(4)} ${g.compCount.toString().padStart(6)} ${topPlayer}`,
    );
  }
  if (sorted.length > 25) console.log(`   ... ${sorted.length - 25} more groups`);

  const cardsNumbers = new Set(sorted.map((g) => g.key.cardNumber));
  console.log(`\n▸ Rollup summary`);
  console.log(`   distinct cardNumbers: ${cardsNumbers.size}`);
  console.log(`   distinct groups (parallels × cardNumbers): ${sorted.length}`);
  console.log(`   total comps rolled up: ${sorted.reduce((n, g) => n + g.compCount, 0)}`);

  if (args.dryRun) {
    console.log(`\n▸ DRY RUN — done. No Cosmos writes.`);
    process.exit(0);
  }

  if (!args.autoApprove) {
    const ans = await ask(`\n  Approve seeding ${sorted.length} catalog rows to card_catalog? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) {
      console.log("Aborted — nothing written.");
      process.exit(0);
    }
  }

  console.log(`\n▸ Seeding card_catalog via canonicalize()...`);
  let seeded = 0, matched = 0, errors = 0;
  let done = 0;
  const total = sorted.length;
  for (const g of sorted) {
    const topPlayer = [...g.players.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const topSetName = [...g.setNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? args.setKey!;
    try {
      const r = await canonicalize({
        sport: args.sport!,
        year: args.year!,
        setName: topSetName,
        cardNumber: g.key.cardNumber,
        parallel: g.key.parallel,
        isAuto: g.key.isAuto,
        printRun: g.key.printRun,
        player: topPlayer,
        source: "checklist",   // "trusted" so canonicalize seeds when missing
      });
      if (r.matchedBy === "seeded") seeded++;
      else if (r.found) matched++;
      else errors++;
    } catch (err) {
      errors++;
      if (errors < 10) console.warn(`  ! error on ${g.key.cardNumber}/${g.key.parallel}: ${(err as Error).message}`);
    }
    done++;
    if (done % 50 === 0) {
      process.stdout.write(`  ...seeded ${seeded}, matched ${matched}, errors ${errors} (${done}/${total})\r`);
    }
  }

  console.log(`\n▸ Done:`);
  console.log(`   seeded: ${seeded}`);
  console.log(`   matched existing: ${matched}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
