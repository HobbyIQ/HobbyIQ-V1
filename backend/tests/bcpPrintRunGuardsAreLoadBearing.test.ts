/**
 * CF-THE-SURVIVING-MUTANTS (#1576 refutation, Drew 2026-08-30).
 *
 * The #1576 mutation run killed most of the print-run scoping guards but left
 * THREE alive: with each one deleted from the shipped scraper, every existing
 * test still passed. A guard no test can kill is a guard the next refactor
 * removes and nobody notices — and per `only-improve hides well-formed wrong
 * rows`, the row it then writes is confidently wrong and invisible to every
 * later sweep.
 *
 * The three survivors, each pinned below:
 *
 *   1. `if (hasOdds(note)) n = null;` at the <li> call site — but MEASURED
 *      2026-08-30, this one is UNKILLABLE ALONE: putFor carries a second,
 *      redundant odds guard, so deleting either one changes no output for any
 *      input, on this branch or on unmodified main. The pin below therefore
 *      asserts the PAIR, which is genuinely load-bearing: with both gone,
 *      RUN_NOTE's ":\s*(\d+)" arm reads "1:12" as /12 and stamps it on the
 *      rows. See that describe block for the measurement.
 *
 *   2. `if (requireRange && !cardRange) run = null;`
 *      A body that states its runs PER CARD RANGE must not hand a set-wide run
 *      to a rung whose own range did not parse. #1571 §3.1.
 *
 *   3. `if (figures > 1 && !cardRange) n = null;`
 *      "Blue (Class 1, ... 150; Class 2, ... 99; Class 3, ... 50)" states THREE
 *      runs. RUN_NOTE returns the first, which stamps Class 1's number on every
 *      card — the §3.1 cross-join in a different costume.
 *
 * The refuter prescribed a SECTION-5 PRODUCT FIXTURE, so `1997-finest` is the
 * real baseballcardpedia page (fetched 2026-08-30): the §5 subject itself, with
 * genuine pack odds inside a Parallels section and no serial numbering anywhere.
 *
 * Mutant 1 is asserted against the EMITTED CSV, driving the committed emission
 * path. Re-implementing a guard inside the test would pin nothing — that is
 * precisely the mistake that let mutant 1 survive the first time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));

const OUT = path.resolve(
  fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "bcp-guard-pin-")),
);
{
  const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
  execFileSync(process.execPath, [
    path.resolve(__dirname, "helpers/runBcpLaddersOverFixtures.cjs"), OUT,
    "1997_Finest=1997-finest",
  ], { stdio: "pipe" });
}

type Row = { num: string; parallel: string; run: number | null; rarity: string };

/** category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity */
function readCsv(file: string): Row[] {
  const text = fs.readFileSync(path.join(OUT, file), "utf8").trim().split("\n").slice(1);
  const rows: Row[] = [];
  for (const line of text) {
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
    rows.push({ num: f[1], parallel: f[2], run: f[4] === "" ? null : Number(f[4]), rarity: f[7] ?? "" });
  }
  return rows;
}

const refractors = () => readCsv("1997-finest-baseball--refractors.csv");

