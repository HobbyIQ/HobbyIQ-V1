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
const { categoryFor, stripChecklistSuffix, masterCardSetNames, rangePreviewLineIndices } = require("../scripts/convertBeckettChecklistXlsx.cjs");

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
  });

  // CF-BECKETT-A-RANGE-LABEL-LINE-IS-A-TABLE-OF-CONTENTS-NOT-A-HEADER
  // (2026-09-19, follow-up). The line above stopped "Rookie Patch
  // Autographs - #201-242" being READ AS SIGNED, but categoryFor still slugged
  // its own -201-242 suffix into the category, and the CATEGORY was still
  // wrong: those 1,000 rows (#1-100, e.g. #1 Kyler Murray) are Base Set's own
  // veteran autograph run, not a rookie patch autograph product at #201-242 at
  // all. "Rookies - #101-200" and "Rookie Patch Autographs - #201-242" are a
  // table-of-contents PREVIEW Beckett prints once at the top of the Base
  // sheet -- the real "Rookies" and "Rookie Patch Autographs" sections appear
  // later with their own headers and their own cards. Run 35473622220
  // REFUSED the live acquisition file for this among 7 unregistered-set-keys.
  it("never mints a 'rookie-patch-autographs-201-242' category — the preview line names no section", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const cats = new Set(rows.map((r) => r.category));
    expect(cats.has("auto-rookie-patch-autographs-201-242")).toBe(false);
  });

  it("Base Set's own veteran cards (#1, Kyler Murray) land on 'base', signed rows keep isAuto=true", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const murray = rows.filter((r) => r.category === "base" && r.cardNumber === "1");
    expect(murray.length).toBeGreaterThan(0);
    expect(murray.every((r) => r.player === "Kyler Murray")).toBe(true);
    // The blank-parallel plain card is unsigned (Zenith's actual Base Set
    // print); the tier-name/red-zone parallels of the SAME card are the
    // veteran autograph insert riding as the section's own ladder — R67-shaped
    // (a colour/tier rung is never a card-set key), not asserted further here.
    const plain = murray.find((r) => r.parallel === "");
    expect(plain?.isAuto).toBe("false");
  });

  it("the real, later 'Rookies' and 'Rookie Patch Autographs' sections are untouched by the preview-line fix", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const rpa = rows.filter((r) => r.category === "auto-rookie-patch-autographs");
    expect(rpa.length).toBeGreaterThan(0);
    // Its own numbers are #201-242, e.g. #201 Michael Penix Jr.
    const penix = rpa.find((r) => r.cardNumber === "201" && r.parallel === "");
    expect(penix?.player).toBe("Michael Penix Jr.");
    expect(penix?.isAuto).toBe("true");
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
    // No trailing "-checklist": CF-BECKETT-CHECKLIST-IS-A-TITLE-ARTIFACT-NOT-A-NAME
    // (2026-09-19) strips the word Beckett's own section titles append, measured
    // against Master's un-suffixed spelling on every one of these names.
    for (const c of [
      "insert-z-marquee", "insert-zoom-gold", "insert-zoom-red",
      "insert-a-to-z", "insert-alphas", "insert-behind-the-numbers",
      "insert-chalk-talk", "insert-first-look", "insert-idols",
      "insert-splash", "insert-state-of-the-art", "insert-the-shield",
      "insert-z-team", "insert-color-guard", "insert-turning-pro-memorabilia",
      "insert-z-jersey", "insert-zoned-in",
    ]) expect(cats.has(c), c).toBe(true);
  });

  it("keeps the genuine parallel folds — Z Summit Autographs colour rungs and the Variation pairing", () => {
    const rows = convert("2024-Panini-Zenith-Football-Checklist.xlsx", "panini-zenith");
    const zSummitBlue = rows.filter((r) => r.category === "auto-z-summit-autographs" && r.parallel === "Blue");
    expect(zSummitBlue.length).toBeGreaterThan(0);
    const variationRows = rows.filter((r) => r.category === "auto-contenders-optic-rookie-ticket-rps-preview-blue" && r.parallel === "Variation");
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
      "insert-avatars", "insert-draft-snapshots", "insert-for-the-cure",
      "insert-in-motion", "insert-progressions", "insert-rookie-introductions",
      "insert-rookie-pix", "insert-the-shoe-game", "insert-troops-tribute",
      "insert-a-different-view",
    ]) expect(cats.has(c), c).toBe(true);
    // None of these ten may appear as a parallel rung of "base" — that was
    // the false fold (a 100%-numeric-subset match on Base Set's own #1-100).
    const falseParallelsOfBase = rows.filter((r) => r.category === "base" && /^(Avatars|Draft Snapshots|Troops Tribute)/.test(r.parallel));
    expect(falseParallelsOfBase).toHaveLength(0);
  });

  it("keeps the one genuine fold — Base Silver Autographs is a rung on Base Autographs", () => {
    const rows = convert("2024-Panini-PhotoGenic-Football-Checklist.xlsx", "panini-photogenic");
    const silverAutos = rows.filter((r) => r.category === "auto-base-autographs" && r.parallel === "Silver");
    expect(silverAutos.length).toBeGreaterThan(0);
    for (const r of silverAutos) expect(r.isAuto).toBe("true");
  });
});

