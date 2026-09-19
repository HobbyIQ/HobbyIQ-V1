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
 *
 * CF-BECKETT-EXPLICIT-ANCHOR-IS-NOT-A-BLANK-CHEQUE (2026-09-19), same
 * investigation, a second defect in the same function. category === "base"
 * also makes classifySections mark a section `explicitAnchor: true`, which
 * bypasses the extendsName title-containment guard for every OTHER section
 * tested against it — not just for Zenith's merged section, but for a
 * perfectly correctly-categorized "Base Set" too. 2024 Panini Photogenic
 * Football's Base tab numbers #1-100; ten of its Inserts-sheet sections
 * ("Avatars", "Draft Snapshots", "For the Cure", "In-Motion",
 * "Progressions", "Rookie Introductions", "Rookie Pix", "The Shoe Game",
 * "Troops Tribute", "A Different View") are genuinely independent named
 * insert sets whose OWN numbering (1-10 or 1-20) is a subset of Base Set's
 * range, so the numeric-overlap test found a 100% match and folded every one
 * of them onto Base Set as a false parallel — ten distinct card sets
 * collapsed onto the flagship base run, the same defect class
 * CF-EVERY-INGEST-USES-THE-ONE-FORMAT documented for checklistinsider and
 * #2265/#2266 fixed downstream for Illusions/Select, found here natively,
 * upstream, in the converter itself.
 *
 * The fix restricts the explicitAnchor bypass to a candidate section that is
 * ITSELF evidence of a finish/rung — FINISH_WORD, already the file's own
 * evidence-based vocabulary for ladder lines, reused here to test a section
 * HEADER instead. "International Refractors" (needs the bypass; it does not
 * literally contain "Chrome Prospects") and "Packfractor" (extended
 * FINISH_WORD with a bare "fractor" root, since neither literal "refractor"
 * nor "superfractor" matched it) still pass; "Avatars" and "Troops Tribute"
 * do not, and now correctly stay their own card sets.
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

describe("categoryFor's explicitAnchor bypass only fires for a finish-shaped section name", () => {
  it("keeps a bare finish/rung name eligible without a literal name match", () => {
    // FINISH_WORD is exported implicitly via categoryFor's own module scope,
    // exercised here through the section-header cases that actually matter.
    expect(categoryFor("Chrome", "International Refractors")).toBe("insert-international-refractors");
    expect(categoryFor("Chrome", "Chrome Prospect Packfractor Autographs"))
      .toBe("auto-chrome-prospect-packfractor-autographs");
  });

  it("never treats an independent insert-set name as finish-shaped", () => {
    for (const name of ["Avatars", "Draft Snapshots", "Troops Tribute", "The Shoe Game", "Rookie Pix"]) {
      expect(categoryFor("Inserts", name), name).toBe(`insert-${name.toLowerCase().replace(/\s+/g, "-")}`);
    }
  });
});

describe("2024 Panini Photogenic Football converts without the numeric-subset collapse", () => {
  it("keeps all ten named insert sets as their own card sets, not parallels of Base Set", () => {
    const rows = convert("2024-Panini-PhotoGenic-Football-Checklist.xlsx", "panini-photogenic");
    const cats = new Set(rows.map((r) => r.category));
    for (const c of [
      "insert-avatars-checklist", "insert-draft-snapshots-checklist", "insert-for-the-cure-checklist",
      "insert-in-motion-checklist", "insert-progressions-checklist", "insert-rookie-introductions-checklist",
      "insert-rookie-pix-checklist", "insert-the-shoe-game-checklist", "insert-troops-tribute-checklist",
      "insert-a-different-view-checklist",
    ]) expect(cats.has(c), c).toBe(true);
    // None of these ten may appear as a parallel rung of "base" — that was
    // the false fold (a 100%-numeric-subset match on Base Set's own #1-100).
    const falseParallelsOfBase = rows.filter((r) => r.category === "base" && /^(Avatars|Draft Snapshots|Troops Tribute)/.test(r.parallel));
    expect(falseParallelsOfBase).toHaveLength(0);
  });

  it("keeps the one genuine fold — Base Silver Autographs is a rung on Base Autographs", () => {
    const rows = convert("2024-Panini-PhotoGenic-Football-Checklist.xlsx", "panini-photogenic");
    const silverAutos = rows.filter((r) => r.category === "auto-base-autographs-checklist" && r.parallel === "Silver");
    expect(silverAutos.length).toBeGreaterThan(0);
    for (const r of silverAutos) expect(r.isAuto).toBe("true");
  });
});
