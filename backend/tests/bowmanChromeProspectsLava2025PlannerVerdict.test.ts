/**
 * 2025 Bowman Baseball Chrome Prospects (BCP-) Lava Refractor gap-fill
 * (2026-09-21). Follows the pattern in
 * bowmanFamilyChecklistGapLaddersPlannerVerdict.test.ts: pins the sanctioned
 * ingester's OWN planStagedDirectory verdict, measured with nothing but what
 * THIS branch provides, plus a NO-EXACT-DUPLICATE-ROWS invariant.
 *
 * Diagnosis (gap-router cell "BASEBALL 2025 bowman", ~500-sale STARTSWITH
 * sample of hiq:baseball:2025:bowman: unbacked sold_comps rows): the named
 * "lazer-refractor" and "lava-refractor" unbacked cells split into one real
 * gap and one non-gap on point-read against card_catalog:
 *   - lava-refractor: all 152 catalog BCP- numbers were missing the Chrome
 *     Prospects Checklist's own stated "Lava Refractor /399" rung entirely
 *     (0 of 152). This package fills exactly that rung for the source
 *     page's own 150-card BCP- roster.
 *   - lazer-refractor: NOT sourced. A full-page case-insensitive grep for
 *     "lazer"/"laser" on the checklistinsider 2025 Bowman Baseball page
 *     returned zero matches; cardboardconnection.com's 2025 Bowman page
 *     404s and its search is JS-rendered (unreachable via curl, and its
 *     robots.txt disallows query-string paths); tcdb.com is behind a
 *     Cloudflare JS challenge. Reported as an open, unsourced gap.
 *   - blue-pattern (also named in the router cell) is a FALSE ALARM: card_
 *     catalog already carries a "Blue Pattern" rung on many BP- numbers; the
 *     unbacked sales mostly carry a different slug, "blue-pattern-border",
 *     which is the source page's own verbatim spelling ("Blue Pattern
 *     Border /125") -- a spelling-reconciliation issue, not an absence, and
 *     out of scope for this package.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const plans = INGEST.planStagedDirectory(dir, files);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

/** Fails if the CSV (header excluded) contains any two byte-identical data
 *  rows. */
function expectNoExactDuplicateRows(dir: string, file: string) {
  const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
  const dataRows = lines.slice(1);
  const seen = new Map<string, number>();
  for (const row of dataRows) seen.set(row, (seen.get(row) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  expect(dupes, `exact-duplicate rows found in ${file}: ${JSON.stringify(dupes.slice(0, 5))}`).toEqual([]);
}

describe("2025 Bowman Baseball Chrome Prospects (BCP-) Lava Refractor — PASS", () => {
  it("planStagedDirectory reports zero collisions, zero unregistered, expected row count", () => {
    const { entry } = planPackage("acq-2026-09-21-checklistinsider-bowman-chrome-prospects-lava-2025");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2025);
    expect(entry.product.setKey).toBe("bowman");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(150);
  });

  it("has no exact-duplicate rows and covers exactly BCP-1..BCP-150 with isAuto=false", () => {
    const { dir, file } = planPackage("acq-2026-09-21-checklistinsider-bowman-chrome-prospects-lava-2025");
    expectNoExactDuplicateRows(dir, file);
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").slice(1);
    expect(lines.length).toBe(150);
    const numbers = new Set<string>();
    for (const line of lines) {
      const [category, cardNumber, parallel, isAuto, printRun] = line.split(",");
      expect(category).toBe("insert-chrome-prospects");
      expect(parallel).toBe("Lava Refractor");
      expect(isAuto).toBe("false");
      expect(printRun).toBe("399");
      expect(cardNumber.toUpperCase().startsWith("BCP-")).toBe(true);
      numbers.add(cardNumber);
    }
    expect(numbers.size).toBe(150);
  });
});
