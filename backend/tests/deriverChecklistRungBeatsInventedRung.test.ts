/**
 * THE CHECKLIST NAMES THE RUNG, AND A STOCK WORD IS NOT A RUNG
 * (wave2verify16 sports census, class-A residual of #2135, 2026-09-13).
 *
 * #2135 left 1,313 class-A rows -- a parallel the title STATES, dropped to
 * Base -- and named the cause as ordering: the Prizm/Optic/Select family colour
 * rules in `extractParallel` sit above the checklist rung reader and pre-empt
 * it. MEASURED AGAINST THE RESIDUAL, THAT IS NOT WHAT IS HOLDING IT. Asking
 * `statedFinishFromChecklist` directly for every one of those 1,313 rows, with
 * the product context the row's own slug carries, answers ZERO of them: the
 * reader is not being pre-empted, it is refusing. Reordering the function would
 * have recovered nothing, and was measured doing exactly that (see the PR).
 *
 * What the reader was refusing on, and what this file pins, is TWO FAULTS INSIDE
 * THE READER -- both in the stock-word machinery #2135 introduced, both of which
 * make it answer for a product whose checklist plainly lists the rung the title
 * states.
 *
 * EVERY TITLE IN THIS FILE IS A REAL POOL ROW, taken verbatim from the census
 * artifacts (`…/wave2verify16/artifacts/flat/census-slot-*.json`), and every
 * expected value is either that row's own stored field or the product's own
 * checklist spelling. No title here is invented.
 *
 * ── FAULT 1: A SPORT-ONLY NAME WON THE LONGEST-MATCH RACE AND POISONED THE
 *    ANSWER FOR THE WHOLE PRODUCT ────────────────────────────────────────────
 *
 * Some products list a parallel built from the sport ("Prizms Basketball"). Such
 * a name matches EVERY title of the product and identifies no card, and #2135
 * added a guard that says so. But the guard ran on the WINNER, after the loop,
 * while the winner is chosen by LENGTH -- and a sport-only name is often the
 * longest thing that matches. So it won the race, failed the guard, and the
 * whole call returned null with the real rung sitting unused in the candidate
 * list:
 *
 *   "2024 Panini Prizm Basketball #217 Glitter"
 *      candidates: "Prizms Basketball" (17 chars), "Prizms Glitter" (14 chars)
 *      -> the sport-only name wins on length -> guard refuses -> null -> Base
 *
 * The test is unchanged; only its POSITION moves, into the loop as a
 * disqualification of the candidate. "USA Basketball Gold" and "Football
 * Leather Refractor" keep a distinguishing word and so remain candidates --
 * which is exactly why this has to disqualify the name rather than the call.
 *
 * ── FAULT 2: THE ANSWER STRIPPED A STOCK WORD THE SELLER HAD WRITTEN ────────
 *
 * #2135's answer deliberately drops the product's stock words, so a row keeps
 * the spelling its pool is keyed by (CF-ONE-CARD-ONE-ROW-ONE-POOL), and keeps a
 * stock word the TITLE stated. Both halves were tested by exact token, and both
 * halves were therefore wrong on the products this matters most for:
 *
 *   a) THE NUMBER. Panini lists "Prizms Silver"; the seller writes "Silver
 *      Prizm". `prizms` is not in the title, so the keep-arm missed and the
 *      elision arm fired: "Silver Prizm" -> "Silver". 60 previously-AGREEing
 *      rows were re-spelled this way -- correct rows moved off their own pools.
 *
 *   b) WHOSE WORD IT IS. On `panini-prizm` the word `prizm` is in every title
 *      naming the PRODUCT, so a bare set-membership test reads the product's
 *      own name as proof the seller spelled the rung out, and injects the stock
 *      word into answers for titles that never wrote it: "#217 Glitter" ->
 *      "Prizm Glitter", where checklist and pool both say Glitter.
 *
 * The rung is what the title says APART from the product's name, so a stock
 * word counts as stated only where the title spends it more often than the
 * product name accounts for -- and it is then kept in THE SELLER'S number,
 * because for boilerplate that is the spelling the pool uses.
 *
 * MEASURED over all 7,684 sports CONFLICT and 7,000 AGREE samples:
 *
 *     derives the stored identity (CONFLICT)   1,576  ->  1,823
 *     class A  (stated parallel dropped)       1,313  ->  1,254
 *     class C  (spelling differs)              2,802  ->  2,595
 *     AGREE rows that derive stored             6,707  ->  6,711
 *     AGREE demotions                                       0
 *
 * KNOWN REMAINING, and why it is not an ordering problem. The 1,254 class-A
 * rows that survive are a CHECKLIST COVERAGE gap, not a parser fault: `topps`
 * flagship baseball has no corpus bucket at all for 2024/2025/2026 (the corpus
 * carries only 1984, 2003, 2006 and 2025 basketball), and it is the largest
 * single block of the residual at ~150 rows. `topps-pristine` lists only
 * Refractor rungs while the pool stores "Pristine Blue"; `topps-update-series`
 * lists "Blue Rainbow Foil" and "Blue Holo Foil" but no bare "Blue", so the
 * bare colour is genuinely ambiguous and `bareColourAliasFromChecklist`'s
 * tie-refusal correctly declines it. Absent beats wrong: these are an
 * ACQUISITION list, and no reordering reaches them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import {
  statedFinishFromChecklist,
  _resetStatedFinishCorpus,
} from "../src/services/portfolioiq/statedFinishFromChecklist";

/** The parallel the deriver lands on, WITH the product context the census row
 *  carries on its own slug -- which is what `parseListingIdentity` reads out of
 *  `hobbyiqCardId`, and therefore what the census saw. */
