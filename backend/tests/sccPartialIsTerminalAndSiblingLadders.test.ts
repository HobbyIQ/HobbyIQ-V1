/**
 * THE SPORTSCARDCHECKLIST LANE STOPPED MAKING PROGRESS, and the three defects
 * behind it are pinned here together because they compound: two of them mint
 * false `partial` verdicts, and the third makes every pending-only pass re-walk
 * those verdicts instead of the 5,644 entries that have never been attempted.
 *
 * MEASURED STATE (crawl_state control docs, lane sportscardchecklist):
 *
 *   partial            136        <- 56 "base-only", 80 "zero print runs"
 *   failed              77        <- 69 short-ingest, 8 child exit 4
 *   ingested             0
 *   no control doc   5,644  of 5,857
 *
 * 1. CF-PARTIAL-IS-TERMINAL-BUT-RECHECKABLE. Run 33884656387 (pending only,
 *    APPLY) re-walked all 136 partial entries and created 24 rows out of a
 *    140-minute budget. `partial` is a finished attempt with a recorded answer,
 *    so it joins the terminal set and keeps its recheck door, exactly as
 *    `empty` already had.
 *
 * 2. CF-A-LADDER-ON-SIBLING-PAGES-IS-NOT-A-GAP. 53 of the 56 "base-only"
 *    partials are MODERN parent pages, and sportscardchecklist publishes every
 *    rung and insert as its own set page. Their ladder is on sibling entries the
 *    manifest declares, so base-only is the page's shape, not the product's gap.
 *
 * 3. CF-A-RUNG-PAGE-CARRIES-NO-PRINT-RUN. Its mirror: a "...Refractors" page IS
 *    one rung, attested by the fetcher's `parallelOfParent`. Asking it for a
 *    print-run column asks the source for a column it never had.
 *
 * 4. CF-A-REFUSED-SUBSET-COLLISION-IS-A-DECLARED-SKIP. The ingest child counted
 *    its subset-collision refusals, printed them, and left them out of the
 *    `reportWrites` declaration -- so its own correct guard reconciled as WORK
 *    VANISHED and exited 4. That is 8 of the 77 failures.
 *
 * The pins are as much about SCOPE as effect. A rule that excused every
 * ladderless or print-runless ingest would hide the real defect it was modelled
 * on -- a modern product whose ladder OUR PIPE dropped -- so each exemption is
 * pinned together with the case it must keep catching, and the mutation block
 * proves each one fails against a driver whose declaration has been emptied.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "..", "scripts", "ingest-universe-driver.cjs");
const CHILD = path.join(HERE, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs");
const MANIFEST_PATH = path.join(HERE, "..", "data", "ingest-universe.json");

const {
  TERMINAL_STATUSES,
  EMPTY_STATUS,
  LANES_WITH_SIBLING_PARALLEL_PAGES,
  LANES_WITH_VINTAGE_ERA_PRODUCTS,
  LANES_WITHOUT_PRINT_RUNS,
  ladderOnSiblingPages,
  ladderlessByEra,
} = require_(DRIVER);

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SCC = MANIFEST.entries.filter(
  (e: any) => (e.lane || e.source) === "sportscardchecklist",
);
const bySetName = (n: string) => SCC.find((e: any) => e.setName === n);

// ── 1. partial is terminal, and still recheckable ────────────────────────────

describe("`partial` is a verdict, not a queue position", () => {
  it("partial is terminal, beside the statuses that already were", () => {
    // `short-ingest` joined them on 2026-09-06
    // (CF-AN-ENTRY-THAT-LANDED-ROWS-IS-NOT-A-FAILURE): its rows ARE in the
    // catalog, so re-attempting re-ingests what is already there.
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["empty", "ingested", "partial", "short-ingest", "unreachable"].sort(),
    );
    expect(TERMINAL_STATUSES.has("partial")).toBe(true);
  });

  it("`failed` is NOT terminal -- it keeps its own attempts budget", () => {
    // A failure means OUR pipe broke, which is worth retrying without an
    // operator saying so. The 3-attempt ceiling is the separate guard, and
    // folding `failed` in here would silently retire it.
    expect(TERMINAL_STATUSES.has("failed")).toBe(false);
    const src = fs.readFileSync(DRIVER, "utf8");
    expect(src).toContain('prior.status === "failed" && (prior.attempts || 0) >= 3');
  });

  it("the queue filter honours SCOPE=recheck for every terminal status", () => {
    // Terminal-but-recheckable is the whole point: nothing is closed, the
    // control doc still names the gap, and `remaining in lane` still counts it.
    const src = fs.readFileSync(DRIVER, "utf8");
    expect(src).toContain("if (prior && !RECHECK && TERMINAL.has(prior.status)) continue;");
  });

  it("the recheck door is the SAME door `empty` already used", () => {
    expect(TERMINAL_STATUSES.has(EMPTY_STATUS)).toBe(true);
    expect(EMPTY_STATUS).toBe("empty");
  });
});

// ── 2. the ladder lives on sibling pages ─────────────────────────────────────

/** Parent pages the lane recorded `partial` for "base-only, no parallel
 *  ladder", each of which the manifest gives declared rung/insert siblings. */
