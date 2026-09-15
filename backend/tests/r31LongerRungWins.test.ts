/**
 * CF-THE-LONGEST-RUNG-THE-TITLE-STATES-WINS (slot-3 R31 census, 2026-09-15,
 * artifact `collect-r3x-guards/flat/census-slot-3.json`).
 *
 * THE DEFECT, AND WHY IT IS INVISIBLE. #2189's T3b asks "is the candidate a
 * rung of this product". The answer can be YES for a candidate that is merely
 * the first word of the rung the title actually names — and then every gate
 * passes and R31 writes a real rung that is the wrong card.
 *
 *   football|2024|donruss-optic lists BOTH:
 *       "Purple"          <- what the derivation offered
 *       "Purple Scope"    <- what the title says
 *
 *   "2024 Panini Donruss Optic - Rated Rookie Jared Verse #242 Purple Scope
 *    Prizm"  ->  parallel:(blank)->purple
 *
 * Two rungs, two print runs, two price curves, fused — and undetectable
 * afterwards, because `purple` IS a rung of that product.
 *
 * This is the refusal `statedFinishFromChecklist` already makes on the READ
 * side ("a name the title extends is a truncation, not an answer"). R31
 * WRITES, so it needs the same refusal here. It REFUSES rather than correcting
 * to the longer rung: choosing between two real rungs of one product is not
 * this guard's call, and absent beats wrong.
 *
 * THE SETKEY IS THE DERIVED ONE. R31 evaluates against `inferSetKeyFromTitle`,
 * not the stored slug. These rows are stored under `panini-donruss` (which has
 * NO ladder in the corpus) while the derivation lands on `donruss-optic`
 * (which has 178 rungs) — reading the stored slug is what made an earlier
 * measurement of mine report these rows as already refused when they were not.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs"));
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

const OPTIC = { year: 2024, setKey: "donruss-optic" };
const PURPLE_SCOPE_TITLE =
  "2024 Panini Donruss Optic - Rated Rookie Jared Verse #242 Purple Scope Prizm";

/** R31's evidence with every leg satisfied except the one under test. */
function r31(over: Record<string, unknown> = {}) {
  return K.titleFillsTheBlankEvidence({
    row: { title: PURPLE_SCOPE_TITLE },
    stored: { parallel: "base", printRun: null },
    derived: { parallel: "purple", printRun: null },
    axes: { filled: ["parallel"], changed: [], dropped: [] },
    titleParallel: "purple",
    checklistListsTitleParallel: true,
    titleParallelIsARungPhrase: true,
    titleSerial: null,
    derivedBacked: true,
    ...over,
  });
}

describe("the corpus really does carry both rungs — the defect is real", () => {
  it("lists Purple AND Purple Scope on donruss-optic 2024", () => {
    // Without this the guard below could pass for the wrong reason.
    expect(VOCAB.checklistRungPhrase("purple", OPTIC.year, OPTIC.setKey)).toBe("purple");
    expect(VOCAB.checklistRungPhrase("purple scope", OPTIC.year, OPTIC.setKey)).toBe("purple scope");
  });

  it("T3b passes the shorter rung, which is why T3c is needed", () => {
    expect(VOCAB.checklistListsRungPhrase("purple", OPTIC.year, OPTIC.setKey)).toBe(true);
  });
});

describe("longerRungStatedInTitle", () => {
  it("finds the longer rung the title states", () => {
    // The corpus index holds names normalised (lowercase); the refusal quotes
    // the name as the ladder stores it, which is what the reason string shows.
    expect(VOCAB.longerRungStatedInTitle("purple", PURPLE_SCOPE_TITLE, OPTIC.year, OPTIC.setKey))
      .toBe("purple scope");
  });

  it("is silent when the title states only the short rung", () => {
    expect(VOCAB.longerRungStatedInTitle(
      "purple", "2024 Panini Donruss Optic #10 Purple", OPTIC.year, OPTIC.setKey)).toBeNull();
  });

  it("is silent when no longer rung exists", () => {
    // "Passing Grade" has children on this ladder, but the title states none
    // of them, so there is nothing more specific to prefer.
    expect(VOCAB.longerRungStatedInTitle(
      "passing grade", "2024 PANINI DONRUSS OPTIC PASSING GRADE #4 DRAKE MAYE",
      OPTIC.year, OPTIC.setKey)).toBeNull();
  });

  it("never reports a rung the title does not contain contiguously", () => {
    // The words must appear together. "Purple ... Scope" scattered across a
    // title is not a statement of "Purple Scope".
    expect(VOCAB.longerRungStatedInTitle(
      "purple", "2024 Optic Purple #5 with Scope elsewhere in the listing text",
      OPTIC.year, OPTIC.setKey)).toBeNull();
  });

  it("answers null for a product with no ladder", () => {
    expect(VOCAB.longerRungStatedInTitle("purple", PURPLE_SCOPE_TITLE, 2024, "panini-donruss")).toBeNull();
  });
});

describe("T3c refuses the fill", () => {
  it("names the longer rung in the refusal", () => {
    const r = r31({ titleNamesLongerRung: "Purple Scope" });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-longer-rung:purple scope");
  });

  it("MUTATION: without the leg this row writes `purple`", () => {
    // The pin above would also pass against a classifier refusing for some
    // other reason; this is what makes it about T3c.
    expect(r31().qualifies).toBe(true);
  });

  it("an unasked caller keeps today's behaviour", () => {
    // null/absent means the driver did not compute it. The leg only narrows.
    expect(r31({ titleNamesLongerRung: null }).qualifies).toBe(true);
  });

  it("does not disturb the other refusals", () => {
    // A non-rung still fails T3b, with T3b's own reason, not T3c's.
    const r = r31({ titleParallelIsARungPhrase: false, titleNamesLongerRung: null });
    expect(r.failed).toContain("not-a-rung-in-product:purple");
  });
});
