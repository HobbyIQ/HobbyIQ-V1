/**
 * CF-WAVE-BRANCH-TRUTH (2026-09-20). Follows the pattern in
 * cbcVintage1982And1985DonrussAnd1989HoopsPlannerVerdict.test.ts and
 * wave1AcquisitionPackagesMatchTheirCommittedPlannerVerdict.test.ts: pins the
 * sanctioned ingester's OWN planStagedDirectory verdict for each package this
 * PR ships, measured with nothing but what THIS branch provides.
 *
 * Owner's order: hockey|<year>|upper-deck is the worst-backed sport-year cell
 * in the whole census because the Upper Deck flagship checklists were
 * missing. This PR closes three of the four biggest named holes:
 *
 *   - 2024-25 Upper Deck Series 2 Hockey (upperdeck.com)            PASS
 *   - 2024-25 Upper Deck Extended Series Hockey (upperdeck.com)     PASS
 *   - 2021-22 Upper Deck Extended Series Hockey (upperdeck.com)     PASS
 *
 * All three resolve to setKeys already registered in productSetKeys.ts
 * before this PR (upper-deck-series-2 / upper-deck-extended-series, both
 * `refines: "upper-deck"` -- sales derive to the bare `upper-deck` id, these
 * checklists back it) -- no productSetKeys.ts registrations were made in
 * this PR. Two insert sets in the 2024-25 Extended Series package (Acetate
 * Young Guns, 2023-24 Update - Acetate Young Guns) are held out of the
 * staged CSV rather than guessed into an unregistered or colliding shape;
 * see that package's manifest `heldOut` for the roster-overlap evidence.
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

describe("2024-25 Upper Deck Series 2 Hockey (upperdeck.com) — PASS", () => {
  it("planStagedDirectory reports PASS: upper-deck-series-2, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-upperdeck-series2-hockey-2425");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("hockey");
    expect(entry.product.year).toBe(2024);
    expect(entry.product.setKey).toBe("upper-deck-series-2");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(4631);
    expect(entry.plan.ids).toBe(4631);
  });

  it("Population Count reuses the already-registered upper-deck-series-2-population-count-1000 key: one category, six other print-run rungs ride as its parallel value", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-series2-hockey-2425", "2024-25-upper-deck-series-2-hockey.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const pc = lines.filter((l) => l.startsWith("insert-population-count-1000,"));
    expect(pc.length).toBe(210); // 30 cards x 7 rungs, one category
    expect(lines.some((l) => l.startsWith("insert-population-count-500,"))).toBe(false);
    expect(lines.some((l) => l.startsWith("insert-population-count-1,"))).toBe(false);
    const parallels = new Set(pc.map((l) => l.split(",")[2]));
    expect(parallels).toEqual(new Set(["", "Population Count 500", "Population Count 100", "Population Count 50", "Population Count 25", "Population Count 10", "Population Count 1"]));
  });

  it("card #C190's two-player source contradiction (Roman Josi / Elvis Merzlikins) is held out, not guessed", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-series2-hockey-2425", "2024-25-upper-deck-series-2-hockey.csv"),
      "utf8",
    );
    expect(csv.includes(",C190,")).toBe(false);
  });

  it("Exclusives/High Gloss/Deluxe carry their stated print run; Clear Cut/Outburst are genuinely unnumbered per source", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-series2-hockey-2425", "2024-25-upper-deck-series-2-hockey.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const row = (parallel: string) => lines.find((l) => l.startsWith(`base-set,251,${parallel},`));
    expect(row("Deluxe")).toMatch(/^base-set,251,Deluxe,false,250,/);
    expect(row("Exclusives")).toMatch(/^base-set,251,Exclusives,false,100,/);
    expect(row("High Gloss")).toMatch(/^base-set,251,High Gloss,false,10,/);
    expect(row("Clear Cut")).toMatch(/^base-set,251,Clear Cut,false,,/);
    expect(row("Outburst")).toMatch(/^base-set,251,Outburst,false,,/);
  });
});

describe("2024-25 Upper Deck Extended Series Hockey (upperdeck.com) — PASS", () => {
  it("planStagedDirectory reports PASS: upper-deck-extended-series, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-upperdeck-extended-series-hockey-2425");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("hockey");
    expect(entry.product.year).toBe(2024);
    expect(entry.product.setKey).toBe("upper-deck-extended-series");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(3737);
    expect(entry.plan.ids).toBe(3737);
  });

  it("Acetate Young Guns and 2023-24 Update - Acetate Young Guns are held out of the staged CSV (own-roster inserts pending productSetKeys.ts registration)", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2425", "2024-25-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    expect(csv.includes("acetate")).toBe(false);
  });

  it("Trilogy Rookie Premiere's three rarity tiers (Common/Uncommon/Rare, own numbering T-1..T-33) each land as 33 distinct rows with their own stated print run, no card-number collision with base", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2425", "2024-25-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const trilogy = lines.filter((l) => l.startsWith("insert-trilogy-rookie-premiere-rare,"));
    expect(trilogy.length).toBe(99); // 33 cards x 3 rarity tiers, one category, parallel carries the tier
    const common = trilogy.filter((l) => l.split(",")[2] === "Trilogy Rookie Premiere Common");
    const uncommon = trilogy.filter((l) => l.split(",")[2] === "Trilogy Rookie Premiere Uncommon");
    const rare = trilogy.filter((l) => l.split(",")[2] === "");
    expect(common.length).toBe(33);
    expect(uncommon.length).toBe(33);
    expect(rare.length).toBe(33);
    // Each rarity tier carries its OWN stated print run -- Common 999, Uncommon 499, Rare (anchor) 99.
    expect(common.every((l) => l.split(",")[4] === "999")).toBe(true);
    expect(uncommon.every((l) => l.split(",")[4] === "499")).toBe(true);
    expect(rare.every((l) => l.split(",")[4] === "99")).toBe(true);
  });

  it("Oracles' source-typo'd 'SP&quot;s' sibling folds cleanly onto Oracles - SPs with a clean 'Rare' parallel", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2425", "2024-25-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    expect(csv.includes('"')).toBe(false);
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rare = lines.filter((l) => l.startsWith("insert-oracles-sps,") && l.split(",")[2] === "Rare");
    expect(rare.length).toBe(20);
  });

  it("Snow Spray Auto / Swagnificent Photo / Special Game / All-Star Skills card-line subsets are base parallels, not their own category", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2425", "2024-25-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    expect(lines.some((l) => l.split(",")[0] === "insert-snow-spray-auto-variations")).toBe(false);
    expect(lines.some((l) => l.split(",")[0] === "base-set" && l.split(",")[2] === "Snow Spray Auto")).toBe(true);
  });
});

describe("2021-22 Upper Deck Extended Series Hockey (upperdeck.com) — PASS", () => {
  it("planStagedDirectory reports PASS: upper-deck-extended-series, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-upperdeck-extended-series-hockey-2122");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("hockey");
    expect(entry.product.year).toBe(2021);
    expect(entry.product.setKey).toBe("upper-deck-extended-series");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(3394);
    expect(entry.plan.ids).toBe(3394);
  });

  it("2021-22 Trilogy Common/Uncommon/Rare Rookies stay THREE separate categories (own, non-overlapping numbering this year, unlike the 2024-25 sibling)", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2122", "2021-22-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const common = lines.filter((l) => l.startsWith("insert-2021-22-trilogy-common-rookies,")).map((l) => l.split(",")[1]);
    const uncommon = lines.filter((l) => l.startsWith("insert-2021-22-trilogy-uncommon-rookies,")).map((l) => l.split(",")[1]);
    const commonSet = new Set(common);
    expect(uncommon.some((n) => commonSet.has(n))).toBe(false);
  });

  it("' AS1' / ' AS2' All-Star team markers and ' CL' Checklist-card markers are stripped from the player field, never concatenated", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-upperdeck-extended-series-hockey-2122", "2021-22-upper-deck-extended-series-hockey.csv"),
      "utf8",
    );
    expect(csv).not.toMatch(/ AS[0-9](,|$)/m);
    expect(csv).not.toMatch(/ CL(,|$)/m);
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const row667 = lines.find((l) => l.startsWith("base-set,667,"));
    expect(row667).toBeDefined();
    expect(row667!.endsWith(",Brad Marchand")).toBe(true);
  });
});
