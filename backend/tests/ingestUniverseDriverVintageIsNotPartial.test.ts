/**
 * CF-A-VINTAGE-BASE-SET-IS-NOT-PARTIAL (2026-09-04).
 *
 * The SCC-CANARY2 apply (sportscardchecklist, scope=recheck, three titles)
 * landed three complete vintage products and recorded all three `partial`:
 *
 *   1979-80 O-Pee-Chee Hockey      49 rows created, 1,403 in catalog
 *   1972 Topps Football           351 rows created, 7,309 in catalog
 *   1957 Topps Basketball          80 rows created, 4,770 in catalog
 *
 * all for the reason "base-only, no parallel ladder". Not one is incomplete: a
 * 1957, 1972 or 1979 base set HAS no parallel ladder. `partial` is not
 * terminal, so each of these tells the next pass to re-acquire a set that is
 * already complete, forever -- no re-scrape can produce a ladder the product
 * never had.
 *
 * The pins below are as much about the rule's SCOPE as its effect. A rule that
 * excused every ladderless ingest would hide the real defect it was modelled
 * on -- a modern product whose ladder our own pipe dropped -- so the two
 * halves are pinned together, and the mutation block at the bottom proves they
 * fail against a driver whose declaration has been emptied.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "..", "scripts", "ingest-universe-driver.cjs");

const {
  ladderlessByEra,
  LANES_WITH_VINTAGE_ERA_PRODUCTS,
  LANES_WITHOUT_PRINT_RUNS,
  PARALLEL_ERA_FIRST_YEAR,
} = require_(DRIVER);

/** The three products the canary actually ran, with the years they carry in
 *  backend/data/ingest-universe.json. */
const CANARY = [
  { setName: "1979-80 O-Pee-Chee Hockey", year: 1979, sport: "hockey" },
  { setName: "1972 Topps Football", year: 1972, sport: "football" },
  { setName: "1957 Topps Basketball", year: 1957, sport: "basketball" },
];

describe("the three canary products stop reporting PARTIAL", () => {
  it.each(CANARY)("$setName ($year) is ladderless by era", (entry) => {
    expect(ladderlessByEra("sportscardchecklist", entry)).toBe(true);
  });

  it("the boundary is 1990, and it is exclusive", () => {
    expect(PARALLEL_ERA_FIRST_YEAR).toBe(1990);
    expect(ladderlessByEra("sportscardchecklist", { year: 1989 })).toBe(true);
    // 1990 itself is NOT vintage. The refractor era opens with 1993 Topps
    // Finest; 1990 is the conservative side of that line, so a 1990-1992
    // product with no ladder still reports PARTIAL rather than closing quietly.
    expect(ladderlessByEra("sportscardchecklist", { year: 1990 })).toBe(false);
    expect(ladderlessByEra("sportscardchecklist", { year: 1993 })).toBe(false);
  });
});

describe("a modern product that LOST its ladder is still flagged", () => {
  it("the same lane at a modern year keeps the flat expectation", () => {
    // sportscardchecklist spans 1933-2009. Its 2000s cells sit squarely in the
    // era when parallels exist, which is why this is an ERA rule and not a
    // lane rule -- declaring the whole lane would excuse a 2003 Topps Chrome
    // scrape that simply lost its refractor ladder.
    expect(ladderlessByEra("sportscardchecklist", { year: 2003, setName: "2003 Topps Chrome Baseball" })).toBe(false);
    expect(ladderlessByEra("sportscardchecklist", { year: 2009 })).toBe(false);
  });

  it("a lane that never opted in is judged at every year", () => {
    for (const lane of ["beckett", "clc", "bcp", "hobbymonitor", "checklistinsider", "tcgdexja"]) {
      expect(ladderlessByEra(lane, { year: 1972 })).toBe(false);
    }
  });

  it("only sportscardchecklist has opted in", () => {
    expect([...LANES_WITH_VINTAGE_ERA_PRODUCTS]).toEqual(["sportscardchecklist"]);
  });
});