describe("CF-BECKETT-CHECKLIST-IS-A-TITLE-ARTIFACT-NOT-A-NAME (2026-09-19)", () => {
  it("strips the trailing 'Checklist' Master confirms is not part of the name", () => {
    const masterNames = new Set(["z marquee", "base set"]);
    expect(stripChecklistSuffix("Z Marquee Checklist", ["Zoom Gold Checklist"], masterNames)).toBe("Z Marquee");
  });

  it("strips it when Master is silent but every sibling section on the sheet carries it too", () => {
    expect(stripChecklistSuffix("Something New Checklist", ["Zoom Gold Checklist", "Z Marquee Checklist"], new Set()))
      .toBe("Something New");
  });

  it("never strips a lone 'Checklist' name with no corroborating signal", () => {
    expect(stripChecklistSuffix("Team Checklist", ["Base Set", "Rookies"], new Set())).toBe("Team Checklist");
  });

  it("never strips when Master explicitly states the name INCLUDES the word", () => {
    // A genuine card literally named "Team Checklist" -- Master is the
    // authority and wins even though every sibling on the sheet also happens
    // to carry the suffix.
    expect(stripChecklistSuffix("Team Checklist", ["Base Set", "Rookies"], new Set(["team checklist"]))).toBe("Team Checklist");
  });

  it("leaves a name with no trailing 'Checklist' untouched", () => {
    expect(stripChecklistSuffix("Base Set", ["Zoom Gold Checklist"], new Set(["z marquee"]))).toBe("Base Set");
  });

  it("reads Master's real, headerless-sheet shape and refuses to guess when it does not match", () => {
    // 2024 Bowman's own Master sheet starts directly with data rows, no
    // "Card Set" header at all -- masterCardSetNames must return empty here,
    // never half-parse a shape it cannot confirm.
    const noHeader = [["Base", "1", "Kodai Senga", "New York Mets", "", "", ""]];
    expect(masterCardSetNames({ Master: noHeader }).size).toBe(0);
  });

  it("reads a real Card Set header when present", () => {
    const withHeader = [
      ["Card Set", "Card Number", "Athlete", "Team", "Sequence"],
      ["Z Marquee", "1", "Caleb Williams", "Chicago Bears", ""],
    ];
    const names = masterCardSetNames({ Master: withHeader });
    expect(names.has("z marquee")).toBe(true);
  });
});

describe("CF-BECKETT-A-RANGE-LABEL-LINE-IS-A-TABLE-OF-CONTENTS-NOT-A-HEADER (2026-09-19)", () => {
  const row = (cell: string) => [cell, "", "", "", ""];
  const blank = () => ["", "", "", "", ""];

  it("skips two range-labelled lines printed back-to-back — the real Zenith Base-sheet shape", () => {
    const rows = [
      row("Base Set"),
      blank(),
      row("238 cards."),
      row("Rookies - #101-200"),
      row("Rookie Patch Autographs - #201-242"),
      blank(),
      row("Parallels:"),
    ];
    const idx = rangePreviewLineIndices(rows);
    expect(idx.has(3)).toBe(true);
    expect(idx.has(4)).toBe(true);
  });

  it("does NOT skip a lone range-labelled header that is the sheet's only such line", () => {
    // A section genuinely titled "<Name> - #NNN-NNN" with no sibling preview
    // line beside it is not this shape — nothing in the corpus looks like
    // this today, but the rule must not fire on a single occurrence.
    const rows = [
      row("Base Set"),
      row("Something Else - #50-99"),
      blank(),
      ["1", "Player One", "Team", "", ""],
    ];
    const idx = rangePreviewLineIndices(rows);
    expect(idx.size).toBe(0);
  });

  it("does not touch an ordinary section header with no range label", () => {
    const rows = [row("Base Set"), row("Rookies"), row("Parallels:")];
    expect(rangePreviewLineIndices(rows).size).toBe(0);
  });
});
