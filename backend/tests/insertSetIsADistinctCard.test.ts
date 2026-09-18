/**
 * §3c — A NAMED INSERT SET IS ITS OWN RUN OF CARDS (2026-09-18).
 *
 * THE DEFECT, measured on the 500 real R33 samples from slot 3 (run
 * 35391563906). R33 rewrites a stored card number to the number the title
 * states. 311 of 429 parseable stored numbers are CODED INSERT SLOTS, and
 * their titles name the insert outright:
 *
 *   RPJ-JSA  "2024 Donruss Rookie Phenom Jerseys #6 Ja'Tavion Sanders"  -> 6
 *   RR-BNX   "Bo Nix 2024 Panini Phoenix Rookie Rising Insert #47"      -> 47
 *   MM-15    "Emmitt Smith Men of Mastery Silver #15"                   -> 15
 *
 * The `#6` is that card's number WITHIN Rookie Phenom Jerseys. The flagship's
 * own #6 is a DIFFERENT CARD with its own pool and its own price, so taking
 * the title's number merges two real cards' comps — the flagship catch-all
 * swallowing a specialization, in the direction the ruling exists to prevent.
 *
 * TWO INDEPENDENT WITNESSES, either sufficient:
 *   (a) the stored cardNumber is a coded insert slot — needs no corpus;
 *   (b) the title names one of this product's `insertSets[]`.
 *
 * R31 refuses on (b) for the same reason: a title naming an insert set is
 * saying which CARD this is, not which printing, so the row is at a rung of
 * the wrong card and filling its blank parallel writes the flagship's ladder
 * onto an insert.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));
const V = require_(path.join(backend, "scripts", "lib", "rematch-finish-vocab.cjs"));

/** An R33-shaped row: the stored number disagrees with the title's literal #N. */
function r33Row(storedNumber: string, title: string, insert: string | null) {
  const stored = {
    sport: "football", cardYear: 2024, setKey: "panini-donruss",
    cardNumber: storedNumber, parallel: "", isAuto: false, printRun: null,
  };
  const slug = `hiq:football:2024:panini-donruss:${storedNumber}:base:no-auto`;
  return K.classifyRow({
    row: { title, id: "r33", cardId: slug },
    stored, derived: { ...stored, cardNumber: "6" },
    checklistBacked: true, derivationReasons: [], storedSlug: slug,
    titleNumberIsChecklistRow: true, derivedBackedR33: true,
    titleNamesInsertSet: insert,
  });
}

describe("R33 refuses a number that belongs to a named insert set", () => {
  it.each([
    ["RPJ-JSA", "2024 Donruss Rookie Phenom Jerseys #6 Ja'Tavion Sanders - Raw 10"],
    ["RR-BNX", "Bo Nix 2024 Panini Phoenix Rookie Rising Insert #6 Denver Broncos"],
    ["MM-15", "2024 Panini Mosaic Emmitt Smith Men of Mastery Silver #6"],
    ["N-AHH", "2024 Donruss Night Moves #6 Some Player"],
    ["D/149", "2024 Donruss Downtown #6 Some Player"],
  ])("a coded stored slot (%s) refuses on the stored address alone, with no corpus read", (num, title) => {
    // Witness (a). `titleNamesInsertSet` is null — the corpus is NOT consulted,
    // so this refusal holds on the 496 of 660 products that list no insertSets.
    const res = r33Row(num, title, null);
    expect(res.subclass, `${num} must not qualify as R33`).not.toBe(K.TITLE_CARD_NUMBER_WINS);
    expect(res.writable).toBe(false);
  });

  it("the title naming an insert set refuses even when the stored number is plain", () => {
    // Witness (b), the independent half: a plain numeric stored address, and
    // only the corpus knows the title names an insert.
    const res = r33Row("3", "2024 Donruss Rookie Phenom Jerseys #6 Someone", "rookie phenom jerseys");
    expect(res.subclass).not.toBe(K.TITLE_CARD_NUMBER_WINS);
    expect(res.writable).toBe(false);
  });

  it("a PLAIN number with no insert named still qualifies — this narrows, it does not disable R33", () => {
    // The mirror. Without it the guard could be satisfied by refusing
    // everything, and R33 would be dead rather than contained.
    const res = r33Row("99", "2024 Donruss #6 Someone", null);
    expect(res.subclass, "an ordinary wrong-number row is still R33").toBe(K.TITLE_CARD_NUMBER_WINS);
    expect(res.writable).toBe(true);
  });

  it("a hyphen-dropped coded number is REPAIRED, not refused — same address, punctuated", () => {
    // R33's FOUNDING population, and the opposite of the defect above. The
    // distinction is the only thing that matters:
    //
    //   kb47    -> KB-47   SAME address, punctuation restored   REPAIR
    //   RPJ-JSA -> 6       DIFFERENT address, insert -> flagship  MERGE
    //
    // Both stored numbers are coded slots, so a guard keyed on "is it coded?"
    // alone kills R33's own best evidence. CI caught this; the comparison is
    // punctuation-blind on purpose.
    const stored = {
      sport: "basketball", cardYear: 2008, setKey: "upper-deck-mvp",
      cardNumber: "kb47", parallel: "", isAuto: false, printRun: null,
    };
    const slug = "hiq:basketball:2008:upper-deck-mvp:kb47:base:no-auto";
    const res = K.classifyRow({
      row: { title: "2008-09 Upper Deck MVP #KB-47 Kobe Bryant BASKETBALL Los Angeles Lakers", id: "r33", cardId: slug },
      stored, derived: { ...stored, cardNumber: "KB-47" },
      checklistBacked: true, derivationReasons: [], storedSlug: slug,
      titleNumberIsChecklistRow: true, derivedBackedR33: true,
      titleNamesInsertSet: null,
    });
    expect(res.subclass, "a dropped hyphen is a repair R33 exists for").toBe(K.TITLE_CARD_NUMBER_WINS);
    expect(res.writable).toBe(true);
  });

  it("a `player-<name>` pseudo-number is NOT a coded slot — it is the case R33 repairs", () => {
    // `player-todd-worrell` matches the coded shape by letters alone, and
    // must be excluded: it is the UNPARSED case (a number the title spells out
    // and the derivation discarded), which is R33's own best evidence.
    const res = r33Row("player-todd-worrell", "2024 Donruss #6 Todd Worrell", null);
    expect(res.subclass, "a pseudo-number must remain repairable by R33").toBe(K.TITLE_CARD_NUMBER_WINS);
  });
});