describe("an absent year does not buy the exemption", () => {
  it.each([undefined, null, "", 0, NaN, "not-a-year"])("year %p is not vintage", (year) => {
    // A year the manifest never carried must fall through to the flat
    // expectation, not silently close a gap.
    expect(ladderlessByEra("sportscardchecklist", { year })).toBe(false);
  });

  it("a missing entry object is not vintage either", () => {
    expect(ladderlessByEra("sportscardchecklist", undefined)).toBe(false);
    expect(ladderlessByEra("sportscardchecklist", {})).toBe(false);
  });
});

describe("the rule narrows the ladder expectation and NOTHING else", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("only the ladder half of `incomplete` is gated -- print runs are untouched", () => {
    expect(src).toContain("const ladderExpected = !ladderlessByEra(lane, entry);");
    expect(src).toContain("const incomplete = (ladderExpected && gate.stats.ladder === 0)");
    expect(src).toContain("|| (printRunsExpected && gate.stats.withPrintRun === 0);");
  });

  it("it is a separate declaration from LANES_WITHOUT_PRINT_RUNS, not a widening", () => {
    // Right guard, right scope: editing the print-run set would have moved a
    // different consumer with it.
    expect([...LANES_WITHOUT_PRINT_RUNS]).toEqual(["tcgdexja"]);
    expect(LANES_WITHOUT_PRINT_RUNS.has("sportscardchecklist")).toBe(false);
    expect(LANES_WITH_VINTAGE_ERA_PRODUCTS.has("tcgdexja")).toBe(false);
  });

  it("FAILED still outranks the exemption -- zero rows and truncation come first", () => {
    // The era says a product has no ladder. It never says our pipe may lose
    // rows, so the truncated/zero branches must still be tested BEFORE it.
    const zero = src.indexOf("} else if (after === 0) {");
    const truncated = src.indexOf("} else if (truncated) {");
    const incomplete = src.indexOf("} else if (incomplete) {");
    expect(zero).toBeGreaterThan(-1);
    expect(zero).toBeLessThan(truncated);
    expect(truncated).toBeLessThan(incomplete);
  });

  it("an INGESTED vintage set says WHY it carries no ladder", () => {
    // A base-only set reporting INGESTED must not read like a ladder that was
    // scraped and silently dropped.
    expect(src).toContain("base-only is the shape of a pre-");
  });
});

describe("the pins fail against a driver whose declaration is emptied", () => {
  it("with LANES_WITH_VINTAGE_ERA_PRODUCTS empty, all three canary sets are PARTIAL again", () => {
    const mutated = fs.readFileSync(DRIVER, "utf8").replace(
      'const LANES_WITH_VINTAGE_ERA_PRODUCTS = new Set(["sportscardchecklist"]);',
      "const LANES_WITH_VINTAGE_ERA_PRODUCTS = new Set([]);",
    );
    expect(mutated).toContain("new Set([]);");

    const tmp = path.join(HERE, `.mutated-vintage-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const m = require_(tmp);
      for (const entry of CANARY) {
        expect(m.ladderlessByEra("sportscardchecklist", entry)).toBe(false);
      }
      // ...and the shipped driver disagrees with the mutant on exactly these.
      for (const entry of CANARY) {
        expect(ladderlessByEra("sportscardchecklist", entry))
          .not.toBe(m.ladderlessByEra("sportscardchecklist", entry));
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("with the boundary moved to 1900, the canary sets are PARTIAL again", () => {
    const mutated = fs.readFileSync(DRIVER, "utf8").replace(
      "const PARALLEL_ERA_FIRST_YEAR = 1990;",
      "const PARALLEL_ERA_FIRST_YEAR = 1900;",
    );
    const tmp = path.join(HERE, `.mutated-year-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const m = require_(tmp);
      for (const entry of CANARY) {
        expect(m.ladderlessByEra("sportscardchecklist", entry)).toBe(false);
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
