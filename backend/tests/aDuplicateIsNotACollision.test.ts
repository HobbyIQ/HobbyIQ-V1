/**
 * CF-A-DUPLICATE-IS-NOT-A-COLLISION (Drew, 2026-09-19).
 *
 * Two rows of one file minting one id is normally the defect the id-integrity
 * guard exists to catch: two DIFFERENT cards fighting for one address, which
 * no set key can separate, so refusing the file is the honest answer.
 *
 * Some sources simply list the same card twice. Measured on 2024
 * panini-photogenic football, which writes its base colour rungs under two
 * spellings of the same section:
 *
 *     [base]              #1 (Black)  Ja'Marr Chase
 *     [insert-base-black] #1 (Black)  Ja'Marr Chase
 *
 * Same player, same number, same parallel, same auto flag, same print run.
 * One card, written twice. Writing it once is complete and correct; refusing
 * 4,646 good rows over the source's bookkeeping is not.
 *
 * THE TEST IS AGREEMENT ON IDENTITY, NOT ON THE ROW. `category` is excluded
 * deliberately -- it is the field that DIFFERS between the two spellings, and
 * including it would make every duplicate look like a collision. Any
 * disagreement in player, cardNumber, parallel, isAuto or printRun and the
 * group stays an id-collision and the file is refused exactly as before.
 *
 * Two players at one number is the defect. One player written twice is a typo.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const lib = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "scripts", "lib", "insert-set-key.cjs",
);
const { idCollisions } = require_(lib);

/** The id the ingester would mint, in miniature: identity minus the category. */
const idOf = (r: Record<string, string>) =>
  `hiq:${r.cardNumber}:${(r.parallel || "Base").toLowerCase()}:${r.isAuto === "true" ? "auto" : "no-auto"}`;

describe("a duplicate is not a collision", () => {
  it("FOLDS one card the file listed twice under two category spellings", () => {
    // The real Photogenic shape.
    const rows = [
      { category: "base", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Ja'Marr Chase" },
      { category: "insert-base-black", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Ja'Marr Chase" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.collisions).toHaveLength(0);
    expect(r.duplicatesFolded).toBe(1);
    expect(r.ids).toBe(1);
  });

  it("MUTATION: a DIFFERENT PLAYER at the same id is still refused", () => {
    // This is the defect the guard exists for, and it must survive the fold.
    const rows = [
      { category: "base", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Ja'Marr Chase" },
      { category: "insert-base-black", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Joe Burrow" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.duplicatesFolded).toBe(0);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0].rows).toHaveLength(2);
  });

  it("MUTATION: a differing PRINT RUN is not a duplicate", () => {
    // /25 and /99 of one card are two cards; the id builder separates them in
    // production, and where it does not, refusing is right.
    const rows = [
      { category: "base", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "25", player: "Ja'Marr Chase" },
      { category: "insert-base-black", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "99", player: "Ja'Marr Chase" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.duplicatesFolded).toBe(0);
    expect(r.collisions).toHaveLength(1);
  });

  it("MUTATION: a differing AUTO FLAG is not a duplicate", () => {
    const rows = [
      { category: "base", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Ja'Marr Chase" },
      { category: "auto-base-black", cardNumber: "1", parallel: "Black", isAuto: "true", printRun: "", player: "Ja'Marr Chase" },
    ];
    // Different ids here (the flag is in the id), so no collision at all —
    // which is itself the point: the auto flag already separates them.
    const r = idCollisions(rows, idOf);
    expect(r.collisions).toHaveLength(0);
    expect(r.duplicatesFolded).toBe(0);
    expect(r.ids).toBe(2);
  });

  it("folds N copies to one, and counts every copy it dropped", () => {
    const one = { category: "base", cardNumber: "7", parallel: "Gold", isAuto: "", printRun: "", player: "A Player" };
    const rows = [
      one,
      { ...one, category: "insert-base-gold" },
      { ...one, category: "insert-base-set-gold" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.collisions).toHaveLength(0);
    expect(r.duplicatesFolded).toBe(2);   // three copies, two dropped
    expect(r.ids).toBe(1);
  });

  it("a mixed group — two identical and one different — is REFUSED whole", () => {
    // Nothing partial: folding the pair and refusing the third would write
    // some of a group and refuse the rest, which is the half-ingest the
    // file-level refusal exists to prevent.
    const one = { category: "base", cardNumber: "1", parallel: "Black", isAuto: "", printRun: "", player: "Ja'Marr Chase" };
    const rows = [
      one,
      { ...one, category: "insert-base-black" },
      { ...one, category: "insert-base-set-black", player: "Joe Burrow" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.duplicatesFolded).toBe(0);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0].rows).toHaveLength(3);
  });

  it("a base card and a DIFFERENT NAMED SUBSET at the same number is a collision, not a duplicate", () => {
    // CF-A-DUPLICATE-IS-NOT-A-COLLISION's own identity tuple is player,
    // cardNumber, parallel, isAuto, printRun -- deliberately NOT category, so
    // that Photogenic's two spellings of one base card fold. But `category` is
    // also the ONLY field that says which SUBSET a row belongs to, and a base
    // card can share every one of those five fields with a DIFFERENT,
    // same-numbered named subset by coincidence: same player, same number,
    // both blank parallel, no auto, no print run. That is not a source
    // spelling one card twice -- it is the R30 defect the guard exists to
    // catch: two different cards fighting for one address, and only a set key
    // (subsetsToSeparate, which reuses idCollisions to measure this) can tell
    // them apart. Folding it here hides the collision from that guard --
    // measured on the cbc shape, a base set and "College Penmanship" both
    // numbered 1-3 lost the subset's rows silently (6 ids instead of 9).
    //
    // subsetName distinguishes the two rows below, `idOf` does not read it
    // (mirroring the pre-separation address subsetsToSeparate measures), so
    // they still collide on one id -- and that collision must SURVIVE, not
    // fold, because the rows name different subsets.
    const rows = [
      { category: "", cardNumber: "1", parallel: "", isAuto: "", printRun: "", player: "Paolo Banchero", subsetName: null },
      { category: "", cardNumber: "1", parallel: "", isAuto: "", printRun: "", player: "Paolo Banchero", subsetName: "College Penmanship" },
    ];
    const r = idCollisions(rows, idOf);
    expect(r.duplicatesFolded).toBe(0);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0].rows).toHaveLength(2);
    // One CONTESTED id, not one settled id: the collision is what lets
    // subsetsToSeparate see that this address needs splitting.
    expect(r.ids).toBe(1);
  });
});
