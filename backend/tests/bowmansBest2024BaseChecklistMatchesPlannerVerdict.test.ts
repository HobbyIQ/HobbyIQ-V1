/**
 * Pins the committed acq-2026-09-28-beckett-bowmans-best-2024 package to the
 * sanctioned ingester's own offline planner verdict, the same pattern
 * beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts already uses for
 * the sibling 2026-09-19 Beckett packages: run planStagedDirectory (no
 * Cosmos) against exactly what this PR ships, and fail immediately if a
 * future edit to the CSV or the manifest changes what the branch alone can
 * prove.
 *
 * This is the first-ever numbered checklist acquisition for Bowman's Best
 * baseball (any year). The package carries the FULL Beckett workbook as the
 * source lists it -- the 100 base/prospect cards, their 16 named Refractor-
 * family rungs (plus the Mini-Diamond rungs), and every autograph and insert
 * subset -- so the counts pinned here are the whole staged file, not a
 * base-only slice. The setKey `bowmans-best` is already registered in
 * productSetKeys.ts (parent: "bowman"), so this package registers nothing
 * new; the test below pins that registration is real (normalizeSetKey
 * resolves it to itself) rather than merely asserted in prose.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));
const { normalizeSetKey, computeHobbyIqCardId } = require_(join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");
const DIR_NAME = "acq-2026-09-28-beckett-bowmans-best-2024";
const CSV_NAME = "2024-bowmans-best-baseball.csv";

/** Every category the staged file carries, with its row count -- the
 *  converter's own per-kind output, pinned so a dropped sheet or a silently
 *  absorbed section shows up as a number, not a vibe. */
const EXPECTED_BY_CATEGORY: Record<string, number> = {
  "base": 1900,
  "auto-best-of-2024-autographs": 1442,
  "auto-2024-mlb-all-star-futures-game-chrome-autograph-relics": 306,
  "auto-impact-players-autographs": 100,
  "auto-dual-autographs": 95,
  "auto-triple-autographs": 50,
  "auto-best-ballers-autographs": 44,
  "auto-fabled-phenoms-autographs": 42,
  "auto-family-tree-dual-autographs": 30,
  "auto-bowman-showpieces-autographs": 18,
  "auto-quad-autographs": 12,
  "auto-family-tree-triple-autographs": 6,
  "insert-impact-players": 120,
  "insert-best-ballers": 120,
  "insert-fabled-phenoms": 100,
  "insert-2024-mlb-all-star-futures-game": 60,
  "insert-bowman-showpieces": 48,
  "insert-strokes-of-gold": 25,
  "insert-1955-bowman-anime": 20,
};
const EXPECTED_TOTAL = 4538;

function planPackage() {
  const dir = join(SCRAPED_ROOT, DIR_NAME);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  const plans = INGEST.planStagedDirectory(dir, files);
  return { dir, files, entry: plans.get(CSV_NAME) };
}

function manifest() {
  const path = join(SCRAPED_ROOT, DIR_NAME, CSV_NAME.replace(/\.csv$/, ".manifest.json"));
  return JSON.parse(readFileSync(path, "utf8"));
}

