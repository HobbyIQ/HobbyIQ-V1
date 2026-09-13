/**
 * TWO DEFECTS found building the 2014 Panini Prizm FIFA World Cup file
 * (PR #2105, Drew 2026-09-13):
 *
 *   1. PAGINATION — TCDB set pages list 100 rows per page. The shipped
 *      scraper's pagination loop was reachable only through a `<td>` grid
 *      walk that TCDB's current markup can never match (the checklist table
 *      carries no `<th>` cells, so `headerText` is always empty and the walk
 *      always returns 0 rows) — a fragile "only if the primary path found
 *      nothing" gate rather than an unconditional page walk. A single-page
 *      read gives 100 of the 201-card base set and clips every 100+ parallel
 *      rung at the same boundary.
 *
 *   2. NAME EXTRACTION — the old anchor extractor read names ONLY from
 *      Person.cfm links. Two real row shapes carry no Person.cfm anchor at
 *      all: TEAM cards (Team Photos: "Algerie TC" as plain text, the
 *      Team.cfm link is in a LATER cell) and MULTI-PLAYER cards whose names
 *      are plain text with a "/" separator (Combo Signatures: "Bobby
 *      Charlton / Steven Gerrard AU, SN10"). 15 of 136 rungs on this product
 *      extracted ZERO rows. Reading the row's own cells recovers all of them
 *      — and recovers the trailing AU / SNnnn attribute tokens, which is
 *      where the autograph and print-run truth for the Signatures rungs
 *      comes from. Per doctrine: every row traces to the page, blank means
 *      unknown, autos are never minted unsigned, and a print run stated for
 *      one rung applies to that rung only.
 *
 * Fixtures are the REAL pages (fetched 2026-09-13, trimmed to the checklist
 * table + pagination nav): the 2014 Prizm World Cup base set across its 3
 * pages (100 + 100 + 1 = 201, TCDB's own stated count), its Team Photos rung
 * (32 team cards, 0 Person.cfm anchors), and its Combo Signatures rung (10
 * two-player autograph cards, 0 Person.cfm anchors, each stating "AU, SN10").
 *
 * These pins drive the scraper's own `main()` over the fixtures via
 * runTcdbScraperOverFixtures.cjs (fetchHtml injected, same "drive the
 * committed path" shape as runBcpLaddersOverFixtures.cjs), so a regression in
 * the shipped pagination or row-reading logic fails these tests — not a
 * reimplementation of it.
 */
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const scraper = require_(path.resolve(__dirname, "../scripts/scrape-tcdb.cjs")) as {
  isCardNumber: (t: string) => boolean;
  parseNameAttributes: (raw: string) => { name: string; isAuto: boolean; printRun: string };
  splitPlayers: (name: string) => string[];
};

type CsvRow = { category: string; cardNumber: string; parallel: string; isAuto: string; printRun: string; player: string };

function readCsv(file: string): CsvRow[] {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const [header, ...body] = lines;
  expect(header).toBe("category,cardNumber,parallel,isAuto,printRun,player");
  return body.map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...playerParts] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: playerParts.join(",") };
  });
}

/** Run the scraper's real main() over fixtures in-process (helper sets
 *  process.env + calls main({ fetchHtml, outDir }) directly). */
function runScraper(outDir: string, url: string, category: string, fixtures: string[]) {
  execFileSync(process.execPath, [
    path.resolve(__dirname, "helpers/runTcdbScraperOverFixtures.cjs"),
    outDir, url, category, ...fixtures,
  ], { stdio: "pipe" });
  return JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8")) as {
    rows: number; productKey: string; year: number; setName: string;
  };
}

const mkOutDir = () => fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "tcdb-pin-"));

