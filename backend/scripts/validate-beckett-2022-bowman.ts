/**
 * Phase A end-to-end validation script.
 *
 * Fetches the 2022 Bowman Baseball checklist from Beckett's S3 bucket (or
 * loads the local fixture when `--offline` is supplied), runs it through the
 * parser, and prints a human-readable summary. The owner uses this output
 * to confirm parallel structures and card counts before Phase B begins.
 *
 * Usage:
 *   npx ts-node backend/scripts/validate-beckett-2022-bowman.ts
 *   npx ts-node backend/scripts/validate-beckett-2022-bowman.ts --offline
 *   npx ts-node backend/scripts/validate-beckett-2022-bowman.ts --json out.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fetchBeckettChecklist } from "../src/agents/beckett/beckettChecklistFetcher.js";
import {
  parseBeckettChecklist,
  type BeckettChecklistParsed,
} from "../src/agents/beckett/beckettChecklistParser.js";

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "beckett",
  "2022-Bowman-Baseball-Checklist-2.xlsx",
);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const jsonFlagIdx = args.indexOf("--json");
  const jsonOut = jsonFlagIdx >= 0 ? args[jsonFlagIdx + 1] : null;

  let bytes: Uint8Array;
  let sourceLabel: string;

  if (offline) {
    if (!fs.existsSync(FIXTURE_PATH)) {
      console.error(`Fixture not found: ${FIXTURE_PATH}`);
      process.exit(2);
    }
    bytes = fs.readFileSync(FIXTURE_PATH);
    sourceLabel = `fixture:${FIXTURE_PATH}`;
    console.log(`[validate] loaded fixture ${FIXTURE_PATH} (${bytes.byteLength} bytes)`);
  } else {
    const result = await fetchBeckettChecklist({
      year: 2022,
      brand: "Bowman",
      sport: "Baseball",
    });
    bytes = result.bytes;
    sourceLabel = `live:${result.url}`;
    console.log(`[validate] fetched ${result.url} (${bytes.byteLength} bytes)`);
  }

  const parsed = parseBeckettChecklist(bytes, { sourceLabel });
  printSummary(parsed);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(parsed, null, 2));
    console.log(`\n[validate] wrote full parse to ${jsonOut}`);
  }
}

function printSummary(parsed: BeckettChecklistParsed): void {
  console.log(`\n=== Beckett Checklist Parse Summary ===`);
  console.log(`Source           : ${parsed.meta.sourceLabel ?? "(unset)"}`);
  console.log(`Parsed at        : ${parsed.meta.parsedAt}`);
  console.log(`Sheets           : ${parsed.meta.sheetNames.join(", ")}`);
  console.log(`Total sections   : ${parsed.sections.length}`);
  console.log(`Total cards      : ${parsed.cards.length}`);
  console.log(`Distinct parallels: ${parsed.parallels.length}`);
  console.log(`Diagnostics      : ${countDiagnostics(parsed)}`);

  console.log(`\n--- Sections (top 12 by card count) ---`);
  const sortedSections = parsed.sections
    .slice()
    .sort((a, b) => b.cards.length - a.cards.length);
  for (const sec of sortedSections.slice(0, 12)) {
    const flags = [
      sec.isAutograph ? "auto" : null,
      sec.isRelic ? "relic" : null,
    ]
      .filter(Boolean)
      .join(",");
    const flagStr = flags ? ` [${flags}]` : "";
    console.log(
      `  [${sec.sheet}] ${sec.name}${flagStr}: ` +
        `cards=${sec.cards.length} ` +
        `declared=${sec.declaredCount ?? "?"} ` +
        `parallels=${sec.parallels.length} ` +
        `diag=${sec.diagnostics.length}`,
    );
  }

  console.log(`\n--- Parallels (every distinct tier, sorted by run asc) ---`);
  const sortedParallels = parsed.parallels.slice().sort((a, b) => {
    const ar = a.printRun ?? (a.isOneOfOne ? 1 : 1e9);
    const br = b.printRun ?? (b.isOneOfOne ? 1 : 1e9);
    return ar - br;
  });
  for (const p of sortedParallels) {
    const run = p.printRun !== null ? `/${p.printRun}` : "1/1";
    const note = p.note ? ` (${p.note})` : "";
    console.log(`  ${p.name.padEnd(40)} ${run}${note}`);
  }

  const autoCards = parsed.cards.filter((c) => c.isAutograph);
  console.log(`\n--- Autograph SKUs identified: ${autoCards.length} ---`);
  for (const c of autoCards.slice(0, 10)) {
    console.log(
      `  [${c.sheet}/${c.section}] ${c.cardNumber ?? "-"} ` +
        `${c.player ?? "?"} ${c.team ? `(${c.team})` : ""} ` +
        `${c.inlinePrintRun ? `/${c.inlinePrintRun}` : ""}`.trim(),
    );
  }
  if (autoCards.length > 10) {
    console.log(`  ... ${autoCards.length - 10} more`);
  }

  console.log(`\n--- Diagnostics ---`);
  const allDiagnostics = [
    ...parsed.diagnostics,
    ...parsed.sections.flatMap((s) => s.diagnostics),
  ];
  if (allDiagnostics.length === 0) {
    console.log(`  (clean — no parse anomalies)`);
  } else {
    const byLevel = {
      error: allDiagnostics.filter((d) => d.level === "error").length,
      warn: allDiagnostics.filter((d) => d.level === "warn").length,
      info: allDiagnostics.filter((d) => d.level === "info").length,
    };
    console.log(
      `  totals: error=${byLevel.error} warn=${byLevel.warn} info=${byLevel.info}`,
    );
    for (const d of allDiagnostics.slice(0, 15)) {
      console.log(
        `  [${d.level}] ${d.sheet}` +
          (d.rowIndex !== null ? `:row${d.rowIndex}` : "") +
          ` — ${d.message}`,
      );
    }
    if (allDiagnostics.length > 15) {
      console.log(`  ... ${allDiagnostics.length - 15} more`);
    }
  }
}

function countDiagnostics(parsed: BeckettChecklistParsed): number {
  return (
    parsed.diagnostics.length +
    parsed.sections.reduce((acc, s) => acc + s.diagnostics.length, 0)
  );
}

main().catch((err) => {
  console.error("[validate] FAILED:", err);
  process.exit(1);
});
