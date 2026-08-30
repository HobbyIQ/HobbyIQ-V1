/**
 * CF-A-PRINT-RUN-IS-A-FUNCTION-OF-(RANGE, PARALLEL) and
 * CF-THE-EXCEPT-BLOCK-IS-NOT-THE-RULE — the two print-run bugs in #1571 §3.1
 * and §3.2.
 *
 * §3.1  BCP states vintage print runs PER CARD-NUMBER RANGE:
 *
 *         Radiance Heroes of the Game (cards 171-180; serial-numbered to 100)
 *
 *       The emitter applied every rung to every base card, so card #1 was
 *       written as "Radiance Heroes of the Game /100". 360 cards x N rungs is
 *       the exploded-spine cross-join signature (#1371).
 *
 * §3.2  1999 Black Diamond states a rule, then an EXCEPTION for three players.
 *       The exception's <li> lines come SECOND, so they filled the rule lines'
 *       (unparsed) print runs and stamped Double /1998, Triple /273,
 *       Quadruple /66 on all 120 cards. /273 is Sammy Sosa's career home-run
 *       total written onto every player in the set, and it read as success.
 *
 * Both write CONFIDENTLY WRONG values, which per `only-improve hides
 * well-formed wrong rows` are invisible to every later sweep. So these pins
 * assert the EMITTED NUMBERS against the page text (verify output, not
 * process), driving the COMMITTED emission path over fixtures that are the
 * real pages fetched 2026-08-30.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));

const fixture = (n: string) =>
  fs.readFileSync(path.resolve(__dirname, `fixtures/bcp/${n}.trimmed.html`), "utf8");

type Row = { num: string; player: string; parallel: string; run: number | null };

/**
 * Run the scraper's OWN main() over the fixtures, in a subprocess with fetch
 * stubbed, and read back the CSV it writes.
 *
 * Re-implementing the emit loop's filters in the test would pin nothing: with
 * the guards deleted from the shipped file the assertions still passed, because
 * the test was checking its own copy of them. This drives the committed path,
 * so removing either scope check fails these tests.
 */
const OUT = path.resolve(
  fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "bcp-ladders-pin-")),
);
{
  const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
  execFileSync(process.execPath, [
    path.resolve(__dirname, "helpers/runBcpLaddersOverFixtures.cjs"), OUT,
    "1998_SPx_Finite=1998-spx-finite",
    "1999_Black_Diamond=1999-black-diamond",
  ], { stdio: "pipe" });
}

/** Parse one emitted CSV into (cardNumber, parallel, printRun) rows. */
function readCsv(file: string): Row[] {
  const text = fs.readFileSync(path.join(OUT, file), "utf8").trim().split("\n").slice(1);
  const rows: Row[] = [];
  for (const line of text) {
    // category,cardNumber,parallel,isAuto,printRun,player,parallelNote
    const f: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { f.push(cur); cur = ""; }
      else cur += ch;
    }
    f.push(cur);
    if (f[0] !== "base" || f[2] === "Base" || !f[2]) continue;
    rows.push({ num: f[1], player: f[5] ?? "", parallel: f[2], run: f[4] === "" ? null : Number(f[4]) });
  }
  return rows;
}

/** The base cards of a fixture, for set-size assertions. */
const cardsOf = (name: string) => L.parseCards(L.section(fixture(name), "Base_Set", 2));

