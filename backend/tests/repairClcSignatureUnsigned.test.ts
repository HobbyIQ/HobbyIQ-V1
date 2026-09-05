/**
 * CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION (2026-09-05) -- the repair
 * half. The converter fix stops the defect; this lane is the 9,259 rows it
 * already minted.
 *
 * WHAT THESE TESTS ARE FOR. The lane flips a field that is part of the canonical
 * id, so every row it touches MOVES, its sales are re-pointed and its old
 * address is deleted. The one way that goes wrong is a name the vocabulary reads
 * backwards -- so the negation guard is pinned harder than the positive rule,
 * and mutation-checked in both directions.
 *
 * MEASURED read-only over card_catalog, source LIKE checklistcenter%:
 *   10,140 rows isAuto=false with a signature word in the parallel
 *      881 of them are 2018 Topps Archives "No Signature" variations -- the card
 *          LACKS the facsimile signature, the flag is CORRECT, and flipping them
 *          would be the exact "right guard, wrong scope" mistake
 *    9,259 genuinely wrong, 79 products
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require("../scripts/repair-clc-signature-unsigned.cjs");
const { namesAnAuto, verdictFor, familyOf, idSaysAuto, withAutoSegment } = lane;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const converter = require("../scripts/convertChecklistCenterToChecklistCsv.cjs");

const row = (o: Record<string, unknown>) => ({
  id: "hiq:baseball:2022:panini-elite-extra-edition:17:signatures:no-auto",
  cardId: "hiq:baseball:2022:panini-elite-extra-edition:17:signatures:no-auto",
  sport: "baseball", year: 2022, setKey: "panini-elite-extra-edition",
  cardNumber: "17", parallel: "Signatures", subsetName: null, isAuto: false,
  source: "checklistcenter-2026-08-29", ...o,
});

describe("repair-clc-signature-unsigned — the vocabulary", () => {
  it("reads the checklist's own name as evidence the card is signed", () => {
    for (const t of [
      "Signatures", "Signature Swatches Gold Prizm", "Prizm Signatures",
      "Cut Signatures", "Optic Signatures", "Material Signatures Platinum",
      "Penmanship Prizms Silver", "Autographs SuperFractor", "Pinnacle Inscriptions",
    ]) expect([t, namesAnAuto(t)]).toEqual([t, true]);
  });

  /**
   * THE ONE THAT MATTERS. "1977 - No Signature" is a 2018 Topps Archives
   * variation whose whole point is the MISSING facsimile signature. It contains
   * the word and means the opposite. All 881 such rows are already correct.
   */
  it("refuses a name that DENIES the signature — the 881 Topps Archives rows", () => {
    for (const t of [
      "1977 - No Signature",            // the real spellings, verbatim from Cosmos
      "1977 No Signature",
      "1959 - No Signature/Venezuelan",
      // written wider than the three, so a fourth spelling is refused too
      "No Autograph", "Unsigned", "Without Signature", "Missing Signature",
      "Non-Auto", "No Facsimile Signature", "Not Signed",
    ]) expect([t, namesAnAuto(t)]).toEqual([t, false]);
  });

  it("reads whole words — a substring is not an autograph", () => {
    for (const t of ["Autumn Leaves", "Inkjet", "Designation", "Gold Refractor", "Base", "Swatch Gold Prizm", "Materials Patch"]) {
      expect([t, namesAnAuto(t)]).toEqual([t, false]);
    }
  });

  /**
   * The lane and the parser must agree, or a repair heals rows the parser
   * re-breaks on the next ingest.
   */
  it("shares its auto vocabulary with the converter that stages the rows", () => {
    for (const t of [
      "Signature Swatches Gold Prizm", "Prizm Signatures", "Penmanship Prizms Silver",
      "Autographs SuperFractor", "Gold Refractor", "Jumbo Rookie", "Autumn Leaves", "Inkjet",
    ]) expect([t, namesAnAuto(t)]).toEqual([t, converter.namesAnAuto(t)]);
  });
});