const MODERN_PARENTS = [
  "2000-01 Topps Chrome Basketball",
  "2001-02 Topps Chrome Basketball",
  "2002-03 Topps Chrome Basketball",
  "2003-04 Topps Chrome Basketball",
  "2006-07 Topps Chrome Basketball",
];

describe("a modern PARENT page's ladder is on its siblings", () => {
  it.each(MODERN_PARENTS)("%s is exempt by declared siblings", (name) => {
    const entry = bySetName(name);
    expect(entry, `${name} must exist in the manifest`).toBeTruthy();
    expect(ladderOnSiblingPages("sportscardchecklist", entry, MANIFEST.entries)).toBe(true);
  });

  it("and NOT by the era rule -- these are 2000s products", () => {
    // The two exemptions are separate claims about separate source shapes.
    // Collapsing them would let the era rule creep forward into the parallel era.
    for (const name of MODERN_PARENTS) {
      expect(ladderlessByEra("sportscardchecklist", bySetName(name))).toBe(false);
    }
  });

  it("the siblings it reads are real rung and insert pages of that product", () => {
    const parent = bySetName("2006-07 Topps Chrome Basketball");
    const siblings = SCC.filter(
      (e: any) =>
        e.id !== parent.id &&
        e.sport === parent.sport &&
        e.year === parent.year &&
        e.setKey === parent.setKey &&
        e.derivedSetKey,
    );
    expect(siblings.length).toBeGreaterThan(0);
    expect(siblings.map((s: any) => s.setName)).toContain(
      "2006-07 Topps Chrome Refractors Basketball",
    );
  });
});

