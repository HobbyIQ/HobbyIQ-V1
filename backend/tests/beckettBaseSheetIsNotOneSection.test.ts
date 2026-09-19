/**
 * CF-BECKETT-BASE-SHEET-IS-NOT-ONE-SECTION (2026-09-19).
 *
 * categoryFor(sheetName, section) tested only the SHEET name: any section
 * printed on a tab literally named "Base" (or "Prospects") returned "base",
 * full stop. That is correct when the sheet genuinely holds one plain run,
 * but 2024 Panini Zenith Football's Base tab holds three consecutive
 * sections before any other sheet: "Base Set" (#1-100, unsigned), "Rookies"
 * (#101-200, unsigned), and "Rookie Patch Autographs" (#201-242, SIGNED per
 * Beckett's own Master sheet — Blue /25, Gold /10, Red /50, White 1/1).
 *
 * categoryFor("Base", "Rookie Patch Autographs - #201-242") returned "base".
 * In classifySections, category === "base" makes a section an
 * explicitAnchor, which bypasses the extendsName title-containment guard
 * entirely — so the section became an eligible fold target for every other
 * non-auto section in the workbook via numeric overlap alone, and 22
 * genuinely distinct insert/parallel sections (Z Marquee, Zoom Blue/Red/Gold,
 * Contenders Optic Rookie Ticket Variation RPS Preview colours, and 17 more)
 * were folded onto it as false PARALLELs. Separately and more seriously,
 * category "base" also set isAuto=false on the 100 rows in that merged
 * section — including the 42 genuinely signed Rookie Patch Autographs cards
 * (e.g. #201 Michael Penix Jr.) — the exact class of defect this whole audit
 * exists to catch, just found natively in Beckett's own lane rather than in
 * checklistinsider's.
 *
 * This is the same "categoryFor returned base for everything on the sheet"
 * collapse CF-EVERY-INGEST-USES-THE-ONE-FORMAT (2026-08-26) already
 * documented for checklistinsider: a sheet name is not a section.
 *
 * The fix keeps "base" permissive for every section on a Base/Prospects
 * sheet EXCEPT one whose own SECTION name says signed — the one bit of
 * section-name evidence safe to trust without an unbounded whitelist of
 * "what a publisher might call the plain run" (a whitelist approach was
 * tried first and broke 2026 Topps Tier One, whose plain run is split into
 * "Base - Tier 1/2/3" with no single canonical spelling at all).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { categoryFor } = require("../scripts/convertBeckettChecklistXlsx.cjs");

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const FIXTURES = path.join(__dirname, "fixtures", "beckett");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-base-sheet-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto: string; printRun: string; player: string;
};

function convert(fixture: string, setKey: string, year = 2024): Row[] {
  const out = path.join(TMP, `${setKey}.csv`);
  execFileSync(process.execPath, [
    CONVERTER,
    "--xlsx", path.join(FIXTURES, fixture),
    "--year", String(year), "--set-key", setKey, "--sport", "football",
    "--set-name", `${year} ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
}

describe("categoryFor requires the SECTION, not just the sheet, to be unsigned", () => {
  it("never returns base for a section that names itself signed", () => {
    expect(categoryFor("Base", "Rookie Patch Autographs - #201-242"))
      .toBe("auto-rookie-patch-autographs-201-242");
    expect(categoryFor("Base", "Rookie Patch Autographs"))
      .toBe("auto-rookie-patch-autographs");
  });

  it("stays permissive for every other section on a Base/Prospects sheet", () => {
    expect(categoryFor("Base", "Base Set")).toBe("base");
    expect(categoryFor(" Base", "Base Set")).toBe("base");
    expect(categoryFor("Base - Prospects", "Base Set")).toBe("base");
    expect(categoryFor("Prospects", "Base Set")).toBe("base");
    expect(categoryFor("Base", "Rookies")).toBe("base");
    expect(categoryFor("Base", "Rookies - #101-200")).toBe("base");
  });

  it("does not regress 2026 Topps Tier One's tier-split base spelling", () => {
    // No canonical "the plain run" name exists here at all -- it is split
    // three ways ("Base - Tier 1/2/3"). A whitelist-of-spellings fix (tried
    // first) broke this exact product; the section-level signed test does not.
    expect(categoryFor("Base", "Base - Tier 1")).toBe("base");
    expect(categoryFor("Base", "Base - Tier 2")).toBe("base");
    expect(categoryFor("Base", "Base - Tier 3")).toBe("base");
  });
});

describe("2024 Panini Zenith Football converts without the false-anchor collapse", () => {
  it("splits the merged Base-sheet section into its three true runs", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const cats = new Set(rows.map((r) => r.category));
    // The wrong, merged section name must never appear as a category at all.
    expect([...cats].some((c) => /^base$/.test(c) === false && /201-242/.test(c) && !/auto-/.test(c)))
      .toBe(false);
    expect(cats.has("auto-rookie-patch-autographs-201-242")).toBe(true);
  });

  it("marks card #201 (Michael Penix Jr., Rookie Patch Autographs) as signed", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const penix = rows.filter((r) => r.cardNumber === "201" && /rookie-patch-autographs/.test(r.category));
    expect(penix.length).toBeGreaterThan(0);
    for (const r of penix) expect(r.isAuto, JSON.stringify(r)).toBe("true");
    // The real print-run ladder from Beckett's own Base-sheet section.
    const printRuns = new Set(penix.map((r) => r.printRun));
    expect(printRuns.has("50")).toBe(true); // Red
    expect(printRuns.has("25")).toBe(true); // Blue
    expect(printRuns.has("10")).toBe(true); // Gold
    expect(printRuns.has("1")).toBe(true);  // White, 1/1
  });

  it("does not fold the 17 genuinely distinct Inserts-sheet sections onto the Base sheet", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const cats = new Set(rows.map((r) => r.category));
    for (const c of [
      "insert-z-marquee-checklist", "insert-zoom-gold-checklist", "insert-zoom-red-checklist",
      "insert-a-to-z-checklist", "insert-alphas-checklist", "insert-behind-the-numbers-checklist",
      "insert-chalk-talk-checklist", "insert-first-look-checklist", "insert-idols-checklist",
      "insert-splash-checklist", "insert-state-of-the-art-checklist", "insert-the-shield-checklist",
      "insert-z-team-checklist", "insert-color-guard-checklist", "insert-turning-pro-memorabilia-checklist",
      "insert-z-jersey-checklist", "insert-zoned-in-checklist",
    ]) expect(cats.has(c), c).toBe(true);
  });

  it("keeps the genuine parallel folds — Z Summit Autographs colour rungs and the Variation pairing", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const zSummitBlue = rows.filter((r) => r.category === "auto-z-summit-autographs-checklist" && r.parallel === "Blue");
    expect(zSummitBlue.length).toBeGreaterThan(0);
    const variationRows = rows.filter((r) => r.category === "auto-contenders-optic-rookie-ticket-rps-preview-blue-checklist" && r.parallel === "Variation");
    expect(variationRows.length).toBeGreaterThan(0);
  });
});
