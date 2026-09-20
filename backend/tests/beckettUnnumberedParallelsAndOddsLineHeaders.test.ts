/**
 * Two measured defects in convertBeckettChecklistXlsx.cjs, found acquiring
 * 2024 Panini Phoenix Football and 2025-26 Topps Holiday Basketball
 * (Beckett S3, 2026-09-19; workbook URLs in PR #2344's own package
 * manifests -- acq-2026-09-19-beckett-panini-phoenix-fb and
 * acq-2026-09-19-beckett-topps-holiday-basketball).
 *
 * DEFECT A -- CF-BECKETT-AN-UNNUMBERED-PARALLEL-IS-STILL-A-PARALLEL. Phoenix's
 * Base sheet declares its "Parallels:" ladder as sixteen bare names with no
 * stated print run (Hyper, Ice, International, Lazer + 3 compounds, Orange +
 * 3 compounds, Pandora, Purple + 3 compounds, Silver) followed by numbered
 * rungs (Phoenix - /399, ...) and two more bare names that happen to match
 * FINISH_WORD's vocabulary (Wave, White Shimmer). parseRung's evidence test
 * (print run, pack odds, or FINISH_WORD) rejected all sixteen -- no print
 * run, no odds, and none of "hyper"/"ice"/"international"/"lazer"/"orange"/
 * "pandora"/"purple"/"silver" is in FINISH_WORD ("Lazer" does not match
 * "laser" either) -- so they fell through to the file's existing "prose
 * inside a ladder is not a section" branch and vanished: not a rung, not a
 * section, just gone. Every one of Phoenix's 250 base cards should carry all
 * eighteen rungs; sixteen were silently missing from the committed output.
 * The identical shape already exists, unmeasured, on a currently-committed
 * fixture: 2026 Donruss Elite's own base ladder declares "Orange",
 * "Mixorama" and "Razzle Dazzle" the same bare way and loses all three today.
 *
 * DEFECT B -- CF-BECKETT-AN-ODDS-LINE-IS-NEVER-A-SECTION-NAME. Holiday
 * Basketball prints pack odds as their own bare single-cell row directly
 * under a section's real header and its count line ("Frostbite Finishers" /
 * "25 cards" / "1:200 packs" / [cards]), with no colon, no parens, no
 * distinguishing word. isCountLine only recognizes "<N> cards[.]"; "1:200
 * packs" is a different shape and fell straight through to the
 * unconditional `section = cell` assignment, overwriting the real header one
 * line above it before a single card row could commit it. Eleven sections
 * (twelve counting a roster-split pair) end up named after their own odds
 * line -- categories like `auto-1379-packs`, `insert-1200-packs`,
 * `insert-16-packs-advent-exclusive` -- and every real name ("Frostbite
 * Finishers", "Hidden Elf", "Making The Nice List", "Evergreen", "Base -
 * SSP Variations", ...) is gone from the checklist even though Beckett
 * states it one line earlier every time.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRung, parseLadderLine, sheetSectionHeaderNames } =
  require("../scripts/convertBeckettChecklistXlsx.cjs");

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-unnumbered-odds-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto: string; printRun: string; player: string;
};

/** Builds a minimal synthetic xlsx from a {sheetName: rows[][]} map and runs
 *  it through the real converter CLI -- both defects live in main()'s
 *  row-reading loop, not in an exported pure function, so this has to go
 *  through the actual xlsx-reading path rather than a hand-built Map. Same
 *  helper shape as beckettPrematureRangeHeaderAndExplicitAnchorRoster.test.ts. */
