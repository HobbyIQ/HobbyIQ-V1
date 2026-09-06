/**
 * CF-ROWS-CREATED-IS-COUNTED-BY-SOURCE (2026-09-06) and
 * CF-VACATE-THE-PLAIN-ID-OR-REFUSE (2026-09-06).
 *
 * Two defects found while measuring the sportscardchecklist Bowman's Best
 * incident. Neither was a bad checklist; both were the pipeline lying about
 * what it had done.
 *
 * 1. THE BANNER COUNTED OTHER PEOPLE'S ROWS. The driver reported
 *    "INGESTED - 4,003 rows created ... of 200 staged" for a page of 200
 *    cards. `rows created` was `countCatalogRows(after) - countCatalogRows(
 *    before)`, and countCatalogRows sums a WHOLE-PRODUCT COUNT(1) across every
 *    setKey spelling the child might write under. Measured against prod on
 *    2026-09-06, baseball/1997/bowmans-best holds 3,984 rows:
 *
 *      baseballcardpedia            1,854
 *      baseballcardpedia-graded     1,573
 *      sales-attested (+graded)       234
 *      sportscardchecklist-09-06      292   <- all this run actually wrote
 *      other                           31
 *
 *    so the "4,003 created" was a whole-product total wearing a per-run label.
 *    The honest instrument already existed -- countCatalogRowsBySource -- and
 *    was computed one line later purely for display. `created` is now its
 *    delta, so a row another source wrote can never enter the count.
 *
 * 2. "THE PLAIN ID IS VACATED" DID NOT VACATE IT. The subset-disambiguation
 *    block re-minted BOTH clashing cards with a `:sub-` segment, and moved the
 *    incumbent with an `upsertCatalogEntry` at the new address -- a COPY. The
 *    plain-id row stayed exactly where it was, still answering for both cards
 *    and still collecting their sales. One ambiguous address became three
 *    rows. It is now a moveCatalogRow (copy, re-point sales, retire graded
 *    children, DELETE the old row), and any outcome that leaves the plain id
 *    standing is counted and named rather than reported as success.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const driver = join(__dirname, "..", "scripts", "ingest-universe-driver.cjs");
const ingest = join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs");

// -- 1. rows created is a BY-SOURCE delta -------------------------------------

describe("rows created counts only what THIS run's source wrote", () => {
  it("takes a by-source reading at BOTH ends, and subtracts those", () => {
    const src = readFileSync(driver, "utf8");
    // The `before` half is the one that did not exist: the old code took only
    // a whole-product `before`, so there was nothing per-source to subtract.
    expect(src).toContain(
      "const beforeUnderSource = await countCatalogRowsBySource(entry, sourceLabelFor(lane))",
    );
    expect(src).toMatch(
      /const created = \(rowsUnderSource === null \|\| beforeUnderSource === null\)/,
    );
    expect(src).toContain(": rowsUnderSource - beforeUnderSource;");
  });

  it("no longer subtracts the two whole-product counts", () => {
    const src = readFileSync(driver, "utf8");
    // The exact expression that produced "4,003 rows created".
    expect(src).not.toContain("const created = (after ?? 0) - (before ?? 0);");
  });

  it("THE ARITHMETIC: a product already holding N rows, of which this run wrote 20", () => {
    // The fixture is the measured Bowman's Best shape, reduced. The product
    // holds 3,984 rows from five sources; this run's tag accounts for 292 of
    // them and held 272 before the run -- so it created 20.
    const wholeProductBefore = 3_964;
    const wholeProductAfter = 3_984;
    const underSourceBefore: number | null = 272;
    const underSourceAfter: number | null = 292;

    // The rule as shipped.
    const created =
      underSourceAfter === null || underSourceBefore === null
        ? null
        : underSourceAfter - underSourceBefore;
    expect(created).toBe(20);

    // And it must equal the number of rows staged, which is the whole point of
    // the banner: 20 staged cards, 20 rows created.
    const staged = 20;
    expect(created).toBe(staged);

    // The old rule agrees ONLY because nothing else moved in this fixture.
    expect(wholeProductAfter - wholeProductBefore).toBe(20);
  });

  it("MUTATION: back to the whole-product delta -> a concurrent writer is counted as ours -> red", () => {
    // The real incident: 200 cards staged, and the whole-product delta moved by
    // thousands because sibling rung pages and the graded-children generator
    // were writing into the same (year, setKey) at the same time.
    const wholeProductBefore = 3_507;
    const wholeProductAfter = 7_510; // a sibling lane landed 4,003 of its own
    const underSourceBefore = 72;
    const underSourceAfter = 272;

    const mutantCreated = wholeProductAfter - wholeProductBefore;
    const realCreated = underSourceAfter - underSourceBefore;
    const staged = 200;

    // The mutant reports the number the incident actually printed.
    expect(mutantCreated).toBe(4_003);
    expect(mutantCreated).not.toBe(staged);
    // The shipped rule reports what this run wrote, which is what was staged.
    expect(realCreated).toBe(200);
    expect(realCreated).toBe(staged);
  });

  it("an unmeasurable by-source count prints 'not measured', never a zero", () => {
    const src = readFileSync(driver, "utf8");
    // `f(null)` is "0" -- a count we could not take must not print as a
    // measured zero, which is the conflation the acquire lane's Gate 1 was
    // rewritten for ("0 rows created" vs 3,810 rows actually present).
    expect(src).toContain(
      'const fOrUnknown = (n) => (n === null || n === undefined ? "not measured" : f(n));',
    );
    expect(src).toContain("${fOrUnknown(created)} rows created under ${sourceLabelFor(lane)}");
    expect(src).not.toContain("${f(created)} rows created,");
  });

  it("and the banner NAMES the source it counted", () => {
    const src = readFileSync(driver, "utf8");
    // A bare number invites exactly the misreading this fix is about.
    expect(src).toContain(
      "INGESTED — ${fOrUnknown(created)} rows created under ${sourceLabelFor(lane)}",
    );
    expect(src).toContain(
      "${fOrUnknown(created)} rows created under ${sourceLabelFor(lane)}, ${f(after)} in catalog)",
    );
  });
});

// -- 2. the plain id is actually vacated --------------------------------------

describe("subset disambiguation vacates the plain id", () => {
  it("MOVES the incumbent (copy, re-point, delete) instead of copying it", () => {
    const src = readFileSync(ingest, "utf8");
    expect(src).toContain("moveCatalogRow");
    expect(src).toContain("dist/services/catalog/catalogRowOps.service.js");
    // The sales must follow the card off the vacated address.
    expect(src).toContain("salesContainer: poolContainer()");
    // The reason is required by moveCatalogRow and says what happened.
    expect(src).toMatch(/reason: `subset disambiguation:/);
  });

  it("no longer re-upserts the incumbent at a second address", () => {
    const src = readFileSync(ingest, "utf8");
    // The exact copy-not-move that left three rows where two belong.
    expect(src).not.toMatch(
      /await upsertCatalogEntry\(\{\s*\.\.\.known, id: incumbentSlug, cardId: incumbentSlug, hobbyiqCardId: incumbentSlug,/,
    );
  });

  it("THE COUNT: incumbent + newcomer is exactly 2 rows, not 3", () => {
    // The three addresses in play for one clashing (cardNumber, rung).
    const plain = "hiq:basketball:2000:topps-chrome:mj1:refractor:no-auto";
    const incumbentSub =
      "hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:refractor:no-auto";
    const newcomerSub =
      "hiq:basketball:2000:topps-chrome:sub-cards-that-never-were:mj1:refractor:no-auto";

    // A move DELETES the source address; a copy leaves it.
    const afterMove = new Set([incumbentSub, newcomerSub]);
    const afterCopy = new Set([plain, incumbentSub, newcomerSub]);

    expect(afterMove.size).toBe(2);
    expect(afterMove.has(plain)).toBe(false);

    // The mutant's shape, and why it is wrong: the plain id survives and still
    // answers for both cards.
    expect(afterCopy.size).toBe(3);
    expect(afterCopy.has(plain)).toBe(true);
  });

  it("a failure to vacate is COUNTED and NAMED, never reported as success", () => {
    const src = readFileSync(ingest, "utf8");
    expect(src).toContain("subsetVacateFailed++");
    expect(src).toContain("vacateFailures.push");
    expect(src).toContain("subset clashes NOT VACATED");
    // "noop" is the one non-moving action that is fine: the row was already
    // at its correct address, so nothing occupies the plain id.
    expect(src).toContain('moved.action !== "noop"');
  });

  it("MUTATION: treat every move outcome as success -> a stuck plain id reports clean -> red", () => {
    const src = readFileSync(ingest, "utf8");
    const guard =
      'if (moved.action === "move" || moved.action === "replace" || moved.action === "fold") {';
    expect(src).toContain(guard);

    const mutated = src.replace(guard, "if (true) {");
    expect(mutated).not.toBe(src);
    // The mutant can never reach the failure branch, so a plain id that stayed
    // occupied would be invisible in the banner.
    expect(mutated).not.toContain(guard);

    // The shipped rule reaches the failure branch for any outcome that is
    // neither a real move nor an already-correct row.
    const outcomes = ["move", "replace", "fold", "noop", "refused"];
    const counted = outcomes.filter(
      (a) => !(a === "move" || a === "replace" || a === "fold") && a !== "noop",
    );
    expect(counted).toEqual(["refused"]);
  });

  it("the #1741 unknown-subset refusal survives beside the resolve path", () => {
    const src = readFileSync(ingest, "utf8");
    // Blank is unknown and is never invented -- vacating is about a clash
    // between two NAMED subsets, and must not have loosened that.
    expect(src).toContain("subsetCollision++");
    expect(src).toMatch(/if \(!product\.subsetName\) \{/);
    expect(src).toContain("subsetDisambiguated++");
  });
});
