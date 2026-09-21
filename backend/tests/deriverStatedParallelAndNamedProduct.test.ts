/**
 * THE DERIVER IS THE WRONG SIDE, IN FOUR IDENTIFIABLE CLASSES
 * (wave2verify16 sports census, 2026-09-13).
 *
 * The deriver batch on main b5ab5f74 left the SPORTS pool at AGREE 45.9% /
 * CONFLICT 46.5%, and a hand audit of 318 stratified CONFLICT samples judged
 * the STORED row right 55% of the time against the DERIVER's 17%. A census
 * where the re-derivation is usually wrong cannot improve the pool -- every
 * disagreement it reports is a row the rematch may never act on -- so the
 * defect is in the derivation, not in the corpus.
 *
 * EVERY TITLE IN THIS FILE IS A REAL POOL ROW, taken verbatim from the census
 * artifacts' `samples.CONFLICT` lines (`…/wave2verify16/artifacts/flat/
 * census-slot-*.json`), and every `stored` value is that row's own field. The
 * pins are therefore against the corpus, not against invented strings -- the
 * same discipline statedFinishIsNotABaseCard.test.ts states for its own draw.
 *
 * THE FOUR CLASSES, AND WHAT DECIDES EACH
 *
 *   A  A parallel the title STATES is dropped to Base. A stated finish is on
 *      the identity; blank is unknown and Base is a claim.
 *   B  A NAMED product is folded into its flagship. R26: a named product is
 *      its own product -- Bowman vs Bowman Chrome vs Sapphire are DIFFERENT
 *      cards, and so are Topps Chrome Black, Stadium Club Chrome, Prizm WNBA,
 *      Bowman Chrome Mega Box and Allen & Ginter.
 *   C  The parallel SPELLING differs for the same card. The checklist's
 *      spelling for that product decides; where neither side is verifiable the
 *      STORED spelling stands.
 *   D  The sport is taken from a card-number token. The sport is the PRODUCT's
 *      sport.
 *
 * MEASURED, over all 7,684 sports CONFLICT samples in the artifacts
 * (before -> after):
 *
 *     derive the stored identity (AGREE)    246  ->  1,576
 *     class A  (stated parallel dropped)  1,424  ->    645
 *     class B  (named product folded)       905  ->    134
 *     class C  (spelling differs)         3,365  ->  2,529
 *     class D  (sport from card number)      30  ->     20
 *
 * CARD-NUMBER TRUNCATION ("#DR2-LV" -> "DR2") is NOT repaired here -- that is
 * draft #2122's fix, and the Tribute pin below states the number as the census
 * recorded it so the two changes stay independently attributable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { _resetStatedFinishCorpus } from "../src/services/portfolioiq/statedFinishFromChecklist";

/** The setKey the deriver lands on: the parser's read, spoken through the one
 *  vocabulary that rules on product names. This is the pair `deriveIdentity`
 *  itself composes, so a pin here is a pin on the derivation. */
const setKeyOf = (title: string, cardNumber: string | null = null): string =>
  normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));

/** The parallel the deriver lands on, WITH the product context the census row
 *  carries on its own slug -- which is what `parseListingIdentity` reads out of
 *  `hobbyiqCardId`, and therefore what the census saw. */
const parallelOf = (title: string, setKey: string, year: number): string =>
  parseListingIdentity(title, undefined, { setKey, year }).parallel;

beforeEach(() => _resetStatedFinishCorpus());

