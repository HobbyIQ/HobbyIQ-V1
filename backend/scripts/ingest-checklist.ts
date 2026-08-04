#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST — Tier 2 CLI (Drew, 2026-08-04).
 *
 * Runs a full checklist ingest pipeline end-to-end from Drew's shell:
 *   1. Fetch (or read stdin) the raw checklist source content.
 *   2. Extract structured cards via LLM (checklistIngest.service).
 *   3. Print a diff summary of what would be seeded / updated.
 *   4. Prompt for approval (unless --auto-approve).
 *   5. On approval, seed each row via catalogMatcher.canonicalize.
 *
 * Usage:
 *   # From a URL (Topps / Beckett product page):
 *   npx tsx backend/scripts/ingest-checklist.ts \
 *     --url "https://www.topps.com/pages/2024-bowman-chrome-baseball-checklist" \
 *     --year 2024 --set "Bowman Chrome" --sport baseball
 *
 *   # From a pasted checklist file:
 *   npx tsx backend/scripts/ingest-checklist.ts \
 *     --file checklist.txt --year 2024 --set "Bowman Chrome" --sport baseball
 *
 *   # From stdin:
 *   cat checklist.txt | npx tsx backend/scripts/ingest-checklist.ts \
 *     --year 2024 --set "Bowman Chrome" --sport baseball
 *
 * Requires: AZURE_OPENAI_* env, COSMOS_CONNECTION_STRING.
 * Prompts for approval before writing to prod Cosmos.
 */

import { extractChecklistWithLlm } from "../src/services/catalog/checklistIngest.service.js";
import { canonicalize } from "../src/services/catalog/catalogMatcher.service.js";
import { createInterface } from "readline";
import { readFileSync } from "fs";

interface Args {
  url?: string;
  file?: string;
  year?: number;
  set?: string;
  sport?: string;
  subset?: string;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--url") { args.url = val; i++; }
    else if (flag === "--file") { args.file = val; i++; }
    else if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--set") { args.set = val; i++; }
    else if (flag === "--sport") { args.sport = val; i++; }
    else if (flag === "--subset") { args.subset = val; i++; }
    else if (flag === "--auto-approve" || flag === "-y") { args.autoApprove = true; }
  }
  return args;
}

async function readContent(args: Args): Promise<string> {
  if (args.file) {
    return readFileSync(args.file, "utf-8");
  }
  if (args.url) {
    const resp = await fetch(args.url, {
      headers: { "User-Agent": "Mozilla/5.0 (HobbyIQ checklist ingest)" },
    });
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
    return await resp.text();
  }
  // stdin
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !args.set || !args.sport) {
    console.error("Usage: ingest-checklist.ts --year <n> --set <name> --sport <sport> [--url|--file|stdin]");
    process.exit(2);
  }

  console.log(`\n▸ Ingest checklist for ${args.year} ${args.set} (${args.sport})`);
  console.log(`  Source: ${args.url ?? args.file ?? "stdin"}`);

  console.log("\n▸ Fetching content...");
  const rawContent = await readContent(args);
  console.log(`  ${rawContent.length} chars`);

  console.log("\n▸ Extracting via LLM (Azure OpenAI)...");
  const extracted = await extractChecklistWithLlm({
    source: args.url ? "generic-url" : args.file ? "manual-text" : "manual-text",
    sourceUrl: args.url ?? null,
    rawContent,
    contextHints: {
      year: args.year,
      sport: args.sport,
      setName: args.set,
      subset: args.subset ?? null,
    },
  });

  if (!extracted.ok) {
    console.error(`\n✗ Extraction failed: ${extracted.error}`);
    if (extracted.rawResponse) {
      console.error(`  Raw response: ${extracted.rawResponse.slice(0, 400)}`);
    }
    process.exit(1);
  }

  console.log(`  ✓ Extracted ${extracted.cards.length} cards`);
  console.log(`  Tokens: ${extracted.tokenCost.prompt} prompt / ${extracted.tokenCost.completion} completion`);
  console.log(`  Reasoning: ${extracted.reasoning}`);

  // Dry-run: preview seeds
  console.log(`\n▸ Preview (top 15 cards, top 6 parallels each):`);
  for (const card of extracted.cards.slice(0, 15)) {
    console.log(`  #${card.cardNumber} — ${card.player}${card.isAuto ? " (auto)" : ""}`);
    for (const p of card.parallels.slice(0, 6)) {
      const rn = p.printRun ? `/${p.printRun}` : (p.isSsp ? " SSP" : "");
      console.log(`    ↳ ${p.name}${rn}`);
    }
    if (card.parallels.length > 6) {
      console.log(`    ↳ ... ${card.parallels.length - 6} more parallels`);
    }
  }
  if (extracted.cards.length > 15) {
    console.log(`  ... ${extracted.cards.length - 15} more cards`);
  }

  const totalRows = extracted.cards.reduce((n, c) => n + c.parallels.length, 0);
  console.log(`\n▸ Will attempt to seed ${totalRows} catalog rows (${extracted.cards.length} cards × avg ${(totalRows / extracted.cards.length).toFixed(1)} parallels).`);

  if (!args.autoApprove) {
    const ans = await ask("\n  Approve write to card_catalog? [y/N] ");
    if (!/^y(es)?$/i.test(ans)) {
      console.log("Aborted — nothing written.");
      process.exit(0);
    }
  }

  console.log("\n▸ Seeding card_catalog...");
  let seeded = 0, matched = 0, errors = 0;
  for (const card of extracted.cards) {
    for (const p of card.parallels) {
      try {
        const result = await canonicalize({
          sport: extracted.release.sport,
          year: extracted.release.year,
          setName: extracted.release.setName || args.set!,
          cardNumber: card.cardNumber,
          parallel: p.name,
          isAuto: card.isAuto,
          printRun: p.printRun,
          player: card.player,
          source: "checklist",
        });
        if (result.matchedBy === "seeded") seeded++;
        else if (result.found) matched++;
        else errors++;
      } catch (err) {
        console.warn(`  ! error on ${card.cardNumber}/${p.name}: ${(err as Error).message}`);
        errors++;
      }
    }
  }

  console.log(`\n▸ Done:`);
  console.log(`   seeded: ${seeded}`);
  console.log(`   matched existing: ${matched}`);
  console.log(`   errors / not-found: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