const parallelOf = (title: string, setKey: string, year: number): string =>
  parseListingIdentity(title, undefined, { setKey, year }).parallel;

beforeEach(() => _resetStatedFinishCorpus());

// ─────────────────────────────────────────────────────────────────────────────
// FAULT 1 -- A SPORT-ONLY NAME IS DISQUALIFIED AS A CANDIDATE
//
// Each of these products lists a sport-only name ("Prizms Basketball") that was
// beating the real rung on length and taking the answer down with it. The rung
// each title states is a listed name of that very product.
// ─────────────────────────────────────────────────────────────────────────────
describe("a sport-only checklist name never takes the answer down with it", () => {
  it.each([
    // [title, setKey, year, the rung the product's checklist names]
    ["2024 Panini Prizm Basketball #217 Glitter", "panini-prizm", 2024, "Glitter"],
    ["2024 Panini Prizm Basketball #232 Fast Break", "panini-prizm", 2024, "Fast Break"],
    ["2024 Panini Prizm Basketball #149 Hyper", "panini-prizm", 2024, "Hyper"],
    ["2024 Panini Prizm Basketball #223 Red Ice", "panini-prizm", 2024, "Red Ice"],
    ["2024 Panini Prizm Basketball #180 Orange Ice", "panini-prizm", 2024, "Orange Ice"],
    ["2024 Panini Prizm Black Basketball #99 Red", "panini-prizm-black", 2024, "Red"],
    ["2024 Panini Prizm Black Basketball #85 Silver", "panini-prizm-black", 2024, "Silver"],
    ["2024 Panini Prizm Black Basketball #156 Purple", "panini-prizm-black", 2024, "Purple"],
    ["2024 Panini Prizm Black Basketball #198 Snakeskin", "panini-prizm-black", 2024, "Snakeskin"],
    ["2024 Panini Prizm Black Basketball #299 Blue Ice", "panini-prizm-black", 2024, "Blue Ice"],
  ])("%s -> %s", (title, setKey, year, rung) => {
    expect(parallelOf(title, setKey, year)).toBe(rung);
  });

  // THE RACE ITSELF, at the reader. Without the fix the reader answered null
  // for this title because "Prizms Basketball" is 3 characters longer than the
  // rung the seller actually wrote.
  it("answers the rung, not null, when a sport-only name is the longer match", () => {
    expect(
      statedFinishFromChecklist("2024 Panini Prizm Basketball #217 Glitter", {
        year: 2024,
        setKey: "panini-prizm",
      }),
    ).toBe("Glitter");
  });

  // A SPORT WORD INSIDE A REAL RUNG IS NOT A SPORT-ONLY NAME. The corpus holds
  // 722 multi-word names carrying a sport, and many are real cards -- the guard
  // may only refuse the ones with nothing else in them, which is why it is a
  // per-candidate disqualification and not a filter on the whole corpus.
  it("still answers a real rung whose name contains a sport word", () => {
    expect(
      statedFinishFromChecklist("2025 Topps Chrome Baseball #12 Football Leather Refractor", {
        year: 2025,
        setKey: "topps-chrome",
      }),
    ).toContain("Leather");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAULT 2a -- A STOCK WORD THE SELLER WROTE IS KEPT, IN THE SELLER'S NUMBER
//
// The checklist spells these "Prizms <Colour>"; every seller writes "<Colour>
// Prizm". Before the fix the singular/plural mismatch made the answer drop the
// word entirely ("Silver Prizm" -> "Silver"), moving a correct row off its pool.
// All ten are AGREE-bucket rows: the stored value IS the expected value.
// ─────────────────────────────────────────────────────────────────────────────
describe("a stock word the title states survives, spelled as the seller wrote it", () => {
  it.each([
    // [title, setKey, year, the row's own stored parallel]
    ["2024-25 Panini Prizm - LeBron James #130 Silver Prizm", "panini-prizm", 2024, "Silver Prizm"],
    ["Victor Wembanyama 2024-25 Panini Prizm Green Prizm #172", "panini-prizm", 2024, "Green Prizm"],
    ["2024-25 Panini Prizm - Stephon Castle #234 Red Ice Prizm (RC)", "panini-prizm", 2024, "Red Ice Prizm"],
    ["2024-25 Panini Prizm - Stephen Curry #134 Red Ice Prizm", "panini-prizm", 2024, "Red Ice Prizm"],
    ["2024-25 Panini Prizm Green Ice Prizm Victor Wembanyama #172", "panini-prizm", 2024, "Green Ice Prizm"],
    ["2024-25 Panini Prizm Bronny James #243 Silver Prizm (RC) PSA 9 Mint LA Lakers", "panini-prizm", 2024, "Silver Prizm"],
    ["2020 PANINI PRIZM BLUE PRIZM #33 JOEY VOTTO PSA 10", "panini-prizm", 2020, "Blue Prizm"],
    ["2020 Panini Prizm Baseball #RA-NH Red Prizm", "panini-prizm", 2020, "Red Prizm"],
    ["2020 Panini Prizm Football #300 Silver Prizm", "panini-prizm", 2020, "Silver Prizm"],
    ["2021 Panini Prizm Draft Picks - DK Metcalf #57 Silver Prizm", "panini-prizm-draft-picks", 2021, "Silver Prizm"],
  ])("%s -> %s", (title, setKey, year, stored) => {
    expect(parallelOf(title, setKey, year)).toBe(stored);
  });

  // THE PLURAL IS THE CHECKLIST'S, THE SINGULAR IS THE SELLER'S, AND THE POOL
  // USES THE SELLER'S. Answering "Silver Prizms" would trade the dropped-word
  // disagreement for a plural one and move the row just the same.
  it("keeps the seller's number rather than re-spelling to the checklist's", () => {
    expect(
      statedFinishFromChecklist("2024-25 Panini Prizm - LeBron James #130 Silver Prizm", {
        year: 2024,
        setKey: "panini-prizm",
      }),
    ).toBe("Silver Prizm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAULT 2b -- THE PRODUCT'S NAME IS NOT THE SELLER STATING THE RUNG
//
// `prizm` and `mosaic` are in every title of their product because they NAME
// it. Reading that as evidence the seller spelled the rung out injected the
// stock word into answers for titles that never wrote it. The stored value on
// every one of these rows is the bare rung.
// ─────────────────────────────────────────────────────────────────────────────
describe("a stock word the title never stated is dropped from the answer", () => {
  it.each([
    // [title, setKey, year, the row's own stored parallel]
    ["2025 Panini Mosaic Football #11 Blue", "panini-mosaic", 2025, "Blue"],
    ["2025 Panini Mosaic Football #17 Green", "panini-mosaic", 2025, "Green"],
    ["2025 Panini Mosaic Football #108 Genesis", "panini-mosaic", 2025, "Genesis"],
    ["2025 Panini Mosaic Football #389 Cookies", "panini-mosaic", 2025, "Cookies"],
    ["2025 Panini Mosaic Football #13 Orange Fluorescent", "panini-mosaic", 2025, "Orange Fluorescent"],
    ["2025 Panini Mosaic Football #324 Camo Pink", "panini-mosaic", 2025, "Camo Pink"],
    ["2025 Panini Mosaic Football #309 Reactive Blue", "panini-mosaic", 2025, "Reactive Blue"],
    ["2025 Panini Mosaic Football #354 No Huddle Silver", "panini-mosaic", 2025, "No Huddle Silver"],
    ["2020 Donruss Optic Basketball #25 Holo", "donruss-optic", 2020, "Holo"],
    ["2024 Panini Prizm Monopoly WNBA Basketball #68 Light Blue", "panini-prizm-monopoly-wnba", 2024, "Light Blue"],
  ])("%s -> %s", (title, setKey, year, stored) => {
    expect(parallelOf(title, setKey, year)).toBe(stored);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCT'S OWN NAME IS NEVER THE ANSWER
//
// The same two faults were dropping the product word onto the FRONT of a
// perfectly good answer on the Topps chrome family, where the corpus lists
// "Topps Refractor" as a name in its own right. Every one of these rows stores
// the bare rung, and the title states the bare rung.
// ─────────────────────────────────────────────────────────────────────────────
describe("the product's own name is not prepended to a rung the title states", () => {
  it.each([
    ["2025 Topps Chrome Football #RA-CL Refractor", "topps-chrome", 2025, "Refractor"],
    ["2023 Topps Chrome Update Baseball #USC129 Refractor", "topps-chrome-update-series", 2023, "Refractor"],
    ["2023 Topps Chrome Platinum Baseball #289 Refractor", "topps-chrome-platinum", 2023, "Refractor"],
    ["2023 Topps Heritage Baseball #377 Refractor", "topps-heritage", 2023, "Refractor"],
    ["2020 Topps Finest Will Smith Refractor #46 Dodgers PSA 10 GEM MINT", "topps-finest", 2020, "Refractor"],
    ["2021 Topps Finest Flashbacks Roger Clemens Refractor #214 Red Sox", "topps-finest-flashbacks", 2021, "Refractor"],
    ["2024 Topps Diamond Icons Baseball #DIA-TG Black", "topps-diamond-icons", 2024, "Black"],
    ["2024 Topps Holiday Baseball #H62 Silver Glitter", "topps-holiday", 2024, "Silver Glitter"],
  ])("%s -> %s", (title, setKey, year, stored) => {
    expect(parallelOf(title, setKey, year)).toBe(stored);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSALS THAT MUST SURVIVE
//
// Every widening above is a widening of when the reader ANSWERS, so the pins
// that matter most are the ones where it must still refuse. A reader that
// answers everything is the invented-rung defect wearing a checklist's clothes.
// ─────────────────────────────────────────────────────────────────────────────
describe("the reader still refuses what it refused before", () => {
  // A TITLE THAT SAYS "BASE" HAS ALREADY ANSWERED (CF-NO-REFRACTOR-IS-A-BASE).
  it("never overrides an explicit Base in the title", () => {
    expect(
      statedFinishFromChecklist("2024 Panini Prizm Basketball #217 Base", {
        year: 2024,
        setKey: "panini-prizm",
      }),
    ).toBeNull();
  });

  // NO PRODUCT CONTEXT, NO PRODUCT CHECKLIST. The stock-word elision is only
  // available on the product-scoped path; with no setKey the global index keeps
  // its stricter floors and the reader degrades to the strict every-word test.
  it("does not elide a stock word without product context", () => {
    expect(
      statedFinishFromChecklist("2024 Panini Prizm Basketball #217 Glitter", {}),
    ).not.toBe("Prizms Glitter");
  });

  // A COLOUR IS NEVER ELIDABLE. The colour is the axis that tells one rung from
  // its siblings, so forgiving an unstated one would let "Gold Prizm Shock"
  // answer a title that says only "Shock".
  it("never forgives an unstated colour", () => {
    const answer = statedFinishFromChecklist("2025 Panini Select Football #141 Shock", {
      year: 2025,
      setKey: "panini-select",
    });
    expect(answer === null || !/gold|pink|silver/i.test(answer)).toBe(true);
  });

  // THE FAMILY RULES STILL PRE-EMPT THE READER WHERE THEY MATCH, PINNED AS IT
  // STANDS (the KNOWN REMAINING #2135 recorded).
  //
  // "Purple Pulsar" and "Fast Break Red" reach the Prizm family colour rules,
  // which append the family's stock word and answer "Purple Pulsar Prizm" --
  // while the pool stores the bare rung. Reordering the reader ahead of those
  // rules FIXES these three and COSTS more than it fixes: measured over the
  // 7,000 AGREE samples, it recovers 175 CONFLICT rows and demotes 35 AGREE
  // rows, because for the vast majority of Prizm titles the family rule's
  // spelling IS the pool's spelling. Net-negative on the only axis that
  // matters, so it is not taken here and the behaviour is pinned instead.
  //
  // Fixing it properly means teaching the reader the family's word ORDER, not
  // moving the call -- and that is its own change with its own measurement.
  it.each([
    ["2024 Panini Prizm Basketball #268 Fast Break Red", "panini-prizm", 2024, "Fast Break Red Prizm"],
    ["2024 Panini Prizm Basketball #55 Purple Pulsar", "panini-prizm", 2024, "Purple Pulsar Prizm"],
    ["2025 Panini Prizm Baseball #55 Blue Pulsar", "panini-prizm", 2025, "Blue Pulsar Prizm"],
  ])("family rule still answers first: %s -> %s", (title, setKey, year, familyAnswer) => {
    expect(parallelOf(title, setKey, year)).toBe(familyAnswer);
  });

  // THE CLASS-A RESIDUAL IS A COVERAGE GAP, PINNED AS IT STANDS. `topps`
  // flagship baseball has no corpus bucket for these years at all, so the
  // reader has nothing to read and the row keeps Base. This pin is here so that
  // acquiring the checklist is visibly a CHANGE TO A PIN rather than a silent
  // move -- and so nobody re-reads this residual as an ordering fault.
  it("still cannot answer for a product the corpus does not carry", () => {
    expect(
      statedFinishFromChecklist("2024 Topps Baseball #659 Gold", {
        year: 2024,
        setKey: "topps",
      }),
    ).toBeNull();
  });
});