// ─────────────────────────────────────────────────────────────────────────────
// CLASS B -- A NAMED PRODUCT IS ITS OWN PRODUCT (R26)
//
// Largest and least ambiguous class: the destination key is already a
// `normalizeSetKey` fixed point and in most cases already carries a
// productSetKeys ladder entry. The parser simply had no rule that could reach
// it, so a bare brand rule one line lower returned a constant and the
// qualifying word was discarded before the vocabulary ever saw it.
// ─────────────────────────────────────────────────────────────────────────────
describe("class B: a named product is never folded into its flagship", () => {
  it.each([
    // [title, the ruled key, what the census derived instead]
    ["2025 Topps Allen & Ginter Baseball #8 Base", "topps-allen-ginter", "topps"],
    ["2025 Bowman Chrome Sapphire Baseball #95 Yellow", "bowman-chrome-sapphire", "bowman-chrome"],
    ["2025 Bowman Draft Sapphire Baseball #CPA-PF Green", "bowman-draft-sapphire", "bowman-draft"],
    ["2025 Topps Chrome Black Football #RV-12 Base", "topps-chrome-black", "topps-chrome"],
    ["2021 Topps Stadium Club Chrome Ichiro Refractor #87 Mariners", "stadium-club-chrome", "topps-stadium-club"],
    ["2024 Panini Prizm WNBA Basketball #13 Red", "panini-prizm-wnba", "panini-prizm"],
    ["2025 Bowman Chrome Mega Box Baseball #46 Base", "bowman-chrome-mega-box", "bowman-chrome"],
    ["2024 Topps Chrome Logofractor Baseball #55 Base", "topps-chrome-logofractor", "topps-chrome"],
    ["2024 Panini Select WNBA Basketball #70 Bronze Checker", "panini-select-wnba", "panini-select"],
    ["2025 Panini Prizm Black Football #10 Blue", "panini-prizm-black", "panini-prizm"],
    ["2025 Topps Holiday #H1 Shohei Ohtani Blue Metallic Glitter Holiday - Raw", "topps-holiday", "topps"],
  ])("%s -> %s", (title, ruled) => {
    expect(setKeyOf(title)).toBe(ruled);
  });

  // BOWMAN'S BEST IS SPELT FOUR WAYS in the pool, and all four are one product.
  // 267 CONFLICT samples across `bowmans-best -> bowman` and
  // `bowmans-best -> bowman-chrome`.
  it.each([
    "2025 Bowman's Best Baseball #47 Gold Lava",
    "2025 Bowmans Best Baseball #47 Gold Lava",
    "2025 Bowman’s Best Baseball #47 Gold Lava",
  ])("reads Bowman's Best however the seller spells the apostrophe: %s", (title) => {
    expect(setKeyOf(title)).toBe("bowmans-best");
  });

  // THE AMPERSAND IS HOW THE PRODUCT IS PRINTED, and was the single largest
  // fold in the census (246 samples). All three spellings are one product.
  it.each([
    "2025 Topps Allen & Ginter Baseball #8 Base",
    "2025 Topps Allen and Ginter Baseball #8 Base",
    "2025 Topps Allen Ginter Baseball #8 Base",
  ])("reads Allen & Ginter however the seller spells the conjunction: %s", (title) => {
    expect(setKeyOf(title)).toBe("topps-allen-ginter");
  });

  // A LONGEST-MATCH RULE MUST SIT ABOVE THE RULE IT EXTENDS. The Mega Box rule
  // existed but sat BELOW `/bowman\s+chrome/`, so it was dead for every title
  // spelling the product in full -- the commonest spelling by far.
  it("reads Mega Box even when the title also says Chrome", () => {
    expect(setKeyOf("2025 Bowman Chrome Mega Box Baseball #46 Base")).toBe("bowman-chrome-mega-box");
    expect(setKeyOf("2024 Bowman Mega Box Baseball #12 Mojo")).toBe("bowman-chrome-mega-box");
  });

  // THE NEGATIVES. Every rule added is brand-gated, because these words are
  // ordinary. A title naming no Bowman/Topps must not be claimed by one.
  it.each([
    ["2024 Topps Chrome Baseball #150 Base", "topps-chrome"],
    ["2025 Bowman Chrome Baseball #BCP-102 Orange", "bowman-chrome"],
    ["2025 Topps Stadium Club Baseball #12 Base", "topps-stadium-club"],
    ["2024 Panini Prizm Basketball #217 Glitter", "panini-prizm"],
    ["2024 Panini Select Football #141 Pink Shock", "panini-select"],
  ])("leaves a flagship title on its flagship: %s -> %s", (title, key) => {
    expect(setKeyOf(title)).toBe(key);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CF-BLACK-PRIZM-IS-A-PARALLEL-NOT-A-PRODUCT (Drew, 2026-09-20 ruling, same
// batch as the duplicate-rung/Topps-flagship fixes). "Black" is part of the
// PRODUCT phrase "Prizm Black" only when it is adjacent to "Prizm" BEFORE
// the player/number. A plain Prizm title that merely STATES a Black finish
// AFTER the player/number ("... Black Prizm 1/1", "Black Finite", "Black
// Gold") is naming a parallel of the ordinary Prizm card, not the standalone
// Prizm Black release, and must stay `panini-prizm`.
//
// This retracts the "PRE-EXISTING, OUT OF SCOPE" note that used to sit in
// census0920OwnerRulingProductKeysAreFixedPoints.test.ts and updates this
// file's own line 89 pin's SIBLING case (line 89 itself needs no change --
// "Prizm Black Football #10 Blue" is already the PRODUCT ordering and still
// derives to panini-prizm-black).
// ─────────────────────────────────────────────────────────────────────────────
describe("CF-BLACK-PRIZM-IS-A-PARALLEL-NOT-A-PRODUCT: word order decides which", () => {
  it.each([
    // PRODUCT phrase: "Prizm Black" BEFORE the player/number/sport word.
    ["2025 Panini Prizm Black Football #10 Blue"],
    ["2024-25 Panini Prizm Black Victor Wembanyama #1"],
    ["2024 Panini Prizm Black Basketball #99 Red"],
    ["2024 Panini Prizm Black Basketball #85 Silver"],
    ["2024 Panini Prizm Black Basketball #156 Purple"],
    ["2024 Panini Prizm Black Basketball #198 Snakeskin"],
    ["2024 Panini Prizm Black Basketball #299 Blue Ice"],
    ["2025 Panini Prizm Black Baseball #12 Base"],
    ["2024 Panini Prizm Black Football Victor Wembanyama #1 Green"],
  ])("PRODUCT ordering derives to panini-prizm-black: %s", (title) => {
    expect(setKeyOf(title)).toBe("panini-prizm-black");
  });

  it.each([
    // TRAILING PARALLEL: "Black Prizm" / "Black <finish>" AFTER the
    // player/number, on an otherwise-plain Prizm title. Stays panini-prizm.
    ["2024-25 Panini Prizm Basketball Victor Wembanyama Black Prizm 1/1"],
    ["2024 Panini Prizm Wembanyama #1 Black Prizm 1/1"],
    ["2025 Panini Prizm Football #10 Black Prizm"],
    ["2024 Panini Prizm Basketball #217 Black Finite"],
    ["2024 Panini Prizm Basketball #217 Black Finite 1/1"],
    ["2024 Panini Prizm Basketball #217 Black Gold"],
    ["2025 Panini Prizm Baseball #45 Black Gold /5"],
    ["2024 Panini Prizm Football #99 Black Ice"],
    ["2024 Panini Prizm Basketball #22 Black Pulsar"],
    ["2025 Panini Prizm WNBA #7 Black Prizm 1/1", "panini-prizm-wnba"],
    ["2024 Panini Prizm Black & White Checker Checkerboard Prizm #286 JEVON KEARSE - Raw"],
    ["2024 Panini Prizm Black and White Checker Checkerboard Prizm #199 Base"],
    ["2023 Panini Prizm Black Star Promo Wembanyama"],
  ])("TRAILING PARALLEL ordering leaves the flagship (or its other ruled product): %s", (title, expected) => {
    expect(setKeyOf(title)).toBe(expected ?? "panini-prizm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS D -- THE SPORT IS THE PRODUCT'S SPORT
//
// `inferSportFromTitle` is a series of word tests over the whole title, and a
// card number is part of a title. Topps numbers insert subsets with player
// initials, so a real baseball card states a rival sport inside its own number.
// ─────────────────────────────────────────────────────────────────────────────
describe("class D: a card-number token never decides the sport", () => {
  it.each([
    ["2025 Topps Pristine Baseball #PPAR-MMA Base", "baseball"],
    ["2026 Topps Baseball #HLAR-MMA Base", "baseball"],
    ["2026 Topps Baseball #CC-MMA Orange", "baseball"],
    ["2020 Panini Prizm Basketball #SS-AEW Base", "basketball"],
    ["2021 Topps Chrome Baseball #RA-MMA Base", "baseball"],
  ])("%s -> %s", (title, sport) => {
    expect(inferSportFromTitle(title, "")).toBe(sport);
  });

  // THE NEGATIVES ARE THE POINT. Masking the number must cost nothing: a title
  // that names its sport in PRODUCT words still reads it, and the competition
  // and combat-sport branches the rules were added for are untouched.
  it.each([
    ["2024 UFC 300 Jon Jones #12 Base", "mma"],
    ["2020 Topps Chrome WWE BASE CARD #43 Naomi SMACKDOWN", "wrestling"],
    ["2020-21 Topps Chrome UEFA Cristiano Ronaldo Refractor #100 Juventus", "soccer"],
    ["2025 Panini Prizm Football #302 Pink Wave", "football"],
    ["2024 Panini Prizm Basketball #217 Glitter", "basketball"],
  ])("still reads the sport the title states: %s -> %s", (title, sport) => {
    expect(inferSportFromTitle(title, "")).toBe(sport);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASSES A + C -- A STATED PARALLEL SURVIVES, IN THE CHECKLIST'S SPELLING
//
// Both classes turn on one seam: with the product known, the product's OWN
// checklist is the authority for what its parallels are called. The defect was
// that a checklist spells a rung with the product's own stock word inside it
// ("Pink Prizm Shock", "Prizms Purple") and a seller never repeats a word the
// product name already carries -- so the every-word match refused, the reader
// returned null, and either the answer fell to Base (class A) or a hand-built
// family rule one screen higher had already invented a rung (class C/E).
// ─────────────────────────────────────────────────────────────────────────────
describe("classes A + C: a stated parallel survives, spelt as the checklist spells it", () => {
  // THE ANSWER KEEPS THE TITLE'S (AND THE POOL'S) SPELLING. The rung is the
  // checklist's; the product boilerplate the seller omitted is not re-added,
  // because an identity that moves a row off a pool it is correctly in is not
  // an improvement (CF-ONE-CARD-ONE-ROW-ONE-POOL).
  it.each([
    // [title, setKey, year, the stored parallel this must now derive]
    ["2025 Panini Prizm Baseball #150 Purple", "panini-prizm", 2025, "Purple"],
    ["2024 Donruss Optic Basketball #228 Orange", "donruss-optic", 2024, "Orange"],
    ["2025 Panini Certified Football #67 Mirror", "panini-certified", 2025, "Mirror"],
    ["2025 Panini Phoenix Football #1 Green Hyper", "panini-phoenix", 2025, "Green Hyper"],
    ["2025 Topps Cosmic Chrome Football #124 Nucleus Refractor", "topps-cosmic-chrome", 2025, "Nucleus Refractor"],
  ])("%s -> %s", (title, setKey, year, stored) => {
    expect(parallelOf(title, setKey, year)).toBe(stored);
  });

  // A REAL PARALLEL THAT CONTAINS A SPORT WORD IS STILL A PARALLEL. "Football
  // Leather Refractor" is a 2025 Topps Chrome rung; an earlier revision of the
  // sport-word rule refused every name mentioning a sport and discarded it.
  it("keeps a parallel whose own name contains the sport", () => {
    expect(parallelOf("2025 Topps Chrome Football #79 Football Leather Refractor", "topps-chrome", 2025))
      .toBe("Football Leather Refractor");
  });

  // THE REFUSALS THE READER ALREADY MADE MUST STILL HOLD. Each of these is a
  // pin from statedFinishIsNotABaseCard's own draw, restated here because the
  // elision is the change most able to break them.
  it.each([
    ["1999 Flair Showcase Baseball #120 Row 2", "flair", 1999],
    ["1991 Topps Baseball #580 Desert Shield", "topps", 1991],
  ])("still refuses a truncation rather than writing half a name: %s", (title, setKey, year) => {
    expect(parallelOf(title, setKey, year)).toBe("Base");
  });

  // AN EXPLICIT "Base" IN THE TITLE IS THE SELLER'S OWN ANSWER and is never
  // overridden -- CF-NO-REFRACTOR-IS-A-BASE's other half.
  it("never overrides a title that says Base", () => {
    expect(parallelOf("2022 Bowman Chrome Prospects Baseball #CPA-MG Base", "bowman-chrome", 2022)).toBe("Base");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PR DOES NOT FIX, PINNED AS IT STANDS
//
// Two shapes in the census remain wrong after this change, and they are
// recorded here rather than left unstated so the next pass has the measurement
// and so a later fix is visibly a CHANGE to a pin rather than a silent move.
// Both need a reordering of `extractParallel` -- the product-scoped checklist
// reader running BEFORE the hand-built family colour rules -- which is a
// materially larger change than this one and belongs in its own PR with its
// own blast-radius measurement.
// ─────────────────────────────────────────────────────────────────────────────
describe("KNOWN REMAINING: a family colour rule still pre-empts the checklist", () => {
  // CLASS E. `panini-select`'s checklist lists "Pink Prizm Shock"; the title
  // says "Pink Shock" and the stored row says "Pink Shock". The Prizm family
  // colour rule (`(blue|red|...|pink)\s+prizm` and its siblings) sits ~150
  // lines ABOVE the checklist reader and answers "Pink Prizm" -- a rung whose
  // "Shock" the title states and the answer drops. 3,365 CONFLICT samples carry
  // a spelling disagreement; this family-rule pre-emption is a large part of
  // the 2,529 that remain.
  it("still answers a family rung instead of the stated one (Select Shock)", () => {
    expect(parallelOf("2025 Panini Select Football #141 Pink Shock", "panini-select", 2025)).toBe("Pink Prizm");
  });

  // CLASS A, THE HARD REMAINDER. On `topps-finest` every listed parallel ends
  // in Refractor(s), but the singular and plural are counted as different words
  // so neither clears the stock-word floor, AND bare "Refractor" is itself a
  // listed rung -- which this PR deliberately refuses to treat as boilerplate,
  // because it is a real card. A bare "Gold" on that product is therefore
  // genuinely ambiguous between "Gold Refractor" and a Gold the checklist does
  // not list, and absent beats wrong: the reader keeps Base. Resolving it needs
  // singular/plural folding in the corpus builder, not a rule here.
  it("still keeps Base where a bare colour is ambiguous for the product", () => {
    expect(parallelOf("2024 Topps Finest Baseball #93-6 Gold", "topps-finest", 2024)).toBe("Base");
  });
});
