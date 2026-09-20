/**
 * Two measured defects in convertBeckettChecklistXlsx.cjs, same acquisition
 * lane as beckettBaseSheetIsNotOneSection.test.ts (2024 Panini Illusions
 * Football, 2024 Panini Select Football; Beckett S3, 2026-09-19).
 *
 * DEFECT 1 -- CF-BECKETT-A-STATED-RANGE-HEADER-MUST-MATCH-ITS-OWN-CARDS.
 * 2024 Panini Illusions Football's Base sheet lists TWO section headers
 * back-to-back, with no card row between them:
 *
 *     Base Set
 *     136 cards.
 *     First Impressions Autographed Memorabilia - #101-142   <- premature
 *     Parallels:
 *     ... (11 rungs) ...
 *     1   Kyler Murray          <- these are BASE SET's cards, #1-100
 *     ...
 *     100 J.J. McCarthy
 *     First Impressions Autographed Memorabilia   <- same section, for real
 *     Parallels:
 *     ...
 *     101 Michael Penix Jr.     <- NOW the autographed run's own cards
 *
 * The single section-tracker variable overwrote "Base Set" the moment the
 * second header was read, so main()'s pass 1 filed all 100 plain base cards
 * under the autograph section -- isAuto=true on 100 unsigned cards.
 *
 * A general "a header only counts once the current section has cards" rule
 * was tried first and broke five already-measured-clean committed workbooks
 * (2025 Bowman, 2025 Bowman Chrome, 2024 Panini Donruss, 2025 Topps Chrome,
 * 2023 Topps Chrome Platinum, 2026 Topps Series 1) whose OWN two-headers-
 * with-no-cards-between shape resolves the OPPOSITE way (the SECOND header,
 * not the first, owns the cards that follow -- "Hobby Exclusive" on 2026
 * Topps Series 1 is the identical row shape to Illusions's own defect, and
 * there the second header is correct). Shape alone cannot decide it.
 *
 * The fix is narrower and evidence-based: "First Impressions Autographed
 * Memorabilia - #101-142" states its own numbering range in its own text,
 * and the very next card is #1 -- outside that stated range, proof the
 * header does not own it. A header with no stated range ("Hobby Exclusive")
 * is untouched by this check and commits immediately, exactly as before.
 *
 * DEFECT 2 -- CF-BECKETT-THE-ROSTER-DECIDES-THE-EXPLICIT-ANCHOR-FOLD-TOO.
 * classifySections's explicitAnchor+FINISH_WORD bypass (added for a genuine
 * rung like "International Refractors", whose header extends no anchor
 * name) fires whenever a CANDIDATE section's own name merely CONTAINS a
 * finish word ("Prizm"). 2024 Panini Select Football's Memorabilia sheet
 * lists four independently NAMED, already-registered insert products whose
 * titles happen to include "Prizm" and whose own numbering (#1-25, #1-42,
 * #1-25, #1-58) is a 100% numeric subset of Base>Base Concourse's #1-100 --
 * so the bypass folded all four onto Base Concourse as fabricated parallel
 * names, although the rosters disagree card-for-card (Base Concourse #1 =
 * Tory Taylor; the four sections' own #1 = Caleb Williams / Adonai Mitchell
 * / Caleb Williams / Kurt Warner). rosterFoldAgainst already existed and
 * already reports this disagreement correctly; the bypass simply never
 * consulted it, unlike the roster-fold-for-nameless-sections pass elsewhere
 * in the same function. Doctrine: the roster decides -- a colour/finish rung
 * is a parallel only when it reprints its anchor's own roster.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifySections, normalizeRosterPlayer, countDataLookingRows, categoryFor } = require("../scripts/convertBeckettChecklistXlsx.cjs");

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-range-roster-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto: string; printRun: string; player: string;
};

/** Builds a minimal synthetic xlsx from a {sheetName: rows[][]} map (each row
 *  an array-of-cells, exactly what XLSX.utils.aoa_to_sheet expects) and runs
 *  it through the real converter CLI -- the bug under test lives in main()'s
 *  row-reading loop, not in an exported pure function, so this has to go
 *  through the actual xlsx-reading path rather than a hand-built Map. */
