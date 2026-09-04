/**
 * GUARD 6 -- THE TITLE NAMES A PRODUCT THE DERIVED setKey DOES NOT CARRY.
 *
 * CF-A-BLANK-STORED-KEY-IS-NOT-A-LICENCE-TO-GUESS-THE-FLAGSHIP.
 *
 * THE AUDIT THIS PINS. The GREAT REMATCH IMPROVE census on shard 31
 * (GitHub run 33895164674) emitted 287 IMPROVE evidence rows spanning 134
 * distinct cards. Judged as a collector, 105 of them -- 36.6% -- were WRONG:
 * the derivation answered a FLAGSHIP setKey to a title that plainly names a
 * distinct product or an insert set, and because the stored key was blank
 * ("", "unknown", "base-set") the axis diff read `filled:setKey`, which is an
 * improvement by every test the classifier had.
 *
 * `filled:setKey` was 5,184 of that shard's 5,208 IMPROVE rows, so this was
 * not an edge: it was the class's DOMINANT SHAPE, and it was unguarded.
 * Guard 3 (`derivationCollapsesProduct`) exists to refuse exactly this, but it
 * compares STORED against DERIVED and returns null on its first line when the
 * stored key is blank -- so it was structurally blind on every row that
 * mattered.
 *
 * THE FIXTURES ARE THE REAL ROWS, quoted from the run log. Each must classify
 * NOT WRITABLE with a named reason. Beside each sits its CONTROL -- the
 * genuine base card of the same product and year, which must STAY writable.
 * A guard that stops everything is an off switch, not a guard.
 *
 * WHY REFUSE RATHER THAN REDIRECT. Naming the right product is the census's
 * job and the refusal string carries that name, but this arm never moves the
 * row there: landing a sale on a specialization requires that child's OWN
 * checklist backing, which SPECIALIZATION-STATED demands and which is not in
 * evidence for these rows. A row this guard refuses stays CONFLICT/
 * UNDERIVABLE -- reported to Drew, never written.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

const REFUSAL = /improve-title-names-a-product-the-derivation-dropped/;

/**
 * The audit's row shape: a stored key that names nothing (the blank shapes
 * that made Guard 3 blind), a derivation that FILLED it with a flagship, and a
 * checklist-backed destination. Exactly what reached `writable: true`.
 */
function row(o: {
  title: string; year: number; derivedSetKey: string; cardNumber: string;
  storedSetKey?: string; sport?: string;
}) {
  const sport = o.sport ?? "baseball";
  const storedSetKey = o.storedSetKey ?? "unknown";
  const slug = `hiq:${sport}:${o.year}:${storedSetKey}:${o.cardNumber.toLowerCase()}:base:no-auto`;
  return K.classifyRow({
    row: { id: "row-1", cardId: slug, source: "tca-ebay", title: o.title },
    stored: {
      sport, cardYear: o.year, setKey: storedSetKey, cardNumber: o.cardNumber,
      parallel: "Base", isAuto: false, printRun: null,
    },
    derived: {
      sport, cardYear: o.year, setKey: o.derivedSetKey, cardNumber: o.cardNumber,
      parallel: "Base", isAuto: false, printRun: null,
    },
    checklistBacked: true, storedSlug: slug, titleStatesNumber: true,
  });
}