describe("mutant 1 — the odds guards, together, on the <li> path", () => {
  /**
   * MEASURED 2026-08-30 — the refutation's premise needs correcting, so this
   * pin states what is true rather than what was assumed.
   *
   * There are TWO odds guards on this path, not one:
   *
   *   parseLadder <li> loop   `if (hasOdds(note)) n = null;`
   *   putFor                  `if (run != null && hasOdds(note)) run = null;`
   *
   * They are MUTUALLY REDUNDANT. Deleting either alone changes no output for
   * any input tried, on this branch or on unmodified main — the survivor blanks
   * the run. That, and not a missing assertion, is why the single-line mutant
   * survived #1576: it is unkillable by construction, because it is defence in
   * depth. No test can kill it, and claiming one does would be false.
   *
   * What IS load-bearing is the PAIR: with both deleted, RUN_NOTE's ":\s*(\d+)"
   * arm reads "1:12" as a print run and writes /12 — the §5 defect exactly.
   * These pins go red when both are removed. A refactor that collapses the two
   * guards into one stays green; one that removes the protection is caught.
   *
   * Note the fixture's own odds sit in a <p> paragraph, so the emitted-CSV
   * assertions below cover the product end-to-end while the parser assertions
   * drive the <li> note path where the guards actually fire.
   */
  const parLadder = (li: string) =>
    L.parseLadder(`<ul>${li}</ul>`, new Set(), {})
      .find((r: { name: string }) => r.name === "Bronze Refractor");

  it("blanks the run when a rung's own note states pack odds", () => {
    // The form that reaches the guards: odds inside the rung's parenthetical.
    // With BOTH guards deleted these read 12.
    expect(parLadder("<li>Bronze Refractor (1:12 packs)</li>").printRun).toBeNull();
    expect(parLadder("<li>Bronze Refractor (pull rate 1:12)</li>").printRun).toBeNull();
  });

  it("keeps the odds statement as rarity rather than dropping it", () => {
    // CF-RARITY-IS-NOT-A-PRINT-RUN: refused as a run, retained as description.
    expect(parLadder("<li>Bronze Refractor (1:12 packs)</li>").rarity).toBe("1:12 packs");
  });

  it("still reads a genuine serial in the same shape of note", () => {
    // The guards must fire on odds only; a real serial must survive them.
    expect(parLadder("<li>Bronze Refractor (serial-numbered to 150)</li>").printRun).toBe(150);
  });

  it("never writes a print run for a rung whose only figure is pack odds", () => {
    // The page: "the Bronze Refractors are the easiest to pull (1:12/packs),
    // Silver Refractors were tough (1:48), and Gold Refractors were the
    // toughest (1:288)". 1997 Finest predates serial numbering entirely.
    const rows = refractors();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.run === null)).toBe(true);
  });

  it("specifically never writes /12, /48 or /288 — the odds denominators", () => {
    const leaked = refractors().filter((r) => [12, 48, 288].includes(r.run as number));
    expect(leaked).toEqual([]);
  });

  it("emits ZERO non-null print runs across every scope of a pre-serial product", () => {
    // Widen past one file: the mutant leaks through any scope's <li> loop.
    const all = fs.readdirSync(OUT).filter((f) => f.endsWith(".csv")).flatMap((f) => readCsv(f));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((r) => r.run !== null)).toEqual([]);
  });

  it("keeps the refused figure as rarity instead of dropping it", () => {
    // CF-RARITY-IS-NOT-A-PRINT-RUN: the guard blanks printRun, and the page's
    // own statement survives in the descriptive column rather than being lost.
    const rows = refractors();
    expect(rows.every((r) => r.rarity === "1:12/packs")).toBe(true);
  });
});

describe("mutant 2 — requireRange with no cardRange must blank the run", () => {
  /**
   * `hasRangeClause(body)` says "this body states its runs per card range".
   * When it does, a rung whose OWN range failed to parse must not inherit the
   * body's set-wide figure — that is how "Radiance Heroes of the Game /100"
   * reached card #1. Deleting the line restores the inheritance.
   */
  const ranged = (li: string) =>
    L.parseLadder(`<ul><li>Alpha (cards 1-30; serial-numbered to 2500)</li>${li}</ul>`,
      new Set(), { requireRange: true });

  it("blanks a rung that names a run but no range, inside a ranged body", () => {
    const rungs = ranged("<li>Beta (serial-numbered to 100)</li>");
    const beta = rungs.find((r: { name: string }) => r.name === "Beta");
    expect(beta).toBeDefined();
    expect(beta.printRun).toBeNull();
  });

  it("still keeps the run of a rung that DOES name its range", () => {
    // The guard must blank the unscoped rung only — not disarm the whole body.
    const alpha = ranged("").find((r: { name: string }) => r.name === "Alpha");
    expect(alpha.printRun).toBe(2500);
    expect(alpha.cardRange).toEqual([[1, 30]]);
  });

  it("leaves the run alone when the body states no range clause at all", () => {
    // requireRange is false for a genuinely set-wide ladder; blanking there
    // would destroy real data, so the guard must stay conditional.
    const rungs = L.parseLadder("<ul><li>Beta (serial-numbered to 100)</li></ul>", new Set(), {});
    expect(rungs.find((r: { name: string }) => r.name === "Beta").printRun).toBe(100);
  });

  it("hasRangeClause is what arms it, and it reads the page not a convention", () => {
    expect(L.hasRangeClause("<li>Alpha (cards 1-30; serial-numbered to 2500)</li>")).toBe(true);
    expect(L.hasRangeClause("<li>Alpha (serial-numbered to 2500)</li>")).toBe(false);
  });
});