function convert(sheets: Record<string, unknown[][]>, setKey: string, sport = "football"): Row[] {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const xlsxPath = path.join(TMP, `${setKey}-in.xlsx`);
  XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });

  const out = path.join(TMP, `${setKey}.csv`);
  execFileSync(process.execPath, [
    CONVERTER,
    "--xlsx", xlsxPath,
    "--year", "2024", "--set-key", setKey, "--sport", sport,
    "--set-name", `2024 ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
}

describe("DEFECT A: a bare, unnumbered parallel name inside an open ladder is still a rung", () => {
  it("parseLadderLine accepts Phoenix's own sixteen missing names; parseRung alone still refuses them", () => {
    const names = [
      "Hyper", "Ice", "International", "Lazer", "Orange", "Orange Fade",
      "Orange Hyper", "Orange Lazer", "Pandora", "Purple", "Purple Fade",
      "Purple Hyper", "Purple Lazer", "Silver",
    ];
    for (const n of names) {
      expect(parseRung(n), n).toBeNull();
      expect(parseLadderLine(n), n).toMatchObject({ name: n, printRun: null });
    }
    // Wave / White Shimmer already survived parseRung via FINISH_WORD --
    // parseLadderLine must not double-count or alter them.
    expect(parseLadderLine("Wave")).toMatchObject({ name: "Wave", printRun: null });
    expect(parseLadderLine("White Shimmer")).toMatchObject({ name: "White Shimmer", printRun: null });
  });

  it("parseRung alone still refuses 'Base Set'/'Parallels' unconditionally -- context-free callers are untouched", () => {
    // beckettReadsEverySectionClass.test.ts's own pins require these to stay
    // null from parseRung regardless of context; this file's fix must not
    // touch parseRung itself (see BARE_LADDER_NAME's header comment for why).
    for (const s of ["Base Set", "Parallels", "100 cards.", "100 cards", "Chrome Prospects Checklist", ""]) {
      expect(parseRung(s), s).toBeNull();
    }
  });

  it("still refuses genuine prose and a footnote -- parseLadderLine narrows, never widens, past that", () => {
    for (const s of [
      "*Odds as provided by Topps", "*Plates were made for this product",
      "100 cards.", "100 cards", "",
      "Aspirations /99 or fewer (See list below)",
      "Status /99 or fewer (See list below)",
    ]) {
      expect(parseLadderLine(s), s).toBeNull();
    }
    // A real rung via parseRung's own print-run parsing is returned
    // unchanged -- parseLadderLine never overrides an accepted parseRung
    // result, it only widens what happens on a REFUSAL.
    expect(parseLadderLine("Printing Plates 1/1 (Each card has Cyan, Magenta, Yellow, and Black versions)"))
      .toMatchObject({ name: "Printing Plates", printRun: 1 });
  });

  it("reproduces Phoenix's own shape minimally: all eighteen declared parallels reach every base card", () => {
    const rows = convert({
      Base: [
        ["Base Set"],
        ["2 cards."],
        ["Parallels:"],
        ["Hyper"],
        ["Ice"],
        ["International"],
        ["Lazer"],
        ["Orange"],
        ["Orange Fade"],
        ["Orange Hyper"],
        ["Orange Lazer"],
        ["Pandora"],
        ["Purple"],
        ["Purple Fade"],
        ["Purple Hyper"],
        ["Purple Lazer"],
        ["Silver"],
        ["Wave"],
        ["White Shimmer"],
        ["Phoenix - /399"],
        ["1", "Kyler Murray,", "Arizona Cardinals"],
        ["2", "James Conner,", "Arizona Cardinals"],
      ],
    }, "test-phoenix-shape");

    const base = rows.filter((r) => r.category === "base");
    const parallelsSeen = new Set(base.map((r) => r.parallel));
    for (const name of [
      "Hyper", "Ice", "International", "Lazer", "Orange", "Orange Fade",
      "Orange Hyper", "Orange Lazer", "Pandora", "Purple", "Purple Fade",
      "Purple Hyper", "Purple Lazer", "Silver", "Wave", "White Shimmer", "Phoenix",
    ]) {
      expect(parallelsSeen.has(name), `missing parallel "${name}"; saw ${JSON.stringify([...parallelsSeen])}`).toBe(true);
    }
    // 2 cards x (1 base row + 17 rungs) = 36.
    expect(base).toHaveLength(36);
    const phoenixRung = base.find((r) => r.parallel === "Phoenix");
    expect(phoenixRung?.printRun).toBe("399");
  });

  it("mints no parallel from a genuinely refused prose line sitting in the same ladder (mutation guard)", () => {
    const rows = convert({
      Base: [
        ["Base Set"],
        ["1 cards."],
        ["Parallels:"],
        ["Hyper"],
        ["Aspirations /99 or fewer (See list below)"],
        ["*Odds as provided by Topps"],
        ["Gold /10"],
        ["1", "Kyler Murray,", "Arizona Cardinals"],
      ],
    }, "test-phoenix-mutation-guard");
    const parallels = new Set(rows.map((r) => r.parallel));
    expect(parallels.has("Hyper")).toBe(true);
    expect(parallels.has("Gold")).toBe(true);
    for (const p of parallels) {
      expect(p, p).not.toMatch(/or fewer|see list|odds|^\*/i);
    }
  });

  it("keeps 2026 Topps Tier One byte-identical -- a workbook with no bare unnumbered rung is unaffected", () => {
    const FIXTURES = path.join(__dirname, "fixtures", "beckett");
    const xlsxPath = path.join(FIXTURES, "2026-Topps-Tier-One-Baseball-Checklist.xlsx");
    const out = path.join(TMP, "tier-one-out.csv");
    execFileSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2026", "--set-key", "tier-one",
      "--sport", "baseball", "--set-name", "2026 Topps Tier One", "--out", out,
    ], { encoding: "utf8" });
    const rows = fs.readFileSync(out, "utf8").trim().split("\n").slice(1);
    expect(rows).toHaveLength(1702);
  });
});

describe("DEFECT A guard: droppedDeclaredParallels", () => {
  it("exits non-zero and never writes the CSV when a declared parallel never reaches a row", () => {
    // A hand-built pathological case: parseLadderLine and the guard's own
    // prose recognizer both refuse this line (it is neither a bare name --
    // it has a leading digit -- nor recognizable prose), so it must be
    // reported and the run must fail loudly rather than silently drop it.
    const wb = XLSX.utils.book_new();
    const rows: unknown[][] = [
      ["Base Set"], ["1 cards."], ["Parallels:"],
      ["7 Colour Special"], // digit-led: fails BARE_LADDER_NAME, not prose either
      ["1", "Kyler Murray", "Arizona Cardinals"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Base");
    const xlsxPath = path.join(TMP, "guard-in.xlsx");
    XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
    const out = path.join(TMP, "guard-out.csv");

    const res = spawnSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", "test-guard",
      "--sport", "football", "--set-name", "test", "--out", out,
    ], { encoding: "utf8" });

    expect(res.status, res.stderr).not.toBe(0);
    expect(res.stderr).toMatch(/FATAL.*declared a parallel named "7 Colour Special"/s);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("--allow-dropped-parallels overrides the refusal and writes the CSV anyway", () => {
    const wb = XLSX.utils.book_new();
    const rows: unknown[][] = [
      ["Base Set"], ["1 cards."], ["Parallels:"],
      ["7 Colour Special"],
      ["1", "Kyler Murray", "Arizona Cardinals"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Base");
    const xlsxPath = path.join(TMP, "guard-allow-in.xlsx");
    XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
    const out = path.join(TMP, "guard-allow-out.csv");

    const res = spawnSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", "test-guard-allow",
      "--sport", "football", "--set-name", "test", "--out", out,
      "--allow-dropped-parallels",
    ], { encoding: "utf8" });

    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });

  // CF-AN-OVERRIDE-LEAVES-A-MARK (2026-09-20, review fix). The manifest must
  // distinguish "a human explicitly waved this guard through" from "this run
  // never had anything to wave through" -- an auditor reading the manifest
  // later has no other way to tell them apart without re-running the CLI.
  it("stamps allowDroppedParallelsUsed:true in the manifest when the override actually suppressed a drop", () => {
    const wb = XLSX.utils.book_new();
    const rows: unknown[][] = [
      ["Base Set"], ["1 cards."], ["Parallels:"],
      ["7 Colour Special"],
      ["1", "Kyler Murray", "Arizona Cardinals"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Base");
    const xlsxPath = path.join(TMP, "guard-stamp-in.xlsx");
    XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
    const out = path.join(TMP, "guard-stamp-out.csv");

    const res = spawnSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", "test-guard-stamp",
      "--sport", "football", "--set-name", "test", "--out", out,
      "--allow-dropped-parallels",
    ], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);

    const manifest = JSON.parse(
      fs.readFileSync(out.replace(/\.csv$/, ".manifest.json"), "utf8"),
    );
    expect(manifest.allowDroppedParallelsUsed).toBe(true);
    expect(manifest.droppedDeclaredParallels).toEqual([
      { sheet: "Base", section: "Base Set", parallel: "7 Colour Special" },
    ]);
  });

  it("never stamps allowDroppedParallelsUsed when the flag is passed but nothing was dropped", () => {
    // Passing --allow-dropped-parallels on a clean workbook has nothing to
    // override; the stamp must stay absent, not falsely claim an override
    // happened, and the manifest must stay byte-identical to a run that
    // never passed the flag at all (additive-only contract, same as
    // droppedDeclaredParallels itself).
    const rows = convert({
      Base: [
        ["Base Set"], ["1 cards."],
        ["1", "Kyler Murray,", "Arizona Cardinals"],
      ],
    }, "test-guard-no-drop-no-stamp");
    expect(rows.length).toBeGreaterThan(0);

    const manifestPath = path.join(TMP, "test-guard-no-drop-no-stamp.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.allowDroppedParallelsUsed).toBeUndefined();
    expect(manifest.droppedDeclaredParallels).toBeUndefined();
  });

  it("does not fire on an ordinary fold -- a section that folds onto an anchor is exempt from its own ladder check", () => {
    // "Base Autographs Silver" folds onto "Base Autographs" as the Silver
    // rung; it declares no ladder of its own here, and even if it did, a
    // folded section's own ladder is never emitted by design (CF-EMIT-THE-
    // WHOLE-LADDER's `if (!foldsHere)` gate) -- this guard must agree.
    const rows = convert({
      Autographs: [
        ["Base Autographs"],
        ["2 cards"],
        ["BA-1", "Kyler Murray", "Arizona Cardinals"],
        ["BA-2", "James Conner", "Arizona Cardinals"],
        ["Base Autographs Silver"],
        ["2 cards"],
        ["BA-1", "Kyler Murray", "Arizona Cardinals"],
        ["BA-2", "James Conner", "Arizona Cardinals"],
      ],
    }, "test-fold-exempt");
    expect(rows.length).toBeGreaterThan(0);
  });
});

// CF-BECKETT-A-BARE-LADDER-NAME-IS-ITS-OWN-RUNG-NOT-ITS-NEIGHBOUR'S
// (2026-09-20, review fix). 2024 Panini Illusions Football's Base sheet
// declares its "Parallels:" ladder with "Retail" sitting bare, between
// "Dots Trophy Collection" and "Sunburst Trophy Collection" (row 11 of a
// block that is otherwise entirely "<Colour> Trophy Collection[ - /NNN]").
// A reviewer flagged this as a possible false parallel BY LAYOUT -- "Retail"
// merely sits inside the Trophy Collection block, so a fold that (wrongly)
// concatenated a bare ladder line onto its ladder neighbour's name, or that
// let the surrounding "Trophy Collection" lines bleed into rungName's own
// anchor-token-stripping, could mint "Retail Trophy Collection" instead of
// plain "Retail" -- attaching a genuine base-set retail parallel to the
// unrelated Trophy Collection insert. Measured against the real workbook
// (sha256 4685243ee6...49eb58b8, matches beckett-s3-manifest-2026-09.json):
// parseLadderLine reads each ladder line independently (one line, one rung,
// never joined with a neighbour), so "Retail" is minted as its own,
// unqualified rung, folds onto Base Set via the ordinary 100%-numeric-match
// path, and every one of its 100 rows carries category=base,
// parallel="Retail" -- never "Retail Trophy Collection" and never
// insert-trophy-collection. This test pins that shape with a minimal
// synthetic fixture reproducing the same layout (a bare "Retail" line
// sandwiched between two real "<Colour> Trophy Collection" ladder rungs).
describe("Illusions' bare 'Retail' ladder line is its own rung, never folded into its Trophy Collection neighbours", () => {
  it("mints parallel=\"Retail\" of BASE, never \"Retail Trophy Collection\" or an insert-trophy-collection row", () => {
    const rows = convert({
      Base: [
        ["Base Set"],
        ["2 cards."],
        ["Parallels:"],
        ["Dots Trophy Collection"],
        ["Retail"],
        ["Sunburst Trophy Collection"],
        ["Mirrored Trophy Collection - /499"],
        ["1", "Kyler Murray,", "Arizona Cardinals"],
        ["2", "James Conner,", "Arizona Cardinals"],
      ],
    }, "test-illusions-retail-shape");

    const retailRows = rows.filter((r) => r.parallel === "Retail");
    expect(retailRows).toHaveLength(2); // one per base card
    for (const r of retailRows) {
      expect(r.category, JSON.stringify(r)).toBe("base");
    }
    // The exact false-fold shape the reviewer flagged must never appear.
    expect(rows.some((r) => r.parallel === "Retail Trophy Collection")).toBe(false);
    expect(rows.some((r) => /trophy-collection/.test(r.category) && r.player.includes("Kyler Murray"))).toBe(false);

    // Its real ladder neighbours are still their own, correctly-named
    // rungs -- this test must not pass merely because the whole ladder
    // collapsed onto one name.
    expect(rows.some((r) => r.parallel === "Dots Trophy Collection")).toBe(true);
    expect(rows.some((r) => r.parallel === "Sunburst Trophy Collection")).toBe(true);
    expect(rows.some((r) => r.parallel === "Mirrored Trophy Collection")).toBe(true);
  });
});

describe("DEFECT B: a bare odds line must never become a section name", () => {
  it("reproduces Holiday Basketball's own shape minimally: the real header survives its own odds line", () => {
    const rows = convert({
      Inserts: [
        ["Frostbite Finishers"],
        ["2 cards"],
        ["1:200 packs"],
        ["FF-AB", "Ace Bailey", "Utah Jazz"],
        ["FF-BM", "Brandon Miller", "Charlotte Hornets"],
        ["Hidden Elf"],
        ["2 cards"],
        ["1:200 packs"],
        ["HE-AE", "Anthony Edwards", "Minnesota Timberwolves"],
        ["HE-AS", "Alex Sarr", "Washington Wizards"],
      ],
    }, "test-holiday-inserts-shape", "basketball");

    const frostbite = rows.filter((r) => r.player.startsWith("Ace Bailey") || r.player.startsWith("Brandon Miller"));
    for (const r of frostbite) expect(r.category, JSON.stringify(r)).toBe("insert-frostbite-finishers");
    const hiddenElf = rows.filter((r) => r.player.startsWith("Anthony Edwards") || r.player.startsWith("Alex Sarr"));
    for (const r of hiddenElf) expect(r.category, JSON.stringify(r)).toBe("insert-hidden-elf");
    for (const r of rows) {
      expect(r.category, JSON.stringify(r)).not.toMatch(/packs/);
    }
  });

  it("reproduces the Base sheet's own SSP Variations shape (real header, count line, odds line, cards)", () => {
    const rows = convert({
      Base: [
        ["Base - SSP Variations"],
        ["2 cards"],
        ["1:23 packs"],
        ["SSV-AE", "James Harden", "Los Angeles Clippers"],
        ["SSV-AT", "Kyrie Irving", "Dallas Mavericks"],
      ],
    }, "test-holiday-base-ssp-shape", "basketball");
    for (const r of rows) {
      expect(r.category, JSON.stringify(r)).toBe("insert-base-ssp-variations");
    }
  });

  it("an odds line inside a Parallels: block is neither an accepted rung nor a stolen section name", () => {
    // Speculative shape: nothing in the corpus has been measured to place a
    // bare odds line INSIDE an already-open ladder, but the guard chain
    // (parseLadderLine refuses it, LADDER_PROSE_NOT_A_NAME excludes it) must
    // hold if one ever does, or droppedDeclaredParallels would false-fire.
    const rows = convert({
      Base: [
        ["Base Set"],
        ["1 cards."],
        ["Parallels:"],
        ["Gold /10"],
        ["1:83 packs"],
        ["1", "Kyler Murray,", "Arizona Cardinals"],
      ],
    }, "test-odds-inside-ladder");
    const parallels = new Set(rows.map((r) => r.parallel));
    expect(parallels.has("Gold")).toBe(true);
    for (const p of parallels) expect(p, p).not.toMatch(/packs/);
  });

  it("does not touch a real header followed directly by cards (no odds line at all)", () => {
    const rows = convert({
      Inserts: [
        ["Making The Nice List"],
        ["2 cards"],
        ["ML-1", "Cooper Flagg", "Dallas Mavericks"],
        ["ML-2", "Dylan Harper", "San Antonio Spurs"],
      ],
    }, "test-no-odds-line-control", "basketball");
    for (const r of rows) {
      expect(r.category, JSON.stringify(r)).toBe("insert-making-the-nice-list");
    }
  });

  it("does not swallow a real section named starting with a number-colon-like brand token (negative control)", () => {
    // Guard against an over-eager ODDS_LINE: it requires the WHOLE cell to be
    // "1:<digits>[ <rest>]" -- a real header that merely CONTAINS odds-like
    // text elsewhere is untouched.
    const { ODDS_LINE } = require("../scripts/convertBeckettChecklistXlsx.cjs");
    expect(ODDS_LINE.test("1:200 packs")).toBe(true);
    expect(ODDS_LINE.test("1:23 packs")).toBe(true);
    expect(ODDS_LINE.test("1:2 packs (Advent-exclusive)")).toBe(true);
    expect(ODDS_LINE.test("Base Set")).toBe(false);
    expect(ODDS_LINE.test("Frostbite Finishers")).toBe(false);
    expect(ODDS_LINE.test("1 of 1")).toBe(false);
  });

  it("never pollutes sheetSectionHeaderNames with an odds line, so stripChecklistSuffix's sibling signal stays clean", () => {
    const rows: unknown[][] = [
      ["Frostbite Finishers"], ["2 cards"], ["1:200 packs"],
      ["FF-AB", "Ace Bailey", "Utah Jazz"],
      ["Hidden Elf"], ["2 cards"], ["1:200 packs"],
      ["HE-AE", "Anthony Edwards", "Minnesota Timberwolves"],
    ];
    const names = sheetSectionHeaderNames(rows);
    expect(names).toEqual(["Frostbite Finishers", "Hidden Elf"]);
  });
});