/** Every fixture below is a VERBATIM title from the shard-31 run log. */
const LEAKS: Array<{ what: string; title: string; year: number; key: string; num: string; names: string }> = [
  // -- Pacific: 49 of the 105. Three products, one destination. ------------
  {
    what: "1995 Pacific Prism is a STANDALONE 108-card set, not the Pacific base",
    title: "1995 Pacific Prism Greg Maddux #4 Atlanta Braves HOF - Raw",
    year: 1995, key: "pacific", num: "4", names: "pacific-prism",
  },
  {
    what: "Crown Collection Prisms is an INSERT of a different product",
    title: "1995 Pacific Crown Collection Prisms Rickey Henderson #102 HOF - Raw",
    year: 1995, key: "pacific", num: "102", names: "pacific-crown-collection-prisms",
  },
  {
    what: "Gold Crown Die-Cuts is an insert; note SINGULAR Die-Cut in the title",
    title: "1995 Pacific Gold Crown Die-Cut Cal Ripken Jr #4 PSA 10 GEM MINT",
    year: 1995, key: "pacific", num: "4", names: "pacific-gold-crown-die-cuts",
  },
  // -- Upper Deck: SP is its own product, and #181 is the reason it matters -
  {
    what: "1995 Upper Deck SP is a distinct product; SP #181 Jeter is not UD #181",
    title: "1995 Upper Deck SP Derek Jeter #181 PSA 9 Mint HOF New York Yankees",
    year: 1995, key: "upper-deck", num: "181", names: "upper-deck-sp",
  },
  // -- Topps: a physically different card on the same checklist -------------
  {
    what: "1975 Topps Mini is a separate product from 1975 Topps",
    title: "1975 TOPPS BASEBALL MINI #5 NOLAN RYAN!! $1 SHIPPING!! - Raw",
    year: 1975, key: "topps", num: "5", names: "topps-mini",
  },
  // -- Score: own #NNT numbering, exactly as Topps Traded has ---------------
  {
    what: "1989 Score Traded numbers its own cards #NNT",
    title: "#1 1989 Score Traded #100T Ken Griffey Jr Mariners RC Rookie HOF PSA",
    year: 1989, key: "score", num: "100T", names: "score-traded",
  },
  // -- Fleer / Pinnacle ----------------------------------------------------
  {
    what: "1995-96 Fleer Metal is distinct from Fleer",
    title: "1995-96 Fleer Metal Nuts & Bolts Michael Jordan #212 Chicago Bulls",
    year: 1995, key: "fleer", num: "212", names: "fleer-metal",
  },
  {
    what: "1995 Pinnacle UC3 is its own product, not a Pinnacle parallel",
    title: "1995 Pinnacle UC3 - Ken Griffey Jr - #73 - Seattle Mariners - Raw 10",
    year: 1995, key: "pinnacle", num: "73", names: "pinnacle-uc3",
  },
  // -- GATE 4 slot-31 (2026-09-04). The judge's five remaining collapse
  //    cases, 12 of 924 writable rows. FOUR OF THE FIVE WERE ALREADY REFUSED
  //    by this guard on main -- the gate's NO-GO was read off a STALE
  //    pre-#1773 artifact, taken before the guard learned to ask its question
  //    of the STORED key as well as the derived one. They are pinned here so
  //    the claim "already covered" is a test and not a memory, and so the
  //    coverage cannot regress silently the way it was believed to be absent.
  //
  //    The FIFTH, `upper-deck-uda`, was genuinely open, and the gap was
  //    vocabulary alone: no table declared UDA a child of upper-deck, so the
  //    guard had nothing to match. Declaring it in DISTINCT_PRODUCT_SETKEYS is
  //    the entire fix -- no new guard. See MUTATION 3 below.
  {
    what: "GATE 4: Upper Deck Special Edition #31 is Olajuwon; base UD #31 is another player",
    title: "1991 Upper Deck Special Edition #31 Hakeem Olajuwon Houston Rockets",
    year: 1991, key: "upper-deck", num: "31", names: "upper-deck-special-edition",
  },
  {
    what: "GATE 4: Topps Micro/Mini is a physically different card",
    title: "1991 Topps Micro/Mini Ken Griffey Jr #790 Seattle Mariners - Raw 10",
    year: 1991, key: "topps", num: "790", names: "topps-mini",
  },
  {
    what: "GATE 4: Topps Holsum is a 33-card food issue against Topps's 528",
    title: "1990 Topps Holsum Ken Griffey Jr #4 - Raw 10",
    year: 1990, key: "topps", num: "4", names: "topps-holsum",
  },
  {
    what: "GATE 4: Upper Deck Minors runs its own 1-N, not the flagship checklist",
    title: "1992 Upper Deck Minors Derek Jeter #5 Greensboro Hornets RC",
    year: 1992, key: "upper-deck", num: "5", names: "upper-deck-minors",
  },
  {
    what: "GATE 4: UDA is Upper Deck AUTHENTICATED -- signed memorabilia, not a set card",
    title: "1991 Upper Deck UDA Michael Jordan #1 Authenticated Chicago Bulls",
    year: 1991, key: "upper-deck", num: "1", names: "upper-deck-uda",
  },
];

/**
 * THE CONTROLS. Genuine base cards of the same product and year, whose stored
 * key is equally blank -- the rows the IMPROVE arm exists to fix. Every one
 * must stay writable, or the guard is an off switch.
 */