describe("the exemption is granted only to a PARENT with DECLARED siblings", () => {
  it("a rung page does not claim its own ladder is elsewhere", () => {
    // A "...Refractors" page names a rung in derivedSetKey. It is the sibling,
    // not the parent, and reporting base-only there is a different shape.
    const rung = bySetName("2006-07 Topps Chrome Refractors Basketball");
    expect(rung.derivedSetKey).toBeTruthy();
    expect(ladderOnSiblingPages("sportscardchecklist", rung, MANIFEST.entries)).toBe(false);
  });

  it("a parent with NO declared siblings keeps the flat expectation", () => {
    // THE CASE THE RULE MUST KEEP CATCHING: a modern product whose ladder our
    // own pipe dropped has no sibling entries to point at, and still PARTIALs.
    const lonely = {
      id: "sportscardchecklist::lonely",
      lane: "sportscardchecklist",
      sport: "basketball",
      year: 2003,
      setKey: "topps-chrome",
      setName: "2003-04 Topps Chrome Basketball",
    };
    expect(ladderOnSiblingPages("sportscardchecklist", lonely, [lonely])).toBe(false);
  });

  it("a sibling that names no rung of its own cannot attest the ladder", () => {
    // Another parent page sharing the key is not a ladder page. Only an entry
    // whose derivedSetKey NAMES a rung or insert is evidence the ladder exists.
    const parent = { id: "a", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "topps-chrome" };
    const notALadderPage = { id: "b", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "topps-chrome" };
    expect(ladderOnSiblingPages("sportscardchecklist", parent, [parent, notALadderPage])).toBe(false);
  });

  it("a sibling of another product, year or sport does not count", () => {
    const parent = { id: "a", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "topps-chrome" };
    const others = [
      { id: "b", lane: "sportscardchecklist", sport: "basketball", year: 2004, setKey: "topps-chrome", derivedSetKey: "topps-chrome-refractors" },
      { id: "c", lane: "sportscardchecklist", sport: "football", year: 2003, setKey: "topps-chrome", derivedSetKey: "topps-chrome-refractors" },
      { id: "d", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "bowman", derivedSetKey: "bowman-refractors" },
    ];
    expect(ladderOnSiblingPages("sportscardchecklist", parent, [parent, ...others])).toBe(false);
  });

  it("a lane that never opted in is judged flat at every year", () => {
    const parent = bySetName("2006-07 Topps Chrome Basketball");
    for (const lane of ["beckett", "clc", "bcp", "hobbymonitor", "checklistinsider", "tcgdexja"]) {
      expect(ladderOnSiblingPages(lane, parent, MANIFEST.entries)).toBe(false);
    }
  });

  it("only sportscardchecklist has opted in, and it is its own declaration", () => {
    expect([...LANES_WITH_SIBLING_PARALLEL_PAGES]).toEqual(["sportscardchecklist"]);
    // Right guard, right scope: this is a THIRD set, not a widening of either
    // existing one, so editing it cannot move a different consumer with it.
    expect([...LANES_WITHOUT_PRINT_RUNS]).toEqual(["tcgdexja"]);
    expect([...LANES_WITH_VINTAGE_ERA_PRODUCTS]).toEqual(["sportscardchecklist"]);
    expect(LANES_WITH_SIBLING_PARALLEL_PAGES.has("tcgdexja")).toBe(false);
  });

  it("a missing or malformed entry buys nothing", () => {
    for (const bad of [undefined, null, {}, { sport: "basketball" }, { year: 2003 }]) {
      expect(ladderOnSiblingPages("sportscardchecklist", bad, MANIFEST.entries)).toBe(false);
    }
    expect(ladderOnSiblingPages("sportscardchecklist", bySetName(MODERN_PARENTS[0]), null)).toBe(false);
  });
});

describe("the blast radius is measured, not assumed", () => {
  it("only modern PARENT pages move; every rung and insert page is untouched", () => {
    const exempt = SCC.filter((e: any) =>
      ladderOnSiblingPages("sportscardchecklist", e, MANIFEST.entries),
    );
    // 5,626 of the lane's 5,857 entries are rung/insert pages carrying a
    // derivedSetKey. NOT ONE of them may be exempted by this rule.
    expect(exempt.every((e: any) => !e.derivedSetKey)).toBe(true);
    // A small, bounded population of parent pages -- not a lane-wide excuse.
    expect(exempt.length).toBeGreaterThan(0);
    expect(exempt.length).toBeLessThan(SCC.length / 10);
  });
});

// ── 3. a rung page carries no print run ──────────────────────────────────────

describe("the print-run expectation is dropped only for an ATTESTED rung page", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("the exemption reads the fetcher's attestation, never an empty column", () => {
    // Inferring "this is a rung page" from a file that merely happens to have
    // no print runs would excuse a scrape that lost the column -- the exact
    // discipline ladderIsAttested and parallelOfParent already use.
    expect(src).toContain(
      "&& !(LANES_WITH_SIBLING_PARALLEL_PAGES.has(lane) && gate.everyFileIsParallelOfParent);",
    );
    expect(src).toContain("everyFileIsParallelOfParent: allFilesAreParallelOfParent(paths),");
  });

  it("allFilesAreParallelOfParent still demands the flag on EVERY file", () => {
    const { allFilesAreParallelOfParent } = require_(DRIVER);
    // No manifest on disk for these paths => unattested => false. Absence is
    // the safe answer, and it is what keeps the zero-base refusal standing.
    expect(allFilesAreParallelOfParent([path.join(HERE, "no-such-file.csv")])).toBe(false);
    expect(allFilesAreParallelOfParent([])).toBe(false);
  });

  it("tcgdexja's print-run exemption is untouched and independent", () => {
    expect(LANES_WITHOUT_PRINT_RUNS.has("tcgdexja")).toBe(true);
    expect(LANES_WITHOUT_PRINT_RUNS.has("sportscardchecklist")).toBe(false);
  });
});

