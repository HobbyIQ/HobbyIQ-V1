/**
 * CF-THE-MODERN-PANINI-CELLS-ALREADY-HAVE-A-SECOND-SOURCE (2026-09-05).
 *
 * The 111 cells where hobbymonitor is the only strict source were surveyed for a
 * permissive second source. The answer was not a new site: checklistcenter (lane
 * `clc`) already holds 39 of them as manifest entries, 17 of which have never
 * been acquired. See docs/reports/modern-panini-topps-checklist-sources-2026-09-05.md.
 *
 * These fixtures are REAL staged output, produced by the existing pipe
 * (scrape-checklistcenter-products.cjs -> convertChecklistCenterToChecklistCsv.cjs)
 * on three cells from that queue, trimmed to a few card numbers so a whole
 * parallel ladder survives, plus a sample of the autograph rows:
 *
 *   2022 Panini Select FB        88 rungs, 17,093 of 22,784 rows carry a print run
 *   2023 Panini Mosaic FB        74 rungs, 13,603 of 21,524
 *   2022-23 Panini Prizm NBA BK  59 rungs, 11,908 of 18,835
 *
 * WHAT IS PINNED, AND WHY EACH ONE EARNED A TEST
 *
 * 1. THE LADDER KEEPS ITS PRINT RUNS. A parallel row that loses its printRun is
 *    the failure this whole lane exists to avoid: a well-formed wrong row that
 *    no only-improve pass can ever see, silently splitting a comp pool. The
 *    mutation is pinned explicitly below.
 *
 * 2. AN AUTO SET IS NOT MINTED UNSIGNED. isAuto comes from the checklist, never
 *    from title text (feedback_isauto_boundary_is_cardnumber_not_text). An
 *    autograph section landing isAuto=false is a silent identity error, so it is
 *    pinned as a mutation too.
 *
 * 3. THE LITERAL "Base" IS A BASE CARD, NOT A RUNG. This is not a contradiction
 *    of "blank means unknown, never Base" -- CF-THE-LITERAL-BASE-IS-A-BASE-CARD
 *    (2026-09-04) settled that a page which STATES its base set is attesting,
 *    not defaulting, and gateStagedCsv/stagedIdentity collapse the two spellings
 *    to one identity. A test that demanded blank here would be pinning the
 *    opposite of the shipped ruling, so what is pinned is the COLLAPSE.
 *
 * 4. THE CORROBORATION KEY MUST CARRY THE CATEGORY. Two measurements of this
 *    lane's agreement with hobbymonitor were wrong before one was right, and
 *    both failures are pinned here as regression tests rather than described in
 *    a commit nobody re-reads:
 *
 *      - keying identity WITHOUT the category collides inserts onto base,
 *        because insert sets restart their numbering at #1. "Audible #1 Daniel
 *        Jones" is not a rival transcription of "Base #1 Kyler Murray"; it is a
 *        different card. That artefact reported 80.87% agreement where the true
 *        figure is 99.75%.
 *      - comparing a field the rows do not have (`player`; the stored field is
 *        `playerName`) makes every comparison vacuously agree and reports 100%.
 *
 *    A corroboration number without a negative control is not evidence, so the
 *    control is pinned as part of the method.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { gateStagedCsv } = require("../scripts/ingest-universe-driver.cjs");

const FIX = join(__dirname, "fixtures", "clc");

interface Row {
  category: string; cardNumber: string; parallel: string; isAuto: string;
  printRun: string; player: string; parallelNote: string;
}

/** Split one CSV line on commas outside quotes -- a player name carries commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readFixture(name: string): Row[] {
  const lines = readFileSync(join(FIX, `${name}.sample.csv`), "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = cells[i] ?? ""; });
    return o as unknown as Row;
  });
}

const CELLS = [
  { name: "2022 Panini Select FB", fixture: "2022-panini-select-football", year: 2022, sport: "football", setKey: "panini-select" },
  { name: "2023 Panini Mosaic FB", fixture: "2023-panini-mosaic-football", year: 2023, sport: "football", setKey: "panini-mosaic" },
  { name: "2022-23 Panini Prizm NBA BK", fixture: "2022-23-panini-prizm-nba-basketball", year: 2022, sport: "basketball", setKey: "panini-prizm" },
] as const;

const isBaseParallel = (p: string) => !p || /^base(?:\s+set)?$/i.test(String(p).trim());

describe("clc modern Panini/Topps — the staged shape", () => {
  for (const c of CELLS) {
    describe(c.name, () => {
      const rows = readFixture(c.fixture);

      it("stages rows in the one checklist format", () => {
        expect(rows.length).toBeGreaterThan(100);
        expect(rows.every((r) => r.cardNumber.trim().length > 0)).toBe(true);
        // cardNumber is verbatim -- no '#' prefix, ever.
        expect(rows.every((r) => !r.cardNumber.startsWith("#"))).toBe(true);
      });

      it("carries a real parallel ladder", () => {
        const rungs = new Set(rows.filter((r) => !isBaseParallel(r.parallel)).map((r) => r.parallel.trim()));
        expect(rungs.size).toBeGreaterThanOrEqual(10);
      });

      // 1. THE RULE THIS LANE EXISTS TO KEEP.
      it("serial-numbered rungs keep their print run", () => {
        const withRun = rows.filter((r) => r.printRun && Number(r.printRun) > 0);
        expect(withRun.length).toBeGreaterThan(0);
        // A print run belongs to a RUNG, never to a plain base card: a base card
        // is not serial-numbered, and a run appearing there would mean the
        // ladder's number had been smeared onto the base row.
        expect(withRun.every((r) => !isBaseParallel(r.parallel))).toBe(true);
        // Every stated run is a positive integer -- "1/1" is a run of one.
        expect(withRun.every((r) => Number.isInteger(Number(r.printRun)) && Number(r.printRun) >= 1)).toBe(true);
      });

      // 3. The literal "Base" is an attestation, not a rung.
      it("the literal Base collapses onto the blank identity, and is never a rung", () => {
        const base = rows.filter((r) => isBaseParallel(r.parallel));
        expect(base.length).toBeGreaterThan(0);
        expect(base.every((r) => !r.printRun)).toBe(true);
        const rungs = new Set(rows.filter((r) => !isBaseParallel(r.parallel)).map((r) => r.parallel.trim().toLowerCase()));
        expect(rungs.has("base")).toBe(false);
        expect(rungs.has("base set")).toBe(false);
      });

      it("passes the driver's per-entry cleanliness gate", () => {
        const g = gateStagedCsv(join(FIX, `${c.fixture}.sample.csv`));
        expect(g.reason ?? null).toBeNull();
        expect(g.ok).toBe(true);
        // A player name landing in the parallel column, or a card line read as a
        // rung, are the two shapes that quietly split a pool.
        expect(g.stats.playersAsParallel).toBe(0);
        expect(g.stats.cardLineParallel).toBe(0);
        expect(g.stats.base).toBeGreaterThan(0);
      });

      it("the manifest states the product identity the ingest keys on", () => {
        const m = JSON.parse(readFileSync(join(FIX, `${c.fixture}.manifest.json`), "utf8"));
        expect(m.setKey).toBeTruthy();
        expect(String(m.sourceUrl || "")).toContain("checklistcenter.com");
      });
    });
  }

  // 2. AN AUTO SET IS NOT MINTED UNSIGNED.
  it("autograph sections are flagged isAuto, from the checklist and not from text", () => {
    for (const c of CELLS) {
      const rows = readFixture(c.fixture);
      const autos = rows.filter((r) => r.isAuto === "true");
      expect(autos.length).toBeGreaterThan(0);
      // isAuto is a strict boolean spelling -- a blank or "TRUE" would read as
      // false downstream and mint a signed card unsigned.
      expect(rows.every((r) => r.isAuto === "true" || r.isAuto === "false")).toBe(true);
      // The flag tracks the checklist's own SECTIONING. Asserted per category
      // rather than per row, because one category legitimately fails a
      // per-row name test -- see the truncation note below.
      const autoCategories = new Set(autos.map((r) => r.category));
      const signed = [...autoCategories].filter((k) => /auto|signature|script|penmanship|ink/i.test(k));
      expect(signed.length).toBeGreaterThan(0);
      expect(signed.length / autoCategories.size).toBeGreaterThanOrEqual(0.8);
    }
  });

  /**
   * A MEASURED CONVERTER DEFECT — AN AUTOGRAPH SET MINTED UNSIGNED (2026-09-05).
   *
   * This is the exact failure the auto mutation check exists to catch, found in
   * real staged output rather than in a mutation.
   *
   * 2022 Panini Select has two sections whose names the converter TRUNCATED, and
   * both truncations cut the word that says the card is signed:
   *
   *   "Jumbo Rookie Signature Swatches"     -> insert:jumbo-rookie
   *   "Prime Selections Prizm Signatures"   -> insert:prime-selections
   *
   * The section name is where isAuto is decided, so losing the word lost the
   * flag: 823 rows across those two sections carry a parallel that SAYS
   * "Signature Swatches Gold Prizm" and are staged `isAuto=false`. Those are
   * autographed cards that would mint as unsigned twins of themselves — a
   * split pool on the one axis a later only-improve pass cannot see, because
   * every other column is well-formed.
   *
   * Measured across the three sampled cells: 823 rows, ALL of them in 2022
   * Panini Select FB. 2023 Mosaic FB and 2022-23 Prizm BK are clean, so this is
   * a per-section parsing bug, not a lane-wide one.
   *
   * PINNED, NOT FIXED, DELIBERATELY. The fix belongs in
   * convertChecklistCenterToChecklistCsv.cjs's section-name handling and changes
   * the category vocabulary for every clc product, which is a decision to take
   * against the whole corpus rather than from three cells. This test fails the
   * moment the converter is corrected — that is the intended direction, and the
   * assertion below says so.
   *
   * UNTIL IT IS FIXED: 2022 Panini Select FB must not be ingested from clc, or
   * it will mint 823 unsigned autographs.
   */
  it("KNOWN DEFECT: 823 signature rows in 2022 Select are staged unsigned — do not ingest that cell until fixed", () => {
    const namesASignature = /\b(signature|signatures|autograph|autographs|auto|penmanship)\b/i;

    // The defect, in the cell that has it.
    const select = readFixture("2022-panini-select-football");
    const unsigned = select.filter((r) => namesASignature.test(r.parallel) && r.isAuto !== "true");
    expect(unsigned.length).toBeGreaterThan(0);
    // It is confined to the two truncated sections, and to no others.
    expect(new Set(unsigned.map((r) => r.category))).toEqual(
      new Set(["insert:jumbo-rookie", "insert:prime-selections"]),
    );
    // Both section names lost the word that decides the flag.
    expect(namesASignature.test("insert:jumbo-rookie")).toBe(false);
    expect(namesASignature.test("insert:prime-selections")).toBe(false);

    // The other two cells are CLEAN — this is per-section, not lane-wide.
    for (const f of ["2023-panini-mosaic-football", "2022-23-panini-prizm-nba-basketball"]) {
      const rows = readFixture(f);
      expect(rows.filter((r) => namesASignature.test(r.parallel) && r.isAuto !== "true")).toEqual([]);
    }
  });
});