describe("§3.1 — a range-scoped print run reaches only its own cards", () => {
  const cards = cardsOf("1998-spx-finite");
  const rows = [
    ...readCsv("1998-spx-finite-baseball--radiance.csv"),
    ...readCsv("1998-spx-finite-baseball--spectrum.csv"),
  ];

  it("reads all 360 base cards", () => {
    expect(cards.length).toBe(360);
  });

  it("puts Radiance Heroes of the Game /100 on cards 171-180 and NOWHERE else", () => {
    // The page: "Radiance Heroes of the Game (cards 171-180; serial-numbered to 100)"
    const heroes = rows.filter((r) => r.parallel === "Radiance Heroes of the Game");
    expect(heroes.map((r) => Number(r.num)).sort((a, b) => a - b))
      .toEqual([171, 172, 173, 174, 175, 176, 177, 178, 179, 180]);
    expect([...new Set(heroes.map((r) => r.run))]).toEqual([100]);
  });

  it("never emits a 360-wide rung — the cross-join signature", () => {
    const width = new Map<string, number>();
    for (const r of rows) width.set(r.parallel, (width.get(r.parallel) ?? 0) + 1);
    const setWide = [...width.entries()].filter(([, n]) => n >= cards.length);
    expect(setWide).toEqual([]);
  });

  it("scopes every Radiance rung to the card range the page states", () => {
    const widths = new Map<string, number>();
    for (const r of rows) if (r.parallel.startsWith("Radiance")) widths.set(r.parallel, (widths.get(r.parallel) ?? 0) + 1);
    expect(Object.fromEntries(widths)).toEqual({
      "Radiance Youth Movement": 60,           // cards 1-30 AND 181-210
      "Radiance Power Explosion": 20,          // 31-50
      "Radiance commons": 180,                 // 51-140 AND 241-330
      "Radiance Star Focus": 30,               // 141-170
      "Radiance Heroes of the Game": 10,       // 171-180
      "Radiance Power Passion": 30,            // 211-240
      "Radiance Tradewinds": 20,               // 331-350
      "Radiance Cornerstones of the Game": 10, // 351-360
    });
  });

  it("keeps BOTH spans of a split subset — 1-30 and 181-210", () => {
    // Capturing only the first span silently halved every split subset.
    const youth = rows.filter((r) => r.parallel === "Radiance Youth Movement").map((r) => Number(r.num));
    expect(Math.min(...youth)).toBe(1);
    expect(Math.max(...youth)).toBe(210);
    expect(youth.filter((n) => n >= 181 && n <= 210).length).toBe(30);
    expect(youth.some((n) => n > 30 && n < 181)).toBe(false);
  });

  it("card #1 is Youth Movement /2500 and is NOT Heroes /100", () => {
    const one = rows.filter((r) => r.num === "1" && r.parallel.startsWith("Radiance"));
    expect(one.map((r) => [r.parallel, r.run])).toEqual([["Radiance Youth Movement", 2500]]);
  });

  it("reads 'one-of-one' as /1 rather than leaving it blank", () => {
    // "SPectrum Heroes of the Game (cards 171-180; one-of-one)"
    const oneOfOne = rows.filter((r) => r.parallel === "SPectrum Heroes of the Game");
    expect([...new Set(oneOfOne.map((r) => r.run))]).toEqual([1]);
    expect(oneOfOne.length).toBe(10);
  });

  it("parses multi-span and single-span range clauses", () => {
    expect(L.parseCardRange("(cards 1-30 and 181-210; serial-numbered to 2500)")).toEqual([[1, 30], [181, 210]]);
    expect(L.parseCardRange("(cards 171-180; serial-numbered to 100)")).toEqual([[171, 180]]);
    expect(L.parseCardRange("(cards #40, 41, and 45)")).toEqual([[40, 40], [41, 41], [45, 45]]);
    expect(L.parseCardRange("Gold (one-of-one)")).toBeNull();
  });

  it("an unscoped rung with no range still reaches every card", () => {
    // cardInRange(null) = the whole set; the fix must not silently blank a
    // genuinely set-wide ladder.
    expect(L.cardInRange("55", null)).toBe(true);
    expect(L.cardInRange("55", [[1, 30]])).toBe(false);
    expect(L.cardInRange("55", [[1, 30], [51, 60]])).toBe(true);
  });
});