describe("repair-clc-signature-unsigned — the verdict", () => {
  it("moves a row whose name says signed and whose id says no-auto", () => {
    const v = verdictFor(row({}));
    expect(v.action).toBe("move");
    expect(v.reason).toContain("Signatures");
  });

  it("HEALS rather than moves when the id already says auto", () => {
    // The address is right and only the field disagrees: nothing moves, no sale
    // is re-pointed, the field conforms to its own id.
    const v = verdictFor(row({ id: "hiq:baseball:2022:x:17:signatures:auto", cardId: "hiq:baseball:2022:x:17:signatures:auto" }));
    expect(v.action).toBe("heal");
  });

  it("skips a row that is already signed", () => {
    expect(verdictFor(row({ isAuto: true })).action).toBe("skip");
  });

  it("skips a No Signature variation — the flag is already correct", () => {
    const v = verdictFor(row({ parallel: "1977 - No Signature" }));
    expect(v.action).toBe("skip");
    expect(v.reason).toContain("denies the signature");
  });

  it("skips a row whose name carries no auto word at all", () => {
    expect(verdictFor(row({ parallel: "Gold Refractor" })).action).toBe("skip");
    expect(verdictFor(row({ parallel: "" })).action).toBe("skip");
  });

  /**
   * A SOURCE TYPO IS NOT A SYNONYM. checklistcenter publishes "Patch Autogrpahs
   * Gold" and "Patch Autogrpahs Black" -- 66 rows, misspelled on the page.
   * Those rows almost certainly ARE autographs, and they are still refused:
   * a vocabulary that guesses at misspellings is a vocabulary that starts
   * inventing cards. 66 rows is a line in the report for a human to rule on,
   * not a silent correction. If this is ever ruled, it belongs in the
   * vocabulary as an explicit alias with the ruling's date on it.
   */
  it("refuses a misspelled auto word rather than guessing — 'Autogrpahs' is reported, not corrected", () => {
    for (const p of ["Patch Autogrpahs Gold", "Patch Autogrpahs Black"]) {
      const v = verdictFor(row({ parallel: p }));
      expect([p, v.action]).toEqual([p, "skip"]);
      expect(v.reason).toContain("no auto word");
    }
  });

  it("reads the subset name when the parallel is silent", () => {
    expect(verdictFor(row({ parallel: "Holo Gold", subsetName: "Rookie Signatures" })).action).toBe("move");
  });
});

describe("repair-clc-signature-unsigned — the slug", () => {
  it("the auto flag is segment 6, and the move flips exactly that", () => {
    const id = "hiq:baseball:2022:panini-elite-extra-edition:17:signatures:no-auto:num-1";
    expect(idSaysAuto(id)).toBe(false);
    const moved = withAutoSegment(id, true);
    expect(moved).toBe("hiq:baseball:2022:panini-elite-extra-edition:17:signatures:auto:num-1");
    expect(idSaysAuto(moved)).toBe(true);
    // the print run, the parallel and the card number are untouched
    expect(moved.split(":").filter((_, i) => i !== 6)).toEqual(id.split(":").filter((_, i) => i !== 6));
  });

  it("folds the dated scrape runs into one source family", () => {
    for (const s of ["checklistcenter-2026-08-29", "checklistcenter-2026-08-30", "checklistcenter-html-graded", "checklistcenter-2026-09-05"]) {
      expect([s, familyOf(s)]).toEqual([s, "checklistcenter"]);
    }
  });
});

/** THE MUTATIONS. Each is the shipped guarantee, inverted, asserted to go red. */
describe("repair-clc-signature-unsigned — mutation checks", () => {
  /**
   * The lane's whole risk in one test. Drop the negation guard and the 881
   * correctly-unsigned Topps Archives rows become actionable -- 881 cards that
   * exist ONLY unsigned, moved to a signed address, their sales dragged with
   * them. Row count unchanged, every other column well-formed.
   */
  it("MUTATION: dropping the negation guard makes the No Signature variations actionable", () => {
    const archives = ["1977 - No Signature", "1977 No Signature", "1959 - No Signature/Venezuelan"];

    // Shipped: every one of them is refused.
    for (const p of archives) expect([p, verdictFor(row({ parallel: p })).action]).toEqual([p, "skip"]);

    // The mutation: the auto word alone decides, with no negation check -- the
    // pre-guard rule, spelled out.
    const naive = (t: string) => /\b(auto|autograph|autographs|signature|signatures|signed|penmanship)\b/i.test(t);
    for (const p of archives) expect([p, naive(p)]).toEqual([p, true]);

    // So the guard is what stands between 881 correct rows and 881 wrong moves.
    expect(archives.every((p) => naive(p) && !namesAnAuto(p))).toBe(true);
  });

  /**
   * The other direction: a vocabulary that matches substrings mints autographs
   * out of words that merely contain the letters.
   */
  it("MUTATION: a substring vocabulary mints Inkjet and Autographed-Ball-Green as autographs", () => {
    const substring = (t: string) => /auto|signature|ink|penmanship/i.test(t);
    // Words that CONTAIN an auto word without being one. A boundary-less rule
    // reads all of them as signed; the shipped rule reads none of them.
    for (const t of ["Inkjet", "Autobiography Insert", "Sinkers", "Automobile"]) {
      expect([t, namesAnAuto(t)]).toEqual([t, false]);
      expect([t, substring(t)]).toEqual([t, true]);
    }
  });

  /**
   * And the defect itself: a vocabulary without "signature" leaves the 9,259
   * rows exactly as they are.
   */
  it("MUTATION: a vocabulary without the word signature repairs nothing", () => {
    const narrowed = (t: string) => /\b(auto|autos|autograph|autographs)\b/i.test(t);
    const real = ["Signatures", "Cut Signatures", "Optic Signatures", "Signature Swatches Gold Prizm", "Penmanship Prizms Silver"];
    for (const t of real) {
      expect([t, namesAnAuto(t)]).toEqual([t, true]);
      expect([t, narrowed(t)]).toEqual([t, false]);
    }
  });
});