function convert(sheets: Record<string, unknown[][]>, setKey: string): Row[] {
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
    "--year", "2024", "--set-key", setKey, "--sport", "football",
    "--set-name", `2024 ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
}

describe("DEFECT 1: a header stating its own numbering range must match the cards that follow it", () => {
  it("reproduces Illusions's own shape minimally: Base Set's cards must not be stolen by a premature auto-section header", () => {
    const rows = convert({
      Base: [
        ["Base Set"],
        ["4 cards."],
        ["First Impressions Autographed Memorabilia - #101-142"],
        ["Parallels:"],
        ["Red - /199"],
        ["1", "Kyler Murray", "Arizona Cardinals"],
        ["2", "James Conner", "Arizona Cardinals"],
        ["First Impressions Autographed Memorabilia"],
        ["Parallels:"],
        ["Blue - /99"],
        ["101", "Michael Penix Jr.", "Atlanta Falcons"],
        ["102", "J.J. McCarthy", "Minnesota Vikings"],
      ],
    }, "test-illusions-shape");

    const base = rows.filter((r) => r.cardNumber === "1" || r.cardNumber === "2");
    for (const r of base) {
      expect(r.category, JSON.stringify(r)).toBe("base");
      expect(r.isAuto, JSON.stringify(r)).toBe("false");
    }
    const autos = rows.filter((r) => r.cardNumber === "101" || r.cardNumber === "102");
    for (const r of autos) {
      expect(r.category, JSON.stringify(r)).toBe("auto-first-impressions-autographed-memorabilia");
      expect(r.isAuto, JSON.stringify(r)).toBe("true");
    }
    // The premature header's own ladder (Red - /199) was announced before
    // any of ITS cards, so -- exactly like Illusions's real Trophy
    // Collection ladder -- it belongs to whichever section is genuinely
    // open when it's read (Base Set), never to the auto section whose
    // header merely sat next to it.
    const redRung = rows.filter((r) => r.parallel === "Red");
    expect(redRung.length).toBeGreaterThan(0);
    for (const r of redRung) expect(r.category).toBe("base");
    const blueRung = rows.filter((r) => r.parallel === "Blue");
    expect(blueRung.length).toBeGreaterThan(0);
    for (const r of blueRung) expect(r.category).toBe("auto-first-impressions-autographed-memorabilia");
  });

  it("does not touch a header with no stated range -- the second, correct header still wins on the identical row shape", () => {
    // 2026 Topps Series 1 Baseball's own regression case: "Base - Clear
    // Variation" / "100 cards" / "Hobby Exclusive" / [cards 1-100] -- the
    // SECOND header (no range suffix) is the one whose cards these are.
    const rows = convert({
      Variations: [
        ["Base - Clear Variation"],
        ["2 cards"],
        ["Hobby Exclusive"],
        ["1", "Aaron Judge", "New York Yankees"],
        ["2", "Jonah Tong", "New York Mets"],
      ],
    }, "test-series1-shape");

    for (const r of rows) {
      expect(r.category, JSON.stringify(r)).toBe("insert-hobby-exclusive");
    }
  });

  it("still lets a range-stated header commit normally when its own cards do fall inside the range", () => {
    const rows = convert({
      Base: [
        ["Base Set"],
        ["2 cards."],
        ["1", "Kyler Murray", "Arizona Cardinals"],
        ["2", "James Conner", "Arizona Cardinals"],
        ["Rookie Autographs - #101-102"],
        ["101", "Michael Penix Jr.", "Atlanta Falcons"],
        ["102", "J.J. McCarthy", "Minnesota Vikings"],
      ],
    }, "test-range-header-confirmed");

    const autos = rows.filter((r) => r.cardNumber === "101" || r.cardNumber === "102");
    for (const r of autos) {
      // The stated "- #101-102" range suffix is stripped from the committed
      // name, the same as every other section header -- it decided WHETHER
      // this header applies to these cards, not what the section is called.
      expect(r.category, JSON.stringify(r)).toBe("auto-rookie-autographs");
      expect(r.isAuto, JSON.stringify(r)).toBe("true");
    }
  });
});

describe("DEFECT 2: the explicitAnchor+FINISH_WORD bypass requires the roster to agree", () => {
  type SectionInput = {
    sheet: string; section: string; category: string;
    rows: Array<{ cardNumber: string; player: string }>;
  };

  /** Same shape beckettRosterFoldsNamelessSections.test.ts builds -- the
   *  exact Map<string, SectionDescriptor> main()'s pass 1 hands to
   *  classifySections. */
  function buildSections(inputs: SectionInput[]) {
    const sections = new Map<string, any>();
    for (const inp of inputs) {
      const key = `${inp.sheet}>${inp.section}`;
      const numbers = new Set<string>();
      const roster = new Map<string, Set<string>>();
      for (const r of inp.rows) {
        const num = r.cardNumber.toUpperCase();
        numbers.add(num);
        if (!roster.has(num)) roster.set(num, new Set());
        roster.get(num)!.add(normalizeRosterPlayer(r.player));
      }
      sections.set(key, {
        sheet: inp.sheet, section: inp.section, key,
        category: inp.category, numbers, roster,
        cards: inp.rows.length, ladder: [],
      });
    }
    return sections;
  }

  it("refuses to fold a finish-named section onto an explicitAnchor when the rosters disagree (Select's Draft Selections Memorabilia Prizm shape)", () => {
    const sections = buildSections([
      {
        sheet: "Base", section: "Base Concourse", category: "base",
        rows: [
          { cardNumber: "1", player: "Tory Taylor" },
          { cardNumber: "2", player: "Someone Else" },
        ],
      },
      {
        sheet: "Memorabilia", section: "Draft Selections Memorabilia Prizm",
        category: "insert-draft-selections-memorabilia-prizm",
        rows: [
          { cardNumber: "1", player: "Caleb Williams" },
          { cardNumber: "2", player: "Adonai Mitchell" },
        ],
      },
    ]);
    const report = classifySections(sections);
    const memo = report.find((r: any) => r.section === "Draft Selections Memorabilia Prizm");
    expect(memo.role, JSON.stringify(memo)).not.toBe("parallel");
    expect(memo.role, JSON.stringify(memo)).toMatch(/^own-cards/);
  });

  it("still folds a genuine finish/rung explicitAnchor case when the roster agrees (Bowman Chrome's International Refractors shape)", () => {
    const sections = buildSections([
      {
        sheet: "Chrome", section: "Chrome Prospects", category: "base",
        rows: [
          { cardNumber: "BCP-1", player: "Jackson Holliday" },
          { cardNumber: "BCP-2", player: "Junior Caminero" },
        ],
      },
      {
        sheet: "Chrome", section: "International Refractors",
        category: "insert-international-refractors",
        rows: [
          { cardNumber: "BCP-1", player: "Jackson Holliday" },
          { cardNumber: "BCP-2", player: "Junior Caminero" },
        ],
      },
    ]);
    const report = classifySections(sections);
    const intl = report.find((r: any) => r.section === "International Refractors");
    expect(intl.role, JSON.stringify(intl)).toBe("parallel");
    expect(intl.anchor).toBe("Chrome>Chrome Prospects");
  });

  it("still refuses a same-numbered but disagreeing roster even for a genuinely finish-shaped name", () => {
    const sections = buildSections([
      {
        sheet: "Chrome", section: "Chrome Prospects", category: "base",
        rows: [{ cardNumber: "1", player: "Player A" }],
      },
      {
        sheet: "Chrome", section: "Prospect Refractors",
        category: "insert-prospect-refractors",
        rows: [{ cardNumber: "1", player: "Completely Different Player" }],
      },
    ]);
    const report = classifySections(sections);
    const refr = report.find((r: any) => r.section === "Prospect Refractors");
    expect(refr.role, JSON.stringify(refr)).not.toBe("parallel");
  });

  it("PARTIAL FOLD (review fix, 2026-09-20): folds the agreeing numbers, holds out the disagreeing ones — 2023 Topps Chrome Platinum's Image Variations shape", () => {
    // Minimal reproduction of the real measured split (16 agree / 9 disagree
    // on the real 25-card section): a genuine MAJORITY agrees (same player
    // as base, a true photo variation), the rest disagree (a different card
    // entirely at the same number). A majority is the bar -- see
    // rosterHasAgreeingMajority's own header for why "at least one" is not
    // enough (a single coincidental match must never fold a whole section).
    const sections = buildSections([
      {
        sheet: "Base", section: "Base Set", category: "base",
        rows: [
          { cardNumber: "2", player: "Brett Baty" },
          { cardNumber: "43", player: "Greg Maddux" },
          { cardNumber: "100", player: "Anthony Volpe" },
          { cardNumber: "67", player: "Michael Conforto" },
          { cardNumber: "77", player: "Brandon Hughes" },
        ],
      },
      {
        sheet: "Variations", section: "Image Variations Prizm",
        category: "insert-image-variations-prizm",
        rows: [
          { cardNumber: "2", player: "Brett Baty" },       // agrees
          { cardNumber: "43", player: "Greg Maddux" },     // agrees
          { cardNumber: "100", player: "Anthony Volpe" },  // agrees
          { cardNumber: "67", player: "Corbin Carroll" },  // disagrees
          { cardNumber: "77", player: "Adley Rutschman" }, // disagrees
        ],
      },
    ]);
    const report = classifySections(sections);
    const iv = report.find((r: any) => r.section === "Image Variations Prizm");
    expect(iv.role, JSON.stringify(iv)).toBe("parallel");
    expect(iv.agree).toBe(3);
    expect(iv.disagree).toBe(2);
    expect(new Set(iv.heldNumbers)).toEqual(new Set(["67", "77"]));

    const map = new Map(sections);
    const sec = map.get("Variations>Image Variations Prizm") as any;
    expect(sec.foldExceptions).toEqual(new Set(["67", "77"]));
    expect(sec.parallelOf).toBe(map.get("Base>Base Set"));
  });

  it("a single coincidental agreement is NOT a majority — the Jumbo Rookie Swatch Prizm/Malik Nabers #29 shape", () => {
    // Real, measured false-positive found while implementing the majority
    // bar: 2024 Panini Select Football's "Jumbo Rookie Swatch Prizm" (its
    // own registered 42-card insert) shares exactly ONE number with
    // Base>Base Concourse where the SAME real person coincidentally sits
    // at the SAME number in both -- #29 Malik Nabers, across two
    // independently-numbered checklists -- while every other shared number
    // disagrees. `agree > 0` let this fold; `agree > disagree` correctly
    // refuses it.
    const sections = buildSections([
      {
        sheet: "Base", section: "Base Concourse", category: "base",
        rows: [
          { cardNumber: "4", player: "Bucky Irving" },
          { cardNumber: "10", player: "Braelon Allen" },
          { cardNumber: "29", player: "Malik Nabers" },
        ],
      },
      {
        sheet: "Memorabilia", section: "Jumbo Rookie Swatch Prizm",
        category: "insert-jumbo-rookie-swatch-prizm",
        rows: [
          { cardNumber: "4", player: "Bo Nix" },           // disagrees
          { cardNumber: "10", player: "Caleb Williams" },  // disagrees
          { cardNumber: "29", player: "Malik Nabers" },    // agrees (coincidence)
        ],
      },
    ]);
    const report = classifySections(sections);
    const jrsp = report.find((r: any) => r.section === "Jumbo Rookie Swatch Prizm");
    expect(jrsp.role, JSON.stringify(jrsp)).not.toBe("parallel");
    expect(jrsp.role, JSON.stringify(jrsp)).toBe("own-cards");
  });

  it("full disagreement (0 agree) still refuses even at 100% numeric overlap — Golden Mirror Legend Variations shape", () => {
    const sections = buildSections([
      {
        sheet: "Base", section: "Base Set", category: "base",
        rows: [
          { cardNumber: "1", player: "Aaron Judge" },
          { cardNumber: "5", player: "Nico Hoerner" },
        ],
      },
      {
        sheet: "Variations", section: "Base - Golden Mirror Legend Variations Prizm",
        category: "insert-base-golden-mirror-legend-variations-prizm",
        rows: [
          { cardNumber: "1", player: "Babe Ruth" },
          { cardNumber: "5", player: "Ryne Sandberg" },
        ],
      },
    ]);
    const report = classifySections(sections);
    const gmlv = report.find((r: any) => r.section === "Base - Golden Mirror Legend Variations Prizm");
    expect(gmlv.role, JSON.stringify(gmlv)).not.toBe("parallel");
    expect(gmlv.role, JSON.stringify(gmlv)).toBe("own-cards");
  });
});

describe("THIRD SUSPICION: a sheet that emits far fewer cards than it looks like it has must FAIL LOUDLY", () => {
  it("refuses (nonzero exit, no CSV written) when the player column is empty for a substantial sheet -- the 'player printed in column C' shape", () => {
    const wb = XLSX.utils.book_new();
    // 12 data-looking rows (>= the guard's threshold of 10), player in
    // column C (index 2) instead of column B (index 1) -- every one of them
    // silently fails main()'s `!player` test under the OLD, unguarded
    // behaviour and the sheet emits zero rows while the run still exits 0.
    const rows: unknown[][] = [["Base Set"], ["12 cards."]];
    for (let i = 1; i <= 12; i++) rows.push([String(i), "", `Player ${i}`, `Team ${i}`]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Base");
    const xlsxPath = path.join(TMP, "colc-in.xlsx");
    XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
    const out = path.join(TMP, "colc-out.csv");

    const res = spawnSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", "test-colc",
      "--sport", "football", "--set-name", "test", "--out", out,
    ], { encoding: "utf8" });

    expect(res.status, res.stderr).not.toBe(0);
    expect(res.stderr).toMatch(/FATAL.*Base.*12 card rows.*0 were read/s);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("does not trip on a genuinely thin sheet correctly read in column B", () => {
    const wb = XLSX.utils.book_new();
    const rows: unknown[][] = [["Rare Insert"], ["3 cards."]];
    for (let i = 1; i <= 3; i++) rows.push([String(i), `Player ${i}`, `Team ${i}`]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Inserts");
    const xlsxPath = path.join(TMP, "thin-in.xlsx");
    XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });
    const out = path.join(TMP, "thin-out.csv");

    const res = spawnSync(process.execPath, [
      CONVERTER, "--xlsx", xlsxPath, "--year", "2024", "--set-key", "test-thin",
      "--sport", "football", "--set-name", "test", "--out", out,
    ], { encoding: "utf8" });

    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("does not trip on a sheet correctly read in full (countDataLookingRows sanity)", () => {
    const rows = [
      ["Base Set"], ["3 cards."],
      ["1", "Kyler Murray", "Arizona Cardinals"],
      ["2", "James Conner", "Arizona Cardinals"],
      ["3", "Marvin Harrison Jr.", "Arizona Cardinals"],
    ];
    expect(countDataLookingRows(rows)).toBe(3);
  });
});

describe("FOURTH FINDING: a brand-wide finish suffix is not a new product (CANONICAL_CATEGORY_SLUG)", () => {
  it("strips the trailing 'Prizm'/'Mosaic' suffix for the ten hand-verified spelling artefacts, SCOPED to their own product", () => {
    // Select's Memorabilia/Autographs sheets -- scoped to panini-select.
    expect(categoryFor("Memorabilia", "Sparks Prizm", "panini-select")).toBe("insert-sparks");
    expect(categoryFor("Memorabilia", "Jumbo Rookie Swatch Prizm", "panini-select")).toBe("insert-jumbo-rookie-swatch");
    expect(categoryFor("Memorabilia", "Draft Selections Memorabilia Prizm", "panini-select")).toBe("insert-draft-selections-memorabilia");
    expect(categoryFor("Memorabilia", "Rookie Swatches Prizm", "panini-select")).toBe("insert-rookie-swatches");
    expect(categoryFor("Autographs", "Select Signatures Prizm", "panini-select")).toBe("auto-select-signatures");
    expect(categoryFor("Autographs", "Signatures Prizm", "panini-select")).toBe("auto-signatures");
    expect(categoryFor("Autographs", "Rookie Signature Memorabilia Prizm", "panini-select")).toBe("auto-rookie-signature-memorabilia");
    expect(categoryFor("Autographs", "Jumbo Rookie Signature Swatches Prizm", "panini-select")).toBe("auto-jumbo-rookie-signature-swatches");
    expect(categoryFor("XRC Redemptions", "2025 XRC Mystery Autograph Prizm", "panini-select")).toBe("auto-2025-xrc-mystery-autograph");
    expect(categoryFor("Autographs", "Jumbo Signature Swatches Prizm", "panini-select")).toBe("auto-jumbo-signature-swatches");
    // Mosaic's Inserts sheet -- scoped to panini-mosaic.
    expect(categoryFor("Inserts", "Center Stage Mosaic", "panini-mosaic")).toBe("insert-center-stage");
    expect(categoryFor("Inserts", "Overdrive Mosaic", "panini-mosaic")).toBe("insert-overdrive");
  });

  it("leaves every OTHER Prizm/Mosaic-suffixed section exactly as categoryForRaw would slug it — not a blanket stripper", () => {
    // Select: no un-suffixed "Rookie Signatures" or "Jumbo Signature
    // Swatches" (non-rookie) sibling is registered, so these stay suffixed.
    expect(categoryFor("Autographs", "Rookie Signatures Prizm", "panini-select")).toBe("auto-rookie-signatures-prizm");
    expect(categoryFor("Autographs", "Prime Selections Prizm Signatures", "panini-select")).toBe("auto-prime-selections-prizm-signatures");
    // Mosaic: Capital Gains / Splash / Storm / Micro Mosaic are each their
    // OWN registered key WITH "Mosaic" in it (#2342) -- no bare sibling
    // exists to fold onto, so these must never be stripped.
    expect(categoryFor("Inserts", "Capital Gains Mosaic", "panini-mosaic")).toBe("insert-capital-gains-mosaic");
    expect(categoryFor("Inserts", "Splash Mosaic", "panini-mosaic")).toBe("insert-splash-mosaic");
    expect(categoryFor("Inserts", "Storm Mosaic", "panini-mosaic")).toBe("insert-storm-mosaic");
    expect(categoryFor("Inserts", "Micro Mosaic", "panini-mosaic")).toBe("insert-micro-mosaic");
  });

  it("SCOPING: an unrelated product emitting the identical raw slug is NEVER rewritten (review fix, 2026-09-20)", () => {
    // The exact same section name, same category slug, on a DIFFERENT
    // product's setKey -- if this ever matched, a future workbook's own
    // "Sparks Prizm" (no relationship to Select's registered
    // panini-select-sparks) would silently land on Select's address the
    // moment its raw slug happened to coincide. It must not.
    expect(categoryFor("Memorabilia", "Sparks Prizm", "some-other-product")).toBe("insert-sparks-prizm");
    expect(categoryFor("Inserts", "Center Stage Mosaic", "some-other-mosaic-product")).toBe("insert-center-stage-mosaic");
    // The unscoped 2-arg call form (SET_KEY empty, as it always is when a
    // test imports this module directly rather than running it via the
    // CLI) must ALSO never fold -- confirms main()'s own ambient-SET_KEY
    // default degrades to "no product, no fold" rather than "fold anyway".
    expect(categoryFor("Memorabilia", "Sparks Prizm")).toBe("insert-sparks-prizm");
    expect(categoryFor("Inserts", "Center Stage Mosaic")).toBe("insert-center-stage-mosaic");
  });
});

describe("FIFTH FINDING: a repeated header with a disagreeing roster is a second section", () => {
  it("reproduces Select's own shape minimally: 'Score Select Throwback' printed twice, two disjoint rosters", () => {
    const rows = convert({
      Inserts: [
        ["Score Select Throwback"],
        ["2 cards"],
        ["1", "Jalen Hurts", "Philadelphia Eagles"],
        ["2", "C.J. Stroud", "Houston Texans"],
        ["Score Select Throwback"],
        ["2 cards"],
        ["1", "Caleb Williams", "Chicago Bears"],
        ["2", "Jayden Daniels", "Washington Commanders"],
      ],
    }, "test-repeated-header");

    const num1 = rows.filter((r) => r.cardNumber === "1");
    expect(num1).toHaveLength(2);
    const players = num1.map((r) => r.player).sort();
    expect(players).toEqual(["Caleb Williams", "Jalen Hurts"]);
    // The two rows for #1 must land under DIFFERENT categories -- the
    // whole point of the split is that they no longer compute the same id.
    const categories = new Set(num1.map((r) => r.category));
    expect(categories.size).toBe(2);
    expect([...categories].some((c) => /-2$/.test(c))).toBe(true);
  });

  it("does NOT split a genuine League-Leaders multi-player card (same number, consecutive rows, meant to MERGE)", () => {
    const rows = convert({
      Inserts: [
        ["League Leaders"],
        ["1 card"],
        ["11", "Pete Alonso", "New York Mets"],
        ["11", "Kyle Schwarber", "Philadelphia Phillies"],
        ["11", "Juan Soto", "New York Mets"],
      ],
    }, "test-league-leaders-no-split");

    const eleven = rows.filter((r) => r.cardNumber === "11");
    expect(eleven).toHaveLength(1);
    expect(eleven[0].player).toBe("Pete Alonso/Kyle Schwarber/Juan Soto");
    expect(eleven[0].category).toBe("insert-league-leaders");
  });

  it("does not split when the same number repeats with the SAME player (a genuine parallel/ladder re-mention)", () => {
    const rows = convert({
      Inserts: [
        ["Some Insert"],
        ["1 card"],
        ["1", "Kyler Murray", "Arizona Cardinals"],
        ["Some Insert"],
        ["1", "Kyler Murray", "Arizona Cardinals"],
      ],
    }, "test-same-player-no-split");

    const ones = rows.filter((r) => r.cardNumber === "1");
    // Deduped to one row (same category, same cardNumber, same parallel,
    // same isAuto, same player) by the existing duplicate-row guard --
    // never split, since there is no disagreement at all.
    expect(ones).toHaveLength(1);
    expect(new Set(ones.map((r) => r.category)).size).toBe(1);
  });
});