describe("defect 1 — pagination: row count equals the set's stated count across pages", () => {
  let outDir: string;
  let result: { rows: number; productKey: string };
  let rows: CsvRow[];

  beforeAll(() => {
    outDir = mkOutDir();
    result = runScraper(
      outDir,
      "https://www.tcdb.com/Checklist.cfm/sid/91110/2014-Panini-Prizm-FIFA-World-Cup",
      "base",
      [
        "2014-prizm-world-cup-base.page1",
        "2014-prizm-world-cup-base.page2",
        "2014-prizm-world-cup-base.page3",
      ],
    );
    rows = readCsv(path.join(outDir, `tcdb-${result.productKey}.csv`));
  });

  it("reads all 3 pages and reconciles to TCDB's stated 201-card base set (not clipped at 100)", () => {
    expect(result.rows).toBe(201);
    expect(rows.length).toBe(201);
  });

  it("carries no duplicate card numbers across the page boundary", () => {
    const nums = rows.map((r) => r.cardNumber);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("keeps card #1 from page 1 and the last card from page 3 both present", () => {
    expect(rows.some((r) => r.cardNumber === "1")).toBe(true);
    // Page 3 fixture holds exactly one card past the 200 mark.
    expect(rows.length).toBeGreaterThan(200);
  });

  it("a single-page run (no page 2/3 fixtures given) is clipped at 100 — proves paging is what closes the gap", () => {
    const singlePageDir = mkOutDir();
    const single = runScraper(
      singlePageDir,
      "https://www.tcdb.com/Checklist.cfm/sid/91110/2014-Panini-Prizm-FIFA-World-Cup",
      "base",
      ["2014-prizm-world-cup-base.page1"],
    );
    expect(single.rows).toBe(100);
    expect(single.rows).toBeLessThan(201);
  });
});

describe("defect 2 — team cards and multi-player cards are present with names", () => {
  it("Team Photos: all 32 team-card rows extracted (Person.cfm-only extraction gave 0)", () => {
    const outDir = mkOutDir();
    const result = runScraper(
      outDir,
      "https://www.tcdb.com/Checklist.cfm/sid/94770/2014-Panini-Prizm-FIFA-World-Cup-Team-Photos",
      "insert-team-photos",
      ["2014-prizm-world-cup-team-photos"],
    );
    const rows = readCsv(path.join(outDir, `tcdb-${result.productKey}.csv`));
    expect(rows.length).toBe(32);
    // Plain-text name cell, no Person.cfm anchor on the page at all.
    const algeria = rows.find((r) => r.cardNumber === "1");
    expect(algeria?.player).toBe("Algerie TC");
    const usa = rows.find((r) => r.player.includes("United States"));
    expect(usa).toBeDefined();
  });

  it("Combo Signatures: all 10 multi-player rows extracted with BOTH names, not one", () => {
    const outDir = mkOutDir();
    const result = runScraper(
      outDir,
      "https://www.tcdb.com/Checklist.cfm/sid/94702/2014-Panini-Prizm-FIFA-World-Cup-Combo-Signatures",
      "insert-combo-signatures",
      ["2014-prizm-world-cup-combo-signatures"],
    );
    const rows = readCsv(path.join(outDir, `tcdb-${result.productKey}.csv`));
    expect(rows.length).toBe(10);
    const csBs = rows.find((r) => r.cardNumber === "CS-BS");
    expect(csBs?.player).toBe("Bobby Charlton / Steven Gerrard");
    // Every row is a two-player combo; neither name may be dropped.
    for (const r of rows) {
      expect(r.player.split(" / ").length).toBe(2);
      expect(r.player).not.toMatch(/^\s*$/);
    }
  });
});

describe("defect 2b — AU / SNnnn attribute tokens parse into isAuto / printRun, scoped to their own rung", () => {
  it("Combo Signatures rows are all autos, all serial-numbered to 10 — from the page text, not a default", () => {
    const outDir = mkOutDir();
    const result = runScraper(
      outDir,
      "https://www.tcdb.com/Checklist.cfm/sid/94702/2014-Panini-Prizm-FIFA-World-Cup-Combo-Signatures",
      "insert-combo-signatures",
      ["2014-prizm-world-cup-combo-signatures"],
    );
    const rows = readCsv(path.join(outDir, `tcdb-${result.productKey}.csv`));
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(r.isAuto).toBe("true");
      expect(r.printRun).toBe("10");
    }
    // The attribute tokens must not leak into the player name.
    expect(rows.every((r) => !/AU|SN10/i.test(r.player))).toBe(true);
  });

  it("Team Photos rows state no AU/SN token on the page and are emitted unsigned with a blank print run", () => {
    // Doctrine: autos are never minted unsigned, and blank means unknown —
    // a rung that never says AU must never be stamped isAuto=true, and a
    // print run stated on ONE rung (Combo Signatures /10) must never leak
    // onto a different rung (Team Photos) that never stated one.
    const outDir = mkOutDir();
    const result = runScraper(
      outDir,
      "https://www.tcdb.com/Checklist.cfm/sid/94770/2014-Panini-Prizm-FIFA-World-Cup-Team-Photos",
      "insert-team-photos",
      ["2014-prizm-world-cup-team-photos"],
    );
    const rows = readCsv(path.join(outDir, `tcdb-${result.productKey}.csv`));
    expect(rows.length).toBe(32);
    for (const r of rows) {
      expect(r.isAuto).toBe("false");
      expect(r.printRun).toBe("");
    }
  });

  it("parseNameAttributes: unit pins for the token grammar", () => {
    expect(scraper.parseNameAttributes("Bobby Charlton / Steven Gerrard AU, SN10")).toEqual({
      name: "Bobby Charlton / Steven Gerrard", isAuto: true, printRun: "10",
    });
    expect(scraper.parseNameAttributes("Michael Jordan")).toEqual({
      name: "Michael Jordan", isAuto: false, printRun: "",
    });
    // AU with no SN — auto, print run stays blank (unknown, never guessed).
    expect(scraper.parseNameAttributes("Lionel Messi AU")).toEqual({
      name: "Lionel Messi", isAuto: true, printRun: "",
    });
    // SN with no AU — serial-numbered relic/parallel, not an autograph.
    expect(scraper.parseNameAttributes("Lionel Messi SN25")).toEqual({
      name: "Lionel Messi", isAuto: false, printRun: "25",
    });
  });

  it("splitPlayers: a '/' is TCDB's own multi-player separator", () => {
    expect(scraper.splitPlayers("Bobby Charlton / Steven Gerrard")).toEqual([
      "Bobby Charlton", "Steven Gerrard",
    ]);
    expect(scraper.splitPlayers("Michael Jordan")).toEqual(["Michael Jordan"]);
  });
});

describe("the fix is in the committed file, not just this test's own copy of the logic", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../scripts/scrape-tcdb.cjs"), "utf8");

  it("pagination no longer lives behind the dead <td> grid-walk's rows.length === 0 gate", () => {
    expect(src).not.toMatch(/if \(rows\.length === 0\)/);
  });

  it("row reading is no longer Person.cfm-only", () => {
    expect(src).toMatch(/Team\.cfm/);
    expect(src).toMatch(/CF-TCDB-ROW-READER/);
  });

  it("env is read lazily (module is require()-able with no TCDB_URL set, no process.exit side effect)", () => {
    // The old top-level `if (!TCDB_URL) { process.exit(2); }` made this file
    // un-requireable for a test without TCDB_URL set. require() above this
    // describe block already proves it; this pins the source shape too.
    expect(src).not.toMatch(/^const TCDB_URL = process\.env\.TCDB_URL;/m);
    expect(src).toMatch(/if \(require\.main === module\)/);
  });

  it("isCardNumber still accepts hyphenated and initials-only numbers (CF-TCDB-INITIALS-NUMBERS not regressed)", () => {
    for (const n of ["BNR-VGJ", "S-1", "CS-BS", "1", "201"]) {
      expect(scraper.isCardNumber(n)).toBe(true);
    }
    for (const w of ["Base", "More", "Checklist"]) {
      expect(scraper.isCardNumber(w)).toBe(false);
    }
  });
});