describe("mutant 3 — more than one figure and no range must blank the run", () => {
  /**
   * "Blue (Class 1, serial-numbered to 150; Class 2, ... 99; Class 3, ... 50)".
   * RUN_NOTE returns 150. Writing it stamps Class 1's serial on every card of
   * the set; the scope is real but is not expressible in card numbers, so the
   * honest value is blank with the page's wording kept in the note.
   */
  const multi = (note: string) =>
    L.parseLadder(`<ul><li>Blue ${note}</li></ul>`, new Set(), {})
      .find((r: { name: string }) => r.name === "Blue");

  it("blanks a three-figure clause that names no card range", () => {
    const blue = multi("(Class 1, serial-numbered to 150; Class 2, serial-numbered to 99; Class 3, serial-numbered to 50)");
    expect(blue).toBeDefined();
    expect(blue.printRun).toBeNull();
  });

  it("keeps the rung itself, and its note, rather than dropping the row", () => {
    // Blanking the run must not delete the rung: the parallel exists.
    const blue = multi("(Class 1, serial-numbered to 150; Class 2, serial-numbered to 99; Class 3, serial-numbered to 50)");
    expect(blue.name).toBe("Blue");
    expect(String(blue.note)).toContain("150");
    expect(String(blue.note)).toContain("50");
  });

  it("still reads a SINGLE-figure clause as a real print run", () => {
    // The guard fires on figures > 1 only; one figure is unambiguous.
    expect(multi("(serial-numbered to 150)").printRun).toBe(150);
  });

  it("keeps a multi-figure clause whose range IS stated", () => {
    // figures > 1 AND a card range means the scope resolved, so the run stands.
    const blue = multi("(cards 1-30; serial-numbered to 150; 99 copies)");
    expect(blue.cardRange).toEqual([[1, 30]]);
    expect(blue.printRun).toBe(150);
  });
});

describe("CF-RARITY-IS-NOT-A-PRINT-RUN — the descriptive companion", () => {
  it("reads pack odds as rarity and never as a run", () => {
    expect(L.extractRarity("the easiest to pull (1:12/packs)")).toBe("1:12/packs");
    expect(L.extractRarity("inserted 1:24 packs")).toBe("inserted 1:24 packs");
  });

  it("reads a Tiffany-style set-production figure as rarity", () => {
    expect(L.extractRarity("Topps produced approximately 30,000 sets of this Tiffany edition."))
      .toBe("produced approximately 30,000 sets");
    expect(L.extractRarity("approximately 30,000 sets were produced"))
      .toBe("approximately 30,000 sets were produced");
  });

  it("never reads a SERIAL statement as rarity — printRun owns those", () => {
    expect(L.extractRarity("serial-numbered to 100")).toBeNull();
    expect(L.extractRarity("numbered to 250 copies")).toBeNull();
    expect(L.extractRarity("Gold (one-of-one)")).toBeNull();
    expect(L.extractRarity("short set, 3000; Debuts, 2500")).toBeNull();
  });

  it("refuses an implausibly small 'set production' figure rather than mislabel it", () => {
    // Below a plausible factory-set run the sentence is far more likely a
    // mis-caught serial. Blank is unknown.
    expect(L.extractRarity("only 500 sets produced")).toBeNull();
  });

  it("returns the page's OWN WORDS so the figure stays auditable", () => {
    expect(L.extractRarity("Bronze were the easiest to pull (1:12/packs), Silver tough"))
      .toBe("1:12/packs");
  });
});