function rows() {
  const raw = readFileSync(join(SCRAPED_ROOT, DIR_NAME, CSV_NAME), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return { header: lines[0], rows: lines.slice(1).map((l) => l.split(",")) };
}

describe("2024 Bowman's Best Baseball full checklist (Beckett S3)", () => {
  it("ships exactly one staged CSV", () => {
    const { files } = planPackage();
    expect(files).toEqual([CSV_NAME]);
  });

  it("setKey bowmans-best is already a normalizeSetKey fixed point (no new registration needed)", () => {
    expect(normalizeSetKey("bowmans-best")).toBe("bowmans-best");
  });

  it("planStagedDirectory reports PASS: 4,538 rows, 4,538 distinct ids, 0 collisions, 0 unregistered, no subset separation needed", () => {
    const { entry } = planPackage();
    expect(entry.product).not.toBeNull();
    expect(entry.product.setKey).toBe("bowmans-best");
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(2024);
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.reason).toBeNull();
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions.length).toBe(0);
    expect(entry.plan.rows).toBe(EXPECTED_TOTAL);
    expect(entry.plan.ids).toBe(EXPECTED_TOTAL);
    expect(entry.plan.duplicatesFolded).toBe(0);
    expect(entry.plan.unslugable).toBe(0);
    // Every subset carries its own printed prefix (B24-, FGRA-, IP-, FP-, ...)
    // so no insert set ever shares an address with base and the planner
    // measures ZERO need to split any subset onto its own setKey.
    expect(entry.plan.keys).toEqual([]);
  });

  it("carries no heldRows gate — the whole staged file is this product's own checklist", () => {
    const m = manifest();
    expect(m.heldRows).toBeUndefined();
  });

  it("CSV header, total, and per-category counts match the converter output pinned in the manifest", () => {
    const { header, rows: r } = rows();
    expect(header).toBe("category,cardNumber,parallel,isAuto,printRun,player");
    expect(r.length).toBe(EXPECTED_TOTAL);
    const byCat: Record<string, number> = {};
    for (const row of r) byCat[row[0]] = (byCat[row[0]] ?? 0) + 1;
    expect(byCat).toEqual(EXPECTED_BY_CATEGORY);
    expect(Object.values(EXPECTED_BY_CATEGORY).reduce((a, b) => a + b, 0)).toBe(EXPECTED_TOTAL);
  });

  it("the 100 plain base cards: 70 numbered #1-70 + 30 Top Prospects TP-1..TP-30, no duplicates, no auto, no print run", () => {
    const { rows: r } = rows();
    const plain = r.filter((row) => row[0] === "base" && row[2] === "");
    expect(plain.length).toBe(100);
    const numbers = plain.map((row) => row[1]);
    expect(new Set(numbers).size).toBe(100);
    expect(numbers.filter((n) => /^\d+$/.test(n)).length).toBe(70);
    expect(numbers.filter((n) => /^TP-\d+$/.test(n)).length).toBe(30);
    for (const row of plain) {
      expect(row[3]).toBe("false");
      expect(row[4]).toBe("");
    }
  });

  it("base parallels: 16 full-run Refractor-family rungs x 100 cards + the two Mini-Diamond rungs, print runs as the sheet states them", () => {
    const { rows: r } = rows();
    const base = r.filter((row) => row[0] === "base" && row[2] !== "");
    expect(base.length).toBe(1800);
    const byPar: Record<string, { n: number; runs: Set<string> }> = {};
    for (const row of base) {
      byPar[row[2]] ??= { n: 0, runs: new Set() };
      byPar[row[2]].n++;
      byPar[row[2]].runs.add(row[4]);
    }
    // 16 Refractor-family rungs + the 2 Mini-Diamond rungs (full-run once
    // harmonised) = 18 rungs covering all 100 cards; 18 x 100 = 1,800.
    const fullRun = Object.entries(byPar).filter(([, v]) => v.n === 100).map(([k]) => k).sort();
    expect(fullRun.length).toBe(18);
    expect(Object.keys(byPar).length).toBe(18);
    // Every full-run rung states exactly one print run (or none) across all 100 cards.
    for (const k of fullRun) expect(byPar[k].runs.size, k).toBe(1);
    expect(byPar["Refractors"].runs).toEqual(new Set([""]));
    expect(byPar["Wave Refractors"].runs).toEqual(new Set([""]));
    expect(byPar["Superfractors"].runs).toEqual(new Set(["1"]));
    expect(byPar["Black Refractors"].runs).toEqual(new Set(["10"]));
    expect(byPar["Purple Mojo Refractors"].runs).toEqual(new Set(["250"]));
    // The Mini-Diamond rungs cover the whole 100-card run too, once the
    // Prospects sheet's own "Mini-Diamonds" spelling is harmonised onto the
    // Base sheet's "Mini-Diamond" (see manifest.spellingHarmonization).
    expect(byPar["Mini-Diamond Refractors"]).toEqual({ n: 100, runs: new Set(["299"]) });
    expect(byPar["Green Mini-Diamond Refractors"]).toEqual({ n: 100, runs: new Set(["99"]) });
    expect(byPar["Mini-Diamonds Refractors"]).toBeUndefined();
    expect(byPar["Green Mini-Diamonds Refractors"]).toBeUndefined();
  });

  it("the harmonised Mini-Diamond spelling reaches ONE id per card, where the sheet's inner-word plural would have split the pool", () => {
    const mk = (parallel: string) => computeHobbyIqCardId({
      sport: "baseball", year: 2024, setKey: "bowmans-best", cardNumber: "TP-1",
      parallel, isAuto: false, printRun: 299, authoritativeSetKey: true,
    });
    expect(mk("Mini-Diamond Refractors")).toBe(mk("Mini-Diamond Refractor"));
    expect(mk("Mini-Diamonds Refractors")).not.toBe(mk("Mini-Diamond Refractors"));
  });

  it("the five autograph subsets whose sheet rows state a base print run in a per-row cell carry it on their plain row: FPA-/BSA- /99, DA-/QA-/TA- /75 (62 cards); the other six stay blank", () => {
    // CF-A-ROW-STATED-PRINT-RUN-IS-A-STATED-PRINT-RUN (review fix on #2476):
    // the Autographs sheet states these runs beside the card, not on the
    // "Parallels:" ladder, and the converter used to read only the ladder.
    const { rows: r } = rows();
    const plainAuto = r.filter((row) => row[0].startsWith("auto-") && row[2] === "");
    const byPrefix: Record<string, Set<string>> = {};
    for (const row of plainAuto) (byPrefix[row[1].split("-")[0] + "-"] ??= new Set()).add(row[4]);
    expect(byPrefix["FPA-"]).toEqual(new Set(["99"]));
    expect(byPrefix["BSA-"]).toEqual(new Set(["99"]));
    expect(byPrefix["DA-"]).toEqual(new Set(["75"]));
    expect(byPrefix["QA-"]).toEqual(new Set(["75"]));
    expect(byPrefix["TA-"]).toEqual(new Set(["75"]));
    for (const p of ["B24-", "FGRA-", "IPA-", "BBA-", "FDA-", "FTA-"]) expect(byPrefix[p], p).toEqual(new Set([""]));
    const stated = plainAuto.filter((row) => row[4] !== "");
    expect(stated.length).toBe(62);
    expect(stated.filter((row) => row[4] === "99").length).toBe(30);
    expect(stated.filter((row) => row[4] === "75").length).toBe(32);
    // The rung rows of those same subsets keep the LADDER's run, not the cell's.
    const fpaSuper = r.filter((row) => row[1].startsWith("FPA-") && row[2] === "Superfractors");
    expect(fpaSuper.length).toBe(21);
    for (const row of fpaSuper) expect(row[4]).toBe("1");
    const daGold = r.filter((row) => row[1].startsWith("DA-") && row[2] === "Gold Refractors");
    expect(daGold.length).toBe(19);
    for (const row of daGold) expect(row[4]).toBe("50");
  });

  it("every auto-* row is isAuto=true and every insert-*/base row is isAuto=false — Beckett's own sheet split, never inferred from text", () => {
    const { rows: r } = rows();
    for (const row of r) {
      const expected = row[0].startsWith("auto-") ? "true" : "false";
      expect(row[3], `${row[0]} ${row[1]} ${row[2]}`).toBe(expected);
    }
    expect(r.filter((row) => row[3] === "true").length).toBe(2145);
  });

  it("manifest states the setKey is already registered, cites the gap, names each subset's source sheet, and pins the harmonisation", () => {
    const m = manifest();
    expect(m.setKey).toBe("bowmans-best");
    expect(m.setKeyConfirmed).toMatch(/already registered/i);
    expect(m.gapThisFills).toMatch(/24,422/);
    expect(m.rowCount).toBe(EXPECTED_TOTAL);
    expect(m.readyToIngest).toBe(true);
    expect(m.spellingHarmonization.rowsChanged).toBe(60);
    for (const cat of Object.keys(EXPECTED_BY_CATEGORY)) {
      expect(m.sectionsReport.byCategory[cat], cat).toBeDefined();
      expect(m.sectionsReport.byCategory[cat].rows, cat).toBe(EXPECTED_BY_CATEGORY[cat]);
      expect(["Base", "Prospects", "Autographs", "Inserts"]).toContain(m.sectionsReport.byCategory[cat].sheet);
    }
  });
});