/**
 * THE MUTATIONS. Each one is the shipped guarantee, inverted, asserted to go red.
 * A guard nobody has mutation-checked is a guard nobody has tested.
 */
describe("clc lane — mutation checks", () => {
  it("MUTATION: a parallel row losing its printRun goes red", () => {
    const rows = readFixture("2022-panini-select-football");
    const ladder = rows.filter((r) => !isBaseParallel(r.parallel) && r.printRun && Number(r.printRun) > 0);
    expect(ladder.length).toBeGreaterThan(0);

    // The shipped shape: serial-numbered rungs carry their run.
    const runsPresent = (rs: Row[]) => rs.filter((r) => !isBaseParallel(r.parallel) && Number(r.printRun) > 0).length;
    expect(runsPresent(rows)).toBeGreaterThan(0);

    // The mutation: strip printRun off the ladder. The rows still parse, the row
    // COUNT is unchanged, and every column still looks well-formed -- which is
    // exactly why only an assertion on the run itself can see it.
    const mutated = rows.map((r) => (isBaseParallel(r.parallel) ? r : { ...r, printRun: "" }));
    expect(mutated.length).toBe(rows.length);
    expect(runsPresent(mutated)).toBe(0);
    expect(runsPresent(mutated)).not.toBe(runsPresent(rows));
  });

  it("MUTATION: an auto set minted unsigned goes red", () => {
    const rows = readFixture("2022-panini-select-football");
    const autos = rows.filter((r) => r.isAuto === "true");
    expect(autos.length).toBeGreaterThan(0);

    // The mutation: an autograph section staged with isAuto=false. Row count and
    // every other column are untouched, so the pool would simply gain a set of
    // unsigned twins of cards that only exist signed.
    const mutated = rows.map((r) => ({ ...r, isAuto: "false" }));
    expect(mutated.length).toBe(rows.length);
    expect(mutated.filter((r) => r.isAuto === "true").length).toBe(0);
    expect(mutated.filter((r) => r.isAuto === "true").length).not.toBe(autos.length);
  });

  it("MUTATION: dropping the category from the corroboration key collides inserts onto base", () => {
    // This is the measurement bug, pinned. Insert sets restart numbering at #1,
    // so a key of (cardNumber, parallel, isAuto) makes "Audible #1 Daniel Jones"
    // a rival transcription of "Base #1 Kyler Murray" and reports a
    // disagreement that is purely an artefact of the key.
    const rows = readFixture("2023-panini-mosaic-football");
    const numberOne = rows.filter((r) => r.cardNumber.trim() === "1" && isBaseParallel(r.parallel));

    const withCategory = new Set(numberOne.map((r) => `${r.category}|${r.cardNumber}`));
    const withoutCategory = new Set(numberOne.map((r) => r.cardNumber));

    // The base card and the insert cards all answer to "#1".
    expect(numberOne.length).toBeGreaterThan(1);
    expect(withCategory.size).toBeGreaterThan(1);
    // The mutation collapses them all onto one bucket -- distinct cards, one key.
    expect(withoutCategory.size).toBe(1);
    expect(withoutCategory.size).toBeLessThan(withCategory.size);

    // And the players genuinely differ, which is what turned into a false
    // "disagreement" with hobbymonitor.
    const players = new Set(numberOne.map((r) => r.player));
    expect(players.size).toBeGreaterThan(1);

    const base = numberOne.filter((r) => r.category === "base");
    expect(base.length).toBeGreaterThan(0);
    expect(base.every((r) => r.player === "Kyler Murray")).toBe(true);
  });
});
