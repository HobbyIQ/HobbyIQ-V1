// R67 follow-up (2026-09-19). Run 35473622220 REFUSED the live acquisition
// file `backend/data/checklists/scraped/acq-2026-09-19-beckett-panini-zenith-fb/
// 2024-panini-zenith-football.csv` (5,423 rows) for unregistered-set-keys on 7
// derived insert-set keys:
//
//   panini-zenith-rookie-patch-autographs-201-242            1,000 rows
//   panini-zenith-rookies-red-zone-autographs                   332 rows
//   panini-zenith-contenders-optic-rookie-ticket-rps-preview-blue  144 rows
//   panini-zenith-rookies-autographs-no-huddle                   63 rows
//   panini-zenith-rookies-autographs-two-minute-drill            59 rows
//   panini-zenith-contenders-optic-veteran-ticket-preview-blue   48 rows
//   panini-zenith-rookie-patch-autographs-ice                    37 rows
//
// None of the 7 is a real card set. Per-key verdict (see the manifest's own
// `correctionsApplied` note for the full roster evidence):
//
//   rookie-patch-autographs-201-242  CONVERTER BUG. The Base sheet's own
//     table-of-contents preview lines ("Rookies - #101-200",
//     "Rookie Patch Autographs - #201-242") were being read as section
//     headers, so Base Set's OWN 100 veteran-autograph cards (#1-100, e.g.
//     #1 Kyler Murray) were filed under a fictional #201-242 category. Fixed
//     in convertBeckettChecklistXlsx.cjs (see
//     beckettBaseSheetIsNotOneSection.test.ts's own new pins) -- the rows now
//     land on "base" with isAuto correctly true/false per row, and the
//     category disappears entirely; nothing here needed a productSetKeys.ts
//     registration or a hobbyIqCardId.service.ts edit.
//
//   rookies-red-zone-autographs (+blue/gold/red/white),
//   rookies-autographs-no-huddle, rookies-autographs-two-minute-drill
//     R67 CLUSTER, ALREADY REGISTERED ROOT. #2276 registered
//     panini-zenith-rookies-autographs for exactly this signed
//     retailer/tier-name cluster, proven by 100% (59/59, two-minute-drill)
//     and 98.4% (61/62, no-huddle; the one gap is a genuine short-print, not
//     a disagreement) roster overlap. It never auto-folded in THIS file
//     (unlike the test fixture) because there is no bare
//     "auto-rookies-autographs" category present for rungFoldingFor's
//     prefix search to anchor on, and "red-zone-autographs" shares no
//     prefix with "rookies-autographs" at all. Fixed by CSV correction:
//     re-labelled onto category auto-rookies-autographs with the tier name
//     on the parallel axis (never a key).
//
//   contenders-optic-rookie-ticket-rps-preview-blue,
//   contenders-optic-veteran-ticket-preview-blue
//     ALREADY REGISTERED ROOT (#2273/#2276), COLOUR BAKED INTO THE CATEGORY.
//     "Blue" was baked into the category name only on the rows whose OWN
//     parallel column was blank; the SAME category already states Green and
//     Red as parallels with 100% roster identity to the blank rows. Fixed by
//     CSV correction: category loses its "-blue" suffix, blank-parallel
//     rows get parallel=Blue.
//
//   rookie-patch-autographs-ice
//     ALREADY RESOLVED (Drew, researched ruling, 2026-09-19, see
//     productSetKeys.ts): a PARALLEL of rookie-patch-autographs, page-local
//     1-42 renumbering artifact of the real #201-242 range. The ruling's fix
//     had only reached the test fixture; this applies the same +200
//     renumber and re-labelling to the live acquisition CSV.
//
// NONE of the 7 needed a hobbyIqCardId.service.ts edit or a new
// productSetKeys.ts registration -- every root these six categories fold onto
// (rookies-autographs, contenders-optic-rookie-ticket-rps-preview,
// contenders-optic-veteran-ticket-preview, rookie-patch-autographs) was
// already a normalizeSetKey fixed point before this fix.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

const require_ = createRequire(import.meta.url);
const IS = require_(join(__dirname, "..", "scripts", "lib", "insert-set-key.cjs"));
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const PACKAGE_DIR = join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-19-beckett-panini-zenith-fb");
const CSV = join(PACKAGE_DIR, "2024-panini-zenith-football.csv");

type Row = { category: string; cardNumber: string; parallel: string; isAuto: string; printRun: string; player: string };