const CONTROLS: Array<{ title: string; year: number; key: string; num: string }> = [
  { title: "1995 Pacific #108 Barry Larkin PSA 10 Pop 4", year: 1995, key: "pacific", num: "108" },
  { title: "1995 Pacific #416 Ozzie Smith - Raw 10", year: 1995, key: "pacific", num: "416" },
  { title: "1989 Upper Deck Ken Griffey Jr #1 (RC) - Raw", year: 1989, key: "upper-deck", num: "1" },
  { title: "1975 Topps #5 Nolan Ryan - California Angels - Raw", year: 1975, key: "topps", num: "5" },
  { title: "1978 Topps #400 Nolan Ryan - Raw", year: 1978, key: "topps", num: "400" },
  { title: "1989 Fleer Ken Griffey Jr. Rookie RC #548 - Raw", year: 1989, key: "fleer", num: "548" },
  { title: "1989 Bowman #220 Ken Griffey, Jr. - Raw", year: 1989, key: "bowman", num: "220" },
  // GATE 4: `uda` is a THREE-LETTER token, so its controls matter more than
  // most. `titleStatesWord` is boundary-anchored and these prove it -- a
  // substring hit would refuse the whole Upper Deck flagship pool.
  { title: "1992 Upper Deck Bermuda Triangle Insert #12 - Raw", year: 1992, key: "upper-deck", num: "12" },
  { title: "1991 Upper Deck #500 Nolan Ryan Baseball Update", year: 1991, key: "upper-deck", num: "500" },
];