describe("R31 refuses a fill when the title names an insert set", () => {
  function r31Row(insert: string | null) {
    const stored = {
      sport: "football", cardYear: 2024, setKey: "panini-phoenix",
      cardNumber: "47", parallel: "", isAuto: false, printRun: null,
    };
    const slug = "hiq:football:2024:panini-phoenix:47:base:no-auto";
    return K.classifyRow({
      row: { title: "Bo Nix 2024 Panini Phoenix Rookie Rising Insert #47 Blue", id: "r31", cardId: slug },
      stored, derived: { ...stored, parallel: "Blue" },
      checklistBacked: true, derivationReasons: [], storedSlug: slug,
      checklistListsTitleParallel: true, titleParallelIsARungPhrase: true,
      titleNamesInsertSet: insert,
    });
  }

  it("names-an-insert-set refuses the fill and says so by name", () => {
    const res = r31Row("rookie rising");
    expect(res.subclass).not.toBe(K.TITLE_FILLS_THE_BLANK);
    expect(res.writable).toBe(false);
  });

  it("the same row with no insert named still fills — narrowing, not disabling", () => {
    const res = r31Row(null);
    expect(res.subclass).toBe(K.TITLE_FILLS_THE_BLANK);
    expect(res.writable).toBe(true);
  });
});

describe("the insert-set lookup is SPORT-SCOPED", () => {
  // `productKey` is deliberately sport-blind — a finish is a finish. An insert
  // set is not: 2024 panini-select is three different products, and basketball's
  // bare "Select" root matched a FOOTBALL parallel title before this was fixed.
  it("one sport's insert set never answers for another sport's card", () => {
    const footballTitle = "2024 Panini Select Concourse Olumuyiwa Fashanu #66 Gold Prizm /10 (RC)";
    expect(V.insertSetNamedInTitle(footballTitle, "football", 2024, "panini-select"),
      "basketball's 'Select' insert root must not match a football title").toBeNull();
    expect(V.insertSetNamedInTitle("2024 Panini Select In Flight #12", "basketball", 2024, "panini-select"),
      "and basketball's own inserts must still match for basketball").toBeTruthy();
  });

  it("no sport means no answer, never another sport's answer", () => {
    expect(V.insertSetNamedInTitle("2024 Panini Mosaic Men of Mastery Silver #15", "", 2024, "panini-mosaic")).toBeNull();
  });

  it("a real insert name in the right sport is found, longest match first", () => {
    expect(V.insertSetNamedInTitle(
      "2024 Panini Mosaic Emmitt Smith Men of Mastery Silver #15", "football", 2024, "panini-mosaic",
    )).toBe("men of mastery silver");
  });

  it("an insert root that is ALSO a parallel name of the product cannot refuse alone", () => {
    // 8 roots in the committed corpus are also parallel names of the SAME
    // product — "Elite" (2026 donruss-elite), "Rookie" (2023 panini-prizm,
    // 2024 panini-mosaic), "Unleashed" (2024/2025 donruss), "Printing Plates".
    // A bare single-word collision is ambiguous: the title saying "Rookie" may
    // name the insert or the finish, and refusing on the ambiguous reading
    // would block legitimate parallel fills. Absent beats wrong both ways.
    expect(V.insertSetNamedInTitle("2023 Panini Prizm Someone Rookie #12", "basketball", 2023, "panini-prizm"),
      "a single-word root that is also a parallel name of this product must not decide").toBeNull();
    expect(V.insertSetNamedInTitle("2026 Donruss Elite Someone Elite #12", "baseball", 2026, "donruss-elite"),
      "same for 'Elite' on donruss-elite").toBeNull();
  });
});