describe("§3.2 — the EXCEPT block is the exception, not the rule", () => {
  const cards = cardsOf("1999-black-diamond");
  const rows = readCsv("1999-black-diamond-baseball.csv");
  const runsFor = (parallel: string, run: number) =>
    rows.filter((r) => r.parallel === parallel && r.run === run);

  it("reads all 120 base cards", () => {
    expect(cards.length).toBe(120);
  });

  it("derives the short set / Debuts split from the page, not a convention", () => {
    // "The last 30 cards in the base set make up a Diamond Debuts subset"
    expect(L.subsetRanges(fixture("1999-black-diamond"), 120))
      .toEqual({ "short set": [[1, 90]], debuts: [[91, 120]] });
  });

  it("Double reads /3000 on the short set (cards 1-90)", () => {
    const short = runsFor("Double", 3000).map((r) => Number(r.num)).sort((a, b) => a - b);
    expect(short.length).toBe(90);
    expect(short[0]).toBe(1);
    expect(short[89]).toBe(90);
  });

  it("Double reads /2500 on the Debuts (cards 91-120)", () => {
    const debuts = runsFor("Double", 2500).map((r) => Number(r.num)).sort((a, b) => a - b);
    expect(debuts.length).toBe(30);
    expect(debuts[0]).toBe(91);
    expect(debuts[29]).toBe(120);
  });

  it("the /1998 exception serial appears ONLY on Sosa, Griffey and McGwire", () => {
    expect(runsFor("Double", 1998).map((r) => `${r.num} ${r.player}`))
      .toEqual(["18 Sammy Sosa", "76 Ken Griffey Jr.", "80 Mark McGwire"]);
  });

  it("gives each exception player HIS OWN career-total serial, not Sosa's", () => {
    // Triple = career HR after 1998; Quadruple = 1998 season HR.
    const exceptionSerials = [273, 350, 457, 66, 56, 70];
    const byPlayer = (parallel: string) =>
      rows.filter((r) => r.parallel === parallel && exceptionSerials.includes(r.run as number))
        .map((r) => `${r.player} /${r.run}`);
    expect(byPlayer("Triple")).toEqual([
      "Sammy Sosa /273", "Ken Griffey Jr. /350", "Mark McGwire /457",
    ]);
    expect(byPlayer("Quadruple")).toEqual([
      "Sammy Sosa /66", "Ken Griffey Jr. /56", "Mark McGwire /70",
    ]);
  });

  it("never stamps an exception serial on a non-exception player", () => {
    // The original defect: /273 (Sosa's career HR) on all 120 cards.
    const bad = rows.filter((r) => [1998, 273, 350, 457, 66, 56, 70].includes(r.run as number)
      && !/Sosa|Griffey|McGwire/.test(r.player));
    expect(bad).toEqual([]);
  });

  it("emits exactly 3 rows per exception rung, never 120", () => {
    for (const [parallel, run] of [["Double", 1998], ["Triple", 273], ["Quadruple", 66]] as const) {
      expect(runsFor(parallel, run).length).toBeLessThanOrEqual(3);
    }
  });

  it("names every excepted player, surviving the period inside 'Jr.'", () => {
    // A plain [^.]+ capture stops at "Jr." and silently drops Mark McGwire.
    expect(L.exceptionPlayers(
      "Each is serial-numbered to the following production figures EXCEPT the cards of "
      + "Sammy Sosa, Ken Griffey, Jr., and Mark McGwire."))
      .toEqual(["Sammy Sosa", "Ken Griffey Jr.", "Mark McGwire"]);
  });

  it("cuts at the 'For X, Y and Z ... their' sentence, keeping the rule lines", () => {
    // Cutting at the word EXCEPT put the RULE on the exception side and lost
    // the real ladder entirely.
    const par = L.section(fixture("1999-black-diamond"), "Parallels", 2);
    const { rule, exception } = L.splitAtException(par);
    expect(L.detag(rule)).toContain("short set, 3000");
    expect(L.detag(rule)).not.toContain("serial-numbered to 1998");
    expect(L.detag(exception)).toContain("serial-numbered to 1998");
    expect(L.detag(exception)).toContain("Sosa: 273");
  });

  it("matches an exception player by surname across the page's two spellings", () => {
    // The page writes "Sammy Sosa" in the EXCEPT sentence and bare "Sosa" in
    // the per-player figures; the checklist writes "Ken Griffey Jr.".
    expect(L.matchesExceptionPlayer("Sammy Sosa", ["Sosa"])).toBe(true);
    expect(L.matchesExceptionPlayer("Ken Griffey Jr.", ["Griffey"])).toBe(true);
    expect(L.matchesExceptionPlayer("Nomar Garciaparra", ["Sosa", "Griffey", "McGwire"])).toBe(false);
  });
});

describe("blank means unknown — a print run is never guessed", () => {
  it("never coerces pack odds into a print run", () => {
    // 1997 Finest predates serial numbering: "(1:12/packs)" is a rarity
    // statement. RUN_NOTE's ":\s*(\d+)" arm read it as /12 and stamped it on
    // all 350 Refractor rows. #1571 §5.
    expect(L.hasOdds("the easiest to pull (1:12/packs)")).toBe(true);
    expect(L.hasOdds("serial-numbered to 100")).toBe(false);
  });

  it("splits a named-subset run clause into one figure per subset", () => {
    expect(L.parseSubsetRuns("(short set, 3000; Debuts, 2500)"))
      .toEqual([{ subset: "short set", run: 3000 }, { subset: "debuts", run: 2500 }]);
  });

  it("returns no subset ranges when the page does not state the split", () => {
    expect(L.subsetRanges("<p>A set with no stated subset split.</p>", 120)).toEqual({});
  });
});