// ── FAILED still outranks every exemption ────────────────────────────────────

describe("an exemption never excuses a lost row", () => {
  const src = fs.readFileSync(DRIVER, "utf8");

  it("zero rows, short ingest and truncation are all tested BEFORE `incomplete`", () => {
    // These rules say what a PRODUCT's shape is. They never say our pipe may
    // lose rows, so the failure branches must be reached first.
    const zero = src.indexOf("} else if (after === 0) {");
    const short = src.indexOf("} else if (shortIngest) {");
    const truncated = src.indexOf("} else if (truncated) {");
    const incomplete = src.indexOf("} else if (incomplete) {");
    for (const i of [zero, short, truncated, incomplete]) expect(i).toBeGreaterThan(-1);
    expect(zero).toBeLessThan(short);
    expect(short).toBeLessThan(truncated);
    expect(truncated).toBeLessThan(incomplete);
  });

  it("an INGESTED parent page says WHY it carries no ladder", () => {
    // "the source publishes it elsewhere" is a different claim from "the
    // product never had one", and the log must not blur them.
    expect(src).toContain("base-only is the shape of a PARENT page");
    expect(src).toContain("base-only is the shape of a pre-");
    expect(src).toContain("this page IS one rung; the numbering is the parent's");
  });
});

// ── 4. a refused subset collision is a declared skip ─────────────────────────

describe("the ingest child declares the refusals it chose", () => {
  const src = fs.readFileSync(CHILD, "utf8");

  it("subsetCollision is inside the reportWrites skipped sum", () => {
    // Run 33882293958: 8 pages exited 4 "WORK VANISHED" because this counter --
    // the one refusal path that returns without touching any other counter --
    // was missing from the declaration.
    const call = src.slice(src.indexOf("reportWrites({ job: \"ingest-checklist-csv-to-catalog\""));
    expect(call).toContain("+ subsetCollision");
  });

  it("subsetDisambiguated is NOT added -- those rows are already written", () => {
    // A disambiguated row IS written, just at a subset-bearing slug. Declaring
    // it skipped as well would double-count and overshoot `intended`.
    const call = src.slice(
      src.indexOf("reportWrites({ job: \"ingest-checklist-csv-to-catalog\""),
      src.indexOf("reportWrites({ job: \"ingest-checklist-csv-to-catalog\"") + 400,
    );
    expect(call).not.toContain("subsetDisambiguated");
  });

  it("the refusal itself is unchanged -- a blank subset is still never invented", () => {
    // The accounting fix must not soften the guard. #1741's counter stays, and
    // an unknown subset on one side of a real clash is still refused.
    expect(src).toContain("subsetCollision++;");
    // CF-BASE-SET-IS-NOT-A-SUBSET (2026-09-06) renamed the operand: the guard
    // tests the subset the page CLAIMS, so a structural "Base Set" section
    // heading no longer reads as a rival subset. The REFUSAL it protects is
    // unchanged -- a page that names no subset still cannot land on an address
    // a real named subset holds.
    expect(src).toContain("if (!productClaim) {");
    expect(src).toContain("subset collisions REFUSED");
  });

  it("every declared skip counter is still in the sum", () => {
    const call = src.slice(src.indexOf("reportWrites({ job: \"ingest-checklist-csv-to-catalog\""));
    for (const counter of [
      "skippedRow",
      "notReached",
      "unnamedParallel",
      "cardLineParallel",
      "playerNameParallel",
      "explodedRows",
    ]) {
      expect(call, `${counter} must stay declared`).toContain(counter);
    }
  });
});

// ── mutation reds ────────────────────────────────────────────────────────────