describe("GUARD 6 -- a title naming a distinct product refuses the IMPROVE", () => {
  for (const leak of LEAKS) {
    it(`refuses: ${leak.what}`, () => {
      const res = row({ title: leak.title, year: leak.year, derivedSetKey: leak.key, cardNumber: leak.num });
      const named = (res.improveRefusals ?? []).filter((r: string) => REFUSAL.test(r));
      expect(named.length, `no refusal for: ${leak.title}`).toBeGreaterThan(0);
      // The refusal must NAME the product the title actually states, so the
      // census report is a repair list and not just a rejection.
      expect(named[0]).toContain(`title-names:${leak.names}`);
      // And the row must not be writable under any scope that arms IMPROVE.
      expect(res.writable).toBe(false);
      expect(K.writableUnderScope(res, new Set([K.IMPROVE]))).toBe(false);
    });
  }

  for (const c of CONTROLS) {
    it(`still improves the genuine base card: ${c.title.slice(0, 48)}`, () => {
      const res = row({ title: c.title, year: c.year, derivedSetKey: c.key, cardNumber: c.num });
      const named = (res.improveRefusals ?? []).filter((r: string) => REFUSAL.test(r));
      expect(named, `guard fired on a genuine base card: ${c.title}`).toEqual([]);
      expect(res.klass).toBe(K.IMPROVE);
      expect(res.writable).toBe(true);
    });
  }

  /**
   * THE 1987 TIFFANY ROW. Drew's own holding, and the shape that proves this
   * guard is not only about blank stored keys: here the stored key is the
   * FLAGSHIP and the derivation answered its child while DROPPING the word the
   * title states. Measured read-only on slot 19: 7 sampled IMPROVE rows of
   * this shape, all of which would have moved a Tiffany sale onto the base
   * product, against CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD.
   */
  /**
   * The row is driven through the SPECIALIZATION-STATED arm, because that is
   * the arm the real row took: stored `topps`, derived `topps-traded`, with
   * the strict-checklist and flagship-numbering inputs the census supplies.
   * That subclass is what WIDENS which rows reach the IMPROVE gate, so it is
   * exactly the arm a new refusal has to be proved against -- a guard that
   * only covered the ordinary arm would leave this one open.
   */
  function tiffanyRow(title: string) {
    const slug = "hiq:baseball:1987:topps:70t:base:no-auto";
    return K.classifyRow({
      row: { id: "row-1", cardId: slug, source: "tca-ebay", title },
      stored: {
        sport: "baseball", cardYear: 1987, setKey: "topps", cardNumber: "70t",
        parallel: "Base", isAuto: false, printRun: null,
      },
      derived: {
        sport: "baseball", cardYear: 1987, setKey: "topps-traded", cardNumber: "70T",
        parallel: "Base", isAuto: false, printRun: null,
      },
      checklistBacked: true, storedSlug: slug, titleStatesNumber: true,
      derivedBackedStrict: true, storedFlagshipListsCardNumber: false,
    });
  }

  it("refuses a Topps Traded destination when the title says Tiffany", () => {
    const res = tiffanyRow(
      "1987 Topps Traded - Greg Maddux #70T Tiffany (RC) - MINT Condition, Tough HOF!!!",
    );
    // It IS the subclass that widened the gate -- and the guard still bites.
    expect(res.subclass).toBe(K.SPECIALIZATION_STATED);
    const named = (res.improveRefusals ?? []).filter((r: string) => REFUSAL.test(r));
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]).toContain("title-names:topps-traded-tiffany");
    expect(res.writable).toBe(false);
  });

  it("still promotes the Topps Traded row whose title does NOT say Tiffany", () => {
    const res = tiffanyRow("1987 Topps Traded - Greg Maddux #70T (RC) - Raw");
    const named = (res.improveRefusals ?? []).filter((r: string) => REFUSAL.test(r));
    expect(named).toEqual([]);
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(true);
  });

  /**
   * MUTATION CHECK. The guard is reverted by driving its own predicate the way
   * it behaved BEFORE the fix -- exact-token matching only, which is what let
   * the singular "Die-Cut" title through -- and the pin must go red.
   * A guard that cannot be broken by removing it was not doing anything.
   */
  it("MUTATION: exact-token-only matching lets the singular Die-Cut leak", () => {
    const title = "1995 Pacific Gold Crown Die-Cut Cal Ripken Jr #4 PSA 10 GEM MINT";
    const words = K.distinguishingWords("pacific-gold-crown-die-cuts", "pacific");
    // The shipped test: word, or its bare singular.
    const shipped = words.every(
      (w: string) => K.titleStatesWord(title, w) || (w.endsWith("s") && K.titleStatesWord(title, w.slice(0, -1))),
    );
    // The reverted test: exact token only.
    const reverted = words.every((w: string) => K.titleStatesWord(title, w));
    expect(shipped).toBe(true);
    expect(reverted).toBe(false);
  });

  /**
   * MUTATION CHECK 2. The vocabulary is what makes the guard bite. If a
   * flagship declares no child for a product the audit proved exists, the
   * guard is inert for it -- so each leak's destination must be declared.
   */
  it("MUTATION: every audited product is declared a child of its flagship", () => {
    for (const leak of LEAKS) {
      const children = K.SPECIALIZATION_CHILDREN_OF(leak.key);
      expect(children, `${leak.key} declares no child ${leak.names} -- guard 6 is inert for it`)
        .toContain(leak.names);
    }
  });

  /**
   * MUTATION CHECK 3 -- THE `upper-deck-uda` DECLARATION IS THE WHOLE FIX.
   *
   * GATE 4 opened asking for a new "GUARD 10". Four of its five cases were
   * already refused (pinned above), and the fifth failed for one reason only:
   * `SPECIALIZATION_CHILDREN_OF("upper-deck")` did not list `upper-deck-uda`,
   * so GUARD 6's question -- "is there a declared child of this key whose
   * distinguishing word the title states?" -- had nothing to match.
   *
   * This drives the guard's own predicate with the declaration REMOVED from
   * the child list, exactly as it stood before this change, and asserts the
   * refusal disappears. Delete the DISTINCT_PRODUCT_SETKEYS entry and this
   * goes red -- which is what makes it a pin rather than a restatement.
   */
  it("MUTATION: removing the upper-deck-uda declaration reopens the leak", () => {
    const title = "1991 Upper Deck UDA Michael Jordan #1 Authenticated Chicago Bulls";
    const statesChild = (child: string) => {
      const words = K.distinguishingWords(child, "upper-deck");
      return words.length > 0 && words.every((w: string) => K.titleStatesWord(title, w));
    };
    const shipped = K.SPECIALIZATION_CHILDREN_OF("upper-deck");
    expect(shipped, "upper-deck-uda is not declared -- guard 6 is inert for it")
      .toContain("upper-deck-uda");
    // The shipped vocabulary names a child this title states...
    expect(shipped.some(statesChild)).toBe(true);
    // ...and the pre-fix vocabulary, with that one entry gone, names none.
    const reverted = shipped.filter((c: string) => c !== "upper-deck-uda");
    expect(reverted.some(statesChild)).toBe(false);
  });
});
