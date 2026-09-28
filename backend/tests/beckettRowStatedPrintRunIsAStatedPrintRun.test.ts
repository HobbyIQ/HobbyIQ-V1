/**
 * CF-A-ROW-STATED-PRINT-RUN-IS-A-STATED-PRINT-RUN (2026-09-28, review fix on
 * #2476).
 *
 * Some Beckett sheets state a subset's BASE print run not on a "Parallels:"
 * ladder line but in a per-row cell beside the card:
 *
 *   ["FPA-AM", "Aidan Miller", "Philadelphia Phillies", "/99"]
 *
 * convertBeckettChecklistXlsx.cjs read only the ladder, so the plain row of
 * every such card carried printRun="" although the source stated one.
 * Measured on 2024 Bowman's Best Baseball's Autographs sheet: 62 cards across
 * five subsets (Fabled Phenoms Autographs and Bowman Showpieces Autographs
 * "/99"; Dual, Triple and Quad Autographs "/75"), while the sheet's other six
 * subsets genuinely have nothing in that column and were correctly blank.
 *
 * The fix reads the cell GENERICALLY -- any cell past the player column whose
 * whole content is "/N" -- never a prefix list, and consumes it only to FILL
 * a run the section/ladder resolution left blank. A stated ladder run is
 * never overridden; a disagreement is recorded (printRunConflicts, kind
 * "row-cell-vs-ladder"), not resolved. This file pins the mechanism on a
 * minimal synthetic fixture with the real sheet's exact shape, so it holds
 * for the next workbook, not just the one committed under
 * acq-2026-09-28-beckett-bowmans-best-2024 (pinned separately there).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-row-printrun-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = { category: string; cardNumber: string; parallel: string; isAuto: string; printRun: string; player: string };

function convert(sheets: Record<string, unknown[][]>, setKey: string): { rows: Row[]; manifest: Record<string, unknown> } {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const xlsxPath = path.join(TMP, `${setKey}-in.xlsx`);
  XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
  const out = path.join(TMP, `${setKey}.csv`);
  execFileSync(process.execPath, [
    CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", setKey, "--sport", "baseball",
    "--set-name", `2024 ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
  const manifest = JSON.parse(fs.readFileSync(out.replace(/\.csv$/, ".manifest.json"), "utf8"));
  return { rows, manifest };
}

/** The real Autographs-sheet shape: title, count line, "Parallels:", ladder
 *  lines, then card rows [number, player, team, <per-row cell>, <flag>]. */
const AUTOGRAPHS: unknown[][] = [
  ["Fabled Phenoms Autographs Checklist"],
  [],
  ["3 cards."],
  [],
  ["Parallels:"],
  [],
  ["Superfractors - 1/1"],
  [],
  ["FPA-AM", "Aidan Miller", "Philadelphia Phillies", "/99", ""],
  ["FPA-BM", "Bryce Miller", "Seattle Mariners", "/99", "Rookie"],
  ["FPA-DC", "Dylan Crews", "Washington Nationals", "/99", ""],
  [],
  ["Impact Players Autographs Checklist"],
  [],
  ["2 cards."],
  [],
  ["Parallels:"],
  [],
  ["Lava Refractors - /50"],
  ["Superfractors - 1/1"],
  [],
  ["IPA-AR", "Adley Rutschman", "Baltimore Orioles", "", ""],
  ["IPA-PS", "Paul Skenes", "Pittsburgh Pirates", "", "Rookie"],
  [],
  ["Dual Autographs Checklist"],
  [],
  ["1 cards."],
  [],
  ["Parallels:"],
  [],
  ["Gold Refractors - /50"],
  [],
  ["DA-AM", "Aidan Miller / Mick Abel", "Philadelphia Phillies", "/75", ""],
];

describe("CF-A-ROW-STATED-PRINT-RUN-IS-A-STATED-PRINT-RUN", () => {
  const { rows, manifest } = convert({ Autographs: AUTOGRAPHS }, "row-printrun-fixture");
  const plain = (prefix: string) => rows.filter((r) => r.cardNumber.startsWith(prefix) && r.parallel === "");

  it("a per-row '/N' cell fills the PLAIN row's print run, generically, for every card that states one", () => {
    expect(plain("FPA-").map((r) => r.printRun)).toEqual(["99", "99", "99"]);
    expect(plain("DA-").map((r) => r.printRun)).toEqual(["75"]);
    for (const r of [...plain("FPA-"), ...plain("DA-")]) expect(r.isAuto).toBe("true");
  });

  it("a card row with nothing in that column stays blank -- the cell is read, never inferred", () => {
    expect(plain("IPA-").map((r) => r.printRun)).toEqual(["", ""]);
  });

  it("the ladder's own rung rows are untouched: the cell states the BASE run, not the rung's", () => {
    const fpaSuper = rows.filter((r) => r.cardNumber.startsWith("FPA-") && r.parallel === "Superfractors");
    expect(fpaSuper.length).toBe(3);
    for (const r of fpaSuper) expect(r.printRun).toBe("1");
    const daGold = rows.filter((r) => r.cardNumber.startsWith("DA-") && r.parallel === "Gold Refractors");
    expect(daGold.map((r) => r.printRun)).toEqual(["50"]);
  });

  it("'Rookie' / team / blank cells never read as a run, and the flag column does not leak into the player", () => {
    expect(plain("FPA-").find((r) => r.cardNumber === "FPA-BM")?.player).toBe("Bryce Miller");
    expect(plain("IPA-").find((r) => r.cardNumber === "IPA-PS")?.player).toBe("Paul Skenes");
  });

  it("the manifest records which sections' plain rows took a run from the cell, and how many", () => {
    const finding = manifest.rowStatedPrintRuns as { rows: number; bySection: Record<string, number> };
    expect(finding).toBeDefined();
    expect(finding.rows).toBe(4);
    const sections = Object.keys(finding.bySection).sort();
    expect(sections.length).toBe(2);
    expect(sections.some((s) => /Fabled Phenoms Autographs/.test(s))).toBe(true);
    expect(sections.some((s) => /Dual Autographs/.test(s))).toBe(true);
    expect(Object.values(finding.bySection).reduce((a, b) => a + b, 0)).toBe(4);
    expect(manifest.printRunConflicts).toBeUndefined();
  });
});