function readCsv(): Row[] {
  const lines = readFileSync(CSV, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
}

// One package directory, one CSV -- this file is the ONLY csv under
// acq-2026-09-19-beckett-panini-zenith-fb/, confirmed here so a future PR
// cannot silently add a second one to the same package.
describe("exactly one CSV in the Zenith acquisition package directory", () => {
  it("has no sibling CSV", () => {
    const csvs = readdirSync(PACKAGE_DIR).filter((f) => f.endsWith(".csv"));
    expect(csvs).toEqual(["2024-panini-zenith-football.csv"]);
  });
});

describe("the 7 refused categories no longer exist under their unregistered names", () => {
  it("removes the converter-bug category entirely", () => {
    const rows = readCsv();
    const cats = new Set(rows.map((r) => r.category));
    expect(cats.has("auto-rookie-patch-autographs-201-242")).toBe(false);
  });

  it("removes the six re-labelled categories", () => {
    const rows = readCsv();
    const cats = new Set(rows.map((r) => r.category));
    for (const c of [
      "auto-rookie-patch-autographs-ice",
      "auto-contenders-optic-rookie-ticket-rps-preview-blue",
      "auto-contenders-optic-veteran-ticket-preview-blue",
      "auto-rookies-red-zone-autographs",
      "auto-rookies-red-zone-autographs-blue",
      "auto-rookies-red-zone-autographs-gold",
      "auto-rookies-red-zone-autographs-red",
      "auto-rookies-red-zone-autographs-white",
      "auto-rookies-autographs-no-huddle",
      "auto-rookies-autographs-two-minute-drill",
    ]) expect(cats.has(c), c).toBe(false);
  });
});

describe("the corrected rows land on already-registered fixed points", () => {
  it("Ice renumbers into the #201-242 range and matches the main checklist at #201", () => {
    const rows = readCsv();
    const rpa = rows.filter((r) => r.category === "auto-rookie-patch-autographs");
    const byNumPar = new Map(rpa.map((r) => [`${r.cardNumber}::${r.parallel}`, r.player]));
    expect(byNumPar.get("201::Ice")).toBe("Michael Penix Jr.");
    expect(byNumPar.get("201::")).toBe("Michael Penix Jr.");
    // No Ice row anywhere still carries the old 1-42 page-local numbering.
    const ice = rpa.filter((r) => r.parallel === "Ice");
    expect(ice.length).toBe(37);
    for (const r of ice) expect(Number(r.cardNumber)).toBeGreaterThanOrEqual(201);
  });

  it("Blue/Green/Red/Variation all ride one category for each Contenders Optic preview", () => {
    const rows = readCsv();
    for (const cat of ["auto-contenders-optic-rookie-ticket-rps-preview", "auto-contenders-optic-veteran-ticket-preview"]) {
      const rs = rows.filter((r) => r.category === cat);
      expect(rs.length, cat).toBeGreaterThan(0);
      expect(new Set(rs.map((r) => r.parallel)).has("Blue"), `${cat} must state Blue as a parallel`).toBe(true);
    }
  });

  it("Red Zone / No Huddle / Two Minute Drill all ride auto-rookies-autographs", () => {
    const rows = readCsv();
    const rs = rows.filter((r) => r.category === "auto-rookies-autographs");
    const parallels = new Set(rs.map((r) => r.parallel));
    for (const p of ["Red Zone", "Red Zone Blue", "Red Zone Gold", "Red Red Zone", "Red Zone White", "No Huddle", "Two Minute Drill"]) {
      expect(parallels.has(p), p).toBe(true);
    }
    // Every row here is signed -- this is the AUTOGRAPH subset of Rookies.
    expect(rs.every((r) => r.isAuto === "true")).toBe(true);
  });

  it("every fold target is a normalizeSetKey fixed point", () => {
    for (const key of [
      "panini-zenith-rookie-patch-autographs",
      "panini-zenith-rookies-autographs",
      "panini-zenith-contenders-optic-rookie-ticket-rps-preview",
      "panini-zenith-contenders-optic-veteran-ticket-preview",
    ]) {
      expect(normalizeSetKey(key), key).toBe(key);
    }
  });
});

describe("the file, replanned offline, is no longer refused", () => {
  it("planFile reports PASS with zero unregistered keys and zero id collisions", () => {
    const rows = readCsv();
    const productSetKey = "panini-zenith";
    const foldRungs = IS.rungFoldingFor(rows);
    const computeId = (r: Row) => computeHobbyIqCardId({
      sport: "football", year: 2024, setKey: r.setKey ?? productSetKey,
      cardNumber: String(r.cardNumber), parallel: r.parallel || "Base",
      isAuto: r.isAuto === "true", printRun: r.printRun ? Number(r.printRun) : null,
      authoritativeSetKey: true,
    });
    const plan = IS.planFile({ rows, productSetKey, computeId, normalize: normalizeSetKey, foldRungs });
    expect(plan.unregistered, JSON.stringify(plan.unregistered)).toEqual([]);
    expect(plan.collisions, JSON.stringify(plan.collisions?.slice(0, 3))).toEqual([]);
    expect(plan.verdict).toBe("pass");
    expect(plan.rows).toBe(rows.length);
    expect(plan.ids).toBe(rows.length); // every row claims a distinct id
  });

  it("matches the sanctioned ingester's own planStagedDirectory end to end", () => {
    const files = readdirSync(PACKAGE_DIR).filter((f) => f.endsWith(".csv"));
    const plans = INGEST.planStagedDirectory(PACKAGE_DIR, files);
    const entry = plans.get("2024-panini-zenith-football.csv");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
  });
});
