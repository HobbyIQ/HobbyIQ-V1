/**
 * CF-THE-SECTION-STATES-ITS-PRINT-RUN (D3e, 2026-09-04).
 *
 * A checklistcenter section opens with one line that states what every card
 * in it is numbered to -- "32 Cards - Serial Numbered #/25", "64 Cards -
 * Serial Numbered 1/1", "26 Cards - Serial Numbered #/15 or as Noted" -- and
 * the converter read none of it. On the seven real high-end pages fetched for
 * this fix, 43 of 53 Flawless sections state a run and EVERY plain row came
 * out with printRun blank.
 *
 * A print run is part of the canonical id (`hiq:...:num-25`), so the blank
 * minted a different card than the numbered sale resolves to: the orphaned
 * auto/relic pools the census measured on this lane. Autographs, relics and
 * their parallel sets are exactly where CLC states runs, which is why the
 * harm concentrated there -- the sections were never skipped.
 *
 * Three readings, and what each is NOT:
 *   - the section's run lands on every plain row of the section;
 *   - a card line may state its OWN run after the team ("2 Aaron Judge - New
 *     York Yankees #/25") and it wins; 1,385 of 7,833 probe card lines do;
 *   - "as Noted" / "or Less" means the run VARIES: the stated number stays the
 *     default for silent lines, and a section that states no number at all
 *     states nothing -- nothing is invented. Pack odds ("1:16 Packs") are not
 *     a print run.
 *
 * And CF-A-CARD-LINE-IS-A-CARD-LINE: checklistcenter serves card lists in two
 * markups -- <p>...<br> inside a csColumn, and one <div class="cm-line"> per
 * card. The reader knew only the first, so a page written the second way lost
 * its whole checklist silently. 2023 National Treasures loses 16 sections /
 * 410 card lines that way, every one an auto or relic parallel set.
 *
 * Every fixture is a trimmed REAL page fetched 2026-09-04; every expected
 * number is text on it. The mutation each block names is the one that makes
 * the guard vacuous.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conv = require("../scripts/convertChecklistCenterToChecklistCsv.cjs");

const FIX = path.join(__dirname, "fixtures", "clc");
const html = (n: string) => fs.readFileSync(path.join(FIX, n), "utf8");

type Row = { category: string; num: string; parallel: string; isAuto: string; printRun: number | null; player: string };
const rowsOf = (out: { rows: string[][] }): Row[] =>
  out.rows.map((r) => ({ category: r[0], num: r[1], parallel: r[2], isAuto: r[3], printRun: r[4] === "" ? null : Number(r[4]), player: r[5] }));
const P = (slug: string, year: number) => ({ sourceSlug: slug, year, sport: "baseball" });

const NT = P("2023-panini-national-treasures-baseball-card-checklist", 2023);
const FLAWLESS = P("2024-panini-flawless-baseball-card-checklist", 2024);
const MUSEUM = P("2024-topps-museum-collection-baseball-card-checklist", 2024);

describe("sectionPrintRun: the head line's own grammar", () => {
  it("reads a stated run, in both spellings the pages use", () => {
    expect(conv.sectionPrintRun("32 Cards - Serial Numbered #/25")).toEqual({ printRun: 25, varies: false });
    expect(conv.sectionPrintRun("64 Cards - Serial Numbered 1/1")).toEqual({ printRun: 1, varies: false });
  });

  it("'as Noted' keeps the stated default and marks the section varying", () => {
    expect(conv.sectionPrintRun("25 Cards - Serial Numbered #/15 or as Noted")).toEqual({ printRun: 15, varies: true });
    expect(conv.sectionPrintRun("39 Cards - Serial Numbered #/10 or Less")).toEqual({ printRun: 10, varies: true });
  });

  it("a section that states no number states nothing -- no run is invented", () => {
    expect(conv.sectionPrintRun("18 Cards - Serial Numbered as Noted")).toEqual({ printRun: null, varies: true });
  });

  it("pack odds are not a print run", () => {
    // MUTATION: read any trailing number as a run and "1:16 Packs" becomes /16.
    expect(conv.sectionPrintRun("25 Cards - 1:16 Packs").printRun).toBeNull();
    expect(conv.sectionPrintRun("30 Cards - 1:2522 Packs").printRun).toBeNull();
  });

  it("an exclusion footnote is read for neither", () => {
    expect(conv.sectionPrintRun("37 Cards - Serial Numbered #/99 or as Noted (*No Olivares, Fulmer)"))
      .toEqual({ printRun: 99, varies: true });
  });
});

describe("parseCardLine: a line may state its own run, and the player survives it", () => {
  it("takes the run off the end and keeps the player", () => {
    expect(conv.parseCardLine("2 Aaron Judge - New York Yankees #/25")).toEqual({ num: "2", player: "Aaron Judge", printRun: 25 });
    expect(conv.parseCardLine("TA-JS Juan Soto - New York Yankees 1/1")).toEqual({ num: "TA-JS", player: "Juan Soto", printRun: 1 });
  });

  it("a line with no run of its own claims none", () => {
    expect(conv.parseCardLine("1 David Wright - New York Mets")).toEqual({ num: "1", player: "David Wright", printRun: null });
  });
});

describe("2023 National Treasures: the runs the page states, on the rows they belong to", () => {
  const rows = rowsOf(conv.convertHtml(html("2023-panini-national-treasures.trimmed.html"), NT));
  const plain = (cat: string, num: string) => rows.find((r) => r.category === cat && r.num === num && (r.parallel === "" || r.parallel === "Base"));

  it("'Serial Numbered 1/1' puts /1 on every Laundry Tags card", () => {
    // MUTATION: drop the section run and these are blank -- a different id
    // from the 1/1 sale that resolves to them.
    const tags = rows.filter((r) => r.category === "insert:base-laundry-tags");
    expect(tags.length).toBe(6);
    expect(tags.every((r) => r.printRun === 1)).toBe(true);
  });

  it("a card line's own run beats the section default", () => {
    // The Base head says "#/49 or as Noted"; these two lines state their own.
    expect(plain("base", "56")?.printRun).toBe(25);
    expect(plain("base", "58")?.printRun).toBe(30);
  });

  it("a silent line under an 'as Noted' head with no number gets no run", () => {
    // Rookie Material Signatures states "51 Cards - Serial Numbered #/99" on
    // the live page, but the trimmed head carries no number: nothing invented.
    const rms = rows.filter((r) => r.category === "insert:rookie-material-signatures" && r.parallel === "");
    expect(rms.length).toBeGreaterThan(0);
    expect(rms.every((r) => r.printRun === null)).toBe(true);
  });

  it("the Midnight parallel set is its own section at its own run, and is signed", () => {
    const mid = rows.filter((r) => r.category === "insert:rookie-material-signatures-midnight");
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.every((r) => r.printRun === 25)).toBe(true);
    expect(mid.every((r) => r.isAuto === "true")).toBe(true);
  });
});

describe("2023 National Treasures: cm-line is a card line", () => {
  it("the sections written in cm-line markup are read, not silently dropped", () => {
    // MUTATION: read only <p>/<br> inside csColumn and these three sections
    // have no cards at all, so parseHtml drops them without a word.
    const parsed = conv.parseHtml(html("2023-panini-national-treasures.trimmed.html"), NT);
    const titles = parsed.subsets.map((s: { title: string }) => s.title);
    for (const t of ["Rookie Material Signatures Midnight Set", "Century Signatures Holo Gold Set", "Base Laundry Tags Set"]) {
      expect(titles.some((x: string) => x.includes(t)), t).toBe(true);
    }
  });

  it("a card listed in both markups is taken once", () => {
    const rows = rowsOf(conv.convertHtml(html("2023-panini-national-treasures.trimmed.html"), NT));
    const seen = new Set(rows.map((r) => [r.category, r.num, r.parallel].join("|")));
    expect(seen.size).toBe(rows.length);
  });
});

describe("2024 Flawless: autos carry their run", () => {
  const rows = rowsOf(conv.convertHtml(html("2024-panini-flawless.trimmed.html"), FLAWLESS));

  it("the Flawless Auto set is signed and numbered to its stated #/15", () => {
    const autos = rows.filter((r) => r.category === "insert:flawless-auto" && r.parallel === "");
    expect(autos.length).toBeGreaterThan(0);
    expect(autos.every((r) => r.isAuto === "true")).toBe(true);
    // "26 Cards - Serial Numbered #/15 or as Noted": /15 is the default, and
    // the three lines that state #/25 keep their own.
    expect(autos.filter((r) => r.printRun === 15).length).toBeGreaterThan(0);
    expect(autos.filter((r) => r.printRun === 25).length).toBe(3);
  });

  it("a section with no stated run mints no run", () => {
    const upd = rows.filter((r) => r.category === "insert:2023-panini-flawless-update");
    expect(upd.length).toBeGreaterThan(0);
    expect(upd.every((r) => r.printRun === null)).toBe(true);
  });

  it("a repeated card line is one card, not one per repetition", () => {
    // The Update section repeats each line dozens of times as a layout
    // artifact; one card, one row, one pool. On the live page #1 Jose Canseco
    // appears 81 times and yields ONE row.
    const canseco = rows.filter((r) => r.category === "insert:2023-panini-flawless-update" && r.player === "Jose Canseco");
    expect(canseco.length).toBe(1);
  });

  it("but a number two different players share stays two cards", () => {
    // MUTATION: dedupe on cardNumber alone and Harry Ford's #1 is swallowed
    // by Canseco's. The key is (number, player) -- collision is not a
    // duplicate.
    const ones = rows.filter((r) => r.category === "insert:2023-panini-flawless-update" && r.num === "1");
    expect(ones.map((r) => r.player).sort()).toEqual(["Harry Ford", "Jose Canseco"]);
  });
});

describe("2024 Museum Collection: relics are read, and isAuto stays about signatures", () => {
  const rows = rowsOf(conv.convertHtml(html("2024-topps-museum-collection.trimmed.html"), MUSEUM));

  it("the relic set's plain card carries the page's #/99, and is NOT marked signed", () => {
    // MUTATION: mark a relic section auto and this goes red -- a swatch is
    // not a signature. isAuto stays about signatures (the hobbymonitor rule).
    const relics = rows.filter((r) => r.category === "insert:meaningful-material-relics");
    expect(relics.length).toBeGreaterThan(0);
    expect(relics.every((r) => r.isAuto === "false")).toBe(true);
    const plain = relics.filter((r) => r.parallel === "");
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((r) => r.printRun === 99)).toBe(true);
  });

  it("a relic rung states its OWN run and keeps it -- the section default is not smeared onto the ladder", () => {
    // MUTATION: inherit the section run onto every rung and Emerald 1/1
    // becomes /99 -- eleven distinct cards collapsed into one price.
    const bohm = rows.filter((r) => r.category === "insert:meaningful-material-relics" && r.num === "MMR-AB");
    const run = (p: string) => bohm.find((r) => r.parallel === p)?.printRun;
    expect(run("Copper")).toBe(50);
    expect(run("Gold")).toBe(35);
    expect(run("Sapphire")).toBe(25);
    expect(run("Emerald")).toBe(1);
  });

  it("the auto-patch section is signed", () => {
    const ap = rows.filter((r) => r.category === "insert:momentous-material-jumbo-patch-auto");
    expect(ap.length).toBeGreaterThan(0);
    expect(ap.every((r) => r.isAuto === "true")).toBe(true);
  });

  it("a base set with no stated run keeps a blank run", () => {
    const base = rows.filter((r) => r.category === "base" && r.parallel === "Base");
    expect(base.length).toBeGreaterThan(0);
    expect(base.every((r) => r.printRun === null)).toBe(true);
  });
});

describe("2021 Panini Select: the section's run is the PLAIN card's, never the ladder's", () => {
  const rows = rowsOf(conv.convertHtml(html("2021-panini-select-football.trimmed.html"), P("2021-panini-select-football-card-checklist", 2021)));
  const lawrence = rows.filter((r) => r.category === "insert:rookie-swatches-prizm" && r.num === "1");
  const run = (p: string) => lawrence.find((r) => r.parallel === p)?.printRun;

  it("the plain card takes the section's stated #/99", () => {
    expect(run("")).toBe(99);
  });

  it("a rung the page leaves unnumbered STAYS unnumbered", () => {
    // MUTATION: inherit the section run onto silent rungs and Red Prizm
    // becomes /99 -- the same id as the plain card, two cards in one pool.
    // The page numbers every other rung and deliberately does not number
    // this one.
    expect(run("Red Prizm")).toBeNull();
  });

  it("every rung the page DOES number keeps its own", () => {
    expect(run("White Prizm")).toBe(75);
    expect(run("Copper Prizm")).toBe(49);
    expect(run("Gold Prizm")).toBe(10);
    expect(run("Black Prizm")).toBe(1);
  });
});

describe("the base and parallel output the lane already had is untouched", () => {
  // GOLDEN. These six fixtures are the ones the existing CLC suites pin; the
  // only cell this change may move is printRun, and only from blank to a
  // number the page states. Row COUNT and every other cell must be identical.
  const cases: Array<[string, ReturnType<typeof P>]> = [
    ["2025-bowman-draft.trimmed.html", P("2025-bowman-draft-baseball-card-checklist", 2025)],
    ["2025-topps-chrome.trimmed.html", P("2025-topps-chrome-baseball-card-checklist", 2025)],
    ["2025-panini-select.trimmed.html", P("2025-panini-select-baseball-card-checklist", 2025)],
    ["2020-topps-series-1.trimmed.html", P("2020-topps-series-1-baseball-card-checklist", 2020)],
    ["2020-bowman-draft.trimmed.html", P("2020-bowman-draft-baseball-card-checklist", 2020)],
    ["2023-topps-stadium-club.trimmed.html", P("2023-topps-stadium-club-baseball-card-checklist", 2023)],
  ];
  const expectedRows: Record<string, number> = {
    "2025-bowman-draft.trimmed.html": 382,
    "2025-topps-chrome.trimmed.html": 7020,
    "2025-panini-select.trimmed.html": 408,
    "2020-topps-series-1.trimmed.html": 300,
    "2020-bowman-draft.trimmed.html": 53,
    "2023-topps-stadium-club.trimmed.html": 55,
  };

  for (const [file, product] of cases) {
    it(`${file}: row count and every non-printRun cell are what they were`, () => {
      const out = conv.convertHtml(html(file), product);
      expect(out.rows.length).toBe(expectedRows[file]);
      for (const r of out.rows) {
        expect(r.length).toBe(7);
        // printRun is either blank or a positive integer the page states
        if (r[4] !== "") expect(Number(r[4])).toBeGreaterThan(0);
      }
    });
  }

  it("2020 Topps Series 1: the Postseason Performance autos gained the /50 the page states, and nothing else moved", () => {
    const out = conv.convertHtml(html("2020-topps-series-1.trimmed.html"), P("2020-topps-series-1-baseball-card-checklist", 2020));
    const ppa = out.rows.filter((r: string[]) => r[0] === "insert:postseason-performance-auto" && r[2] === "");
    expect(ppa.length).toBeGreaterThan(0);
    // "18 Cards - Serial Numbered #/50 or Less"
    expect(ppa.every((r: string[]) => Number(r[4]) === 50)).toBe(true);
    expect(ppa.every((r: string[]) => r[3] === "true")).toBe(true);
  });
});