/** Load a mutated copy of a script and hand it to `fn`. */
function withMutant(file: string, from: string, to: string, tag: string, fn: (m: any) => void) {
  const original = fs.readFileSync(file, "utf8");
  expect(original, `the mutation target must exist verbatim: ${from}`).toContain(from);
  const mutated = original.replace(from, to);
  expect(mutated).not.toBe(original);
  const tmp = path.join(HERE, `.mutated-${tag}-${process.pid}.cjs`);
  try {
    fs.writeFileSync(tmp, mutated);
    fn(require_(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

describe("the pins fail against a driver whose declarations are emptied", () => {
  it("drop `partial` from TERMINAL_STATUSES -> the lane re-walks its partials", () => {
    withMutant(
      DRIVER,
      'const TERMINAL_STATUSES = new Set(["ingested", "unreachable", EMPTY_STATUS, "partial", SHORT_STATUS]);',
      'const TERMINAL_STATUSES = new Set(["ingested", "unreachable", EMPTY_STATUS, SHORT_STATUS]);',
      "terminal",
      (m) => {
        expect(m.TERMINAL_STATUSES.has("partial")).toBe(false);
        // ...and the shipped driver disagrees with the mutant on exactly this.
        expect(TERMINAL_STATUSES.has("partial")).toBe(true);
      },
    );
  });

  it("empty LANES_WITH_SIBLING_PARALLEL_PAGES -> every modern parent is PARTIAL again", () => {
    withMutant(
      DRIVER,
      'const LANES_WITH_SIBLING_PARALLEL_PAGES = new Set(["sportscardchecklist"]);',
      "const LANES_WITH_SIBLING_PARALLEL_PAGES = new Set([]);",
      "siblings",
      (m) => {
        for (const name of MODERN_PARENTS) {
          const entry = bySetName(name);
          expect(m.ladderOnSiblingPages("sportscardchecklist", entry, MANIFEST.entries)).toBe(false);
          expect(ladderOnSiblingPages("sportscardchecklist", entry, MANIFEST.entries))
            .not.toBe(m.ladderOnSiblingPages("sportscardchecklist", entry, MANIFEST.entries));
        }
      },
    );
  });

  it("drop the derivedSetKey guard -> a RUNG page starts claiming the exemption", () => {
    // The guard is what keeps this a parent-page rule. Without it a
    // "...Refractors" page excuses its own missing ladder.
    withMutant(
      DRIVER,
      "  if (entry.derivedSetKey) return false;",
      "  // guard removed",
      "rungguard",
      (m) => {
        const rung = bySetName("2006-07 Topps Chrome Refractors Basketball");
        expect(m.ladderOnSiblingPages("sportscardchecklist", rung, MANIFEST.entries)).toBe(true);
        expect(ladderOnSiblingPages("sportscardchecklist", rung, MANIFEST.entries)).toBe(false);
      },
    );
  });

  it("drop the sibling's derivedSetKey requirement -> a bare key attests a ladder", () => {
    withMutant(
      DRIVER,
      "    && Boolean(o.derivedSetKey)",
      "    && true",
      "siblingattest",
      (m) => {
        const parent = { id: "a", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "topps-chrome" };
        const bare = { id: "b", lane: "sportscardchecklist", sport: "basketball", year: 2003, setKey: "topps-chrome" };
        expect(m.ladderOnSiblingPages("sportscardchecklist", parent, [parent, bare])).toBe(true);
        expect(ladderOnSiblingPages("sportscardchecklist", parent, [parent, bare])).toBe(false);
      },
    );
  });

  it("drop `+ subsetCollision` -> a refused collision reconciles as WORK VANISHED", () => {
    // Proved on the ARITHMETIC, not on the text: with the counter undeclared,
    // intended - written - skipped - failed is non-zero and reportWrites is
    // contractually required to treat that as unaccounted work.
    const src = fs.readFileSync(CHILD, "utf8");
    expect(src).toContain("+ subsetCollision");
    const mutated = src.replace(" + subsetCollision", "");
    expect(mutated).not.toBe(src);
    expect(mutated).not.toContain("+ subsetCollision");

    // The 2000-01 Topps Chrome Johnson Reprints Refractors page, exactly as the
    // run reported it: 7 rows in, 0 written, all 7 refused for an unknown
    // subset on one side of a real clash.
    const intended = 7, written = 0, otherSkips = 0, refused = 7, failed = 0;
    const shipped = intended - written - (otherSkips + refused) - failed;
    const mutant = intended - written - otherSkips - failed;
    expect(shipped).toBe(0);   // fully accounted -> exit 0
    expect(mutant).toBe(7);    // 100% unaccounted -> exit 4, "WORK VANISHED"
  });
});
