/**
 * CF-BECKETT-ROSTER-FOLD-FOR-NAMELESS-SECTIONS (2026-09-19).
 *
 * classifySections's existing fold only ever tries a section against an
 * anchor whose NAME it extends (extendsName) or an explicitAnchor paired with
 * a FINISH_WORD spelling. Neither test can see a section like "Hobby
 * Exclusive" or "Super Box Exclusive": it shares no name token with "Base
 * Set" and is not a colour/finish word, so it fell through to `own-cards`
 * with a blank parallel column even when every card it lists is, in fact,
 * the identical base card by number AND by player.
 *
 * Measured directly against 2026 Topps Series 1 Baseball (Beckett S3,
 * 2026-09-19, staged on PR #2289): 7 sections share this shape. 5 are clean
 * 100% roster subsets of Base Set on every shared number (Hobby Exclusive,
 * Retail Tin Exclusive, Real One Relics, Flagship Real One Autographs, 1952
 * Base Variation Autographs); 2 more (Super Box Exclusive, Funko Pop
 * Autographs) are clean subsets EXCEPT for one card each (#420 Luis Arraez)
 * with no base counterpart at all -- base's own numbering ends at #350.
 *
 * Extracts below are SMALL, hand-built section descriptors carrying the exact
 * measured shape (numbers, rosters, RC tagging) of a handful of real rows
 * from that file -- not the whole 2,943-row workbook -- built directly
 * against classifySections's own input contract (the same shape main()
 * builds in pass 1: sheet, section, key, category, numbers: Set, roster: Map,
 * cards).
 *
 * FIRST, A SEPARATE DEFECT FOUND WHILE MEASURING: Beckett's own RC (rookie
 * card) flag is appended to the player field ("Jonah Tong RC") by SOME
 * sheets (Base, and any parallel section sharing its column layout) and never
 * by others for the identical card/number -- 71 rookies on Topps Series 1
 * alone. Left in, two rows for the SAME card would roster-compare as a
 * disagreement (different player strings) when they name the same person.
 * normalizeRosterPlayer strips a trailing " RC" before comparing, and pass 3
 * strips it from every emitted `player` cell (the checklist-csv-contract has
 * no rookie/RC column, so none is invented -- the flag is simply not carried
 * into the CSV; cleanPlayerName downstream has no RC handling either, so
 * leaving it in would mint `playerSlug` values like "jonah-tong-rc" that
 * never match the same player's own other rows or any sale).
 *
 * THE NEGATIVE CASE, from 2024 Panini Photogenic Football (already committed
 * as a fixture): "Base Autographs" (signed, same roster as Base Set) and
 * "Base Silver Autographs" (a Silver rung ON Base Autographs, not on plain
 * base) must NOT be swept up by this fold -- CF-A-COLOUR-RUNG-IS-NEVER-A-
 * CARD-SET-KEY's own photogenic ruling requires "Base Autographs" to stand as
 * its own anchor so "Base Silver Autographs" folds onto IT, never onto plain
 * Base Set directly. This is why the fold runs as a SEPARATE pass after every
 * name-based fold has finished (a section already claimed as a hub by some
 * OTHER section is excluded), and only ever targets the file's actual
 * flagship run (PLAIN_SECTION), never merely `category === "base"` -- a
 * workbook can carry several base-category anchors side by side (2024 Panini
 * Zenith Football's Base sheet holds "Base Set", "Rookies" AND "Rookie Patch
 * Autographs", all category "base"; Zenith's own #2276 registration folds a
 * same-roster retailer-name Rookies Autographs cluster onto "Rookies" as its
 * own registered product, never onto plain "Base Set").
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifySections, normalizeRosterPlayer, rosterFoldAgainst } = require("../scripts/convertBeckettChecklistXlsx.cjs");

type SectionInput = {
  sheet: string;
  section: string;
  category: string;
  rows: Array<{ cardNumber: string; player: string }>;
};

/** Builds the exact Map<string, SectionDescriptor> shape main()'s pass 1
 *  hands to classifySections, from a small list of (sheet, section, category,
 *  rows) extracts -- never a whole workbook. */
function buildSections(inputs: SectionInput[]) {
  const sections = new Map<string, any>();
  for (const inp of inputs) {
    const key = `${inp.sheet}>${inp.section}`;
    const numbers = new Set<string>();
    const roster = new Map<string, Set<string>>();
    for (const r of inp.rows) {
      const num = r.cardNumber.toUpperCase();
      numbers.add(num);
      if (!roster.has(num)) roster.set(num, new Set());
      roster.get(num)!.add(normalizeRosterPlayer(r.player));
    }
    sections.set(key, {
      sheet: inp.sheet, section: inp.section, key,
      category: inp.category, numbers, roster,
      cards: inp.rows.length, ladder: [],
    });
  }
  return sections;
}

describe("normalizeRosterPlayer strips the RC flag before comparing", () => {
  it("treats '<Name> RC' and '<Name>' as the same roster entry", () => {
    expect(normalizeRosterPlayer("Jonah Tong RC")).toBe(normalizeRosterPlayer("Jonah Tong"));
    // Reduced through playerIdentityKey (2026-09-20 review fix), which
    // folds each name to bare a-z0-9 -- no space, same as every other
    // punctuation/case difference the shared reduction treats as noise.
    expect(normalizeRosterPlayer("Jonah Tong RC")).toBe("jonahtong");
  });

  it("still normalizes player order, spacing and case (R67's own rule) alongside the RC strip", () => {
    const a = normalizeRosterPlayer("Xavier Legette RC/Will Shipley");
    const b = normalizeRosterPlayer(" Will Shipley / Xavier Legette rc ");
    expect(a).toBe(b);
  });

  it("does not strip a real name that merely ends in the letters RC", () => {
    // Guard against an over-eager strip: a hypothetical surname ending "Marc"
    // must survive. The regex requires a WORD BOUNDARY before "RC", not a
    // bare substring match.
    expect(normalizeRosterPlayer("Cedric Marc")).toBe("cedricmarc");
  });

  it("REVIEW FIX (2026-09-20): a punctuation/case transcription variant is not a disagreement", () => {
    // The exact shape a roster-gated fold decision (Defect 2) or a repeated-
    // header split (Defect 4) must never mistake for two different players.
    expect(normalizeRosterPlayer("Ja'Marr Chase")).toBe(normalizeRosterPlayer("JaMarr Chase"));
    expect(normalizeRosterPlayer("Ja'Marr Chase")).toBe(normalizeRosterPlayer("Ja Marr Chase"));
  });

  it("a genuine generational-suffix difference still disagrees — a suffix is not an accent", () => {
    // playerIdentityKey's own doctrine (see its header): "Charizard" vs
    // "Charizard ex" must stay distinct because whether the bare name is a
    // truncated transcription or a different card is a checklist question,
    // not an orthography one. The same caution applies to a name that may
    // or may not carry "Jr." -- this reduction does not decide it, and the
    // roster-fold callers still see a real disagreement here, correctly.
    expect(normalizeRosterPlayer("Michael Penix Jr.")).not.toBe(normalizeRosterPlayer("Michael Penix"));
  });
});

describe("2026 Topps Series 1 Baseball's 5 clean sections fold onto Base Set", () => {
  const BASE_ROWS = [
    { cardNumber: "1", player: "Aaron Judge" },
    { cardNumber: "4", player: "Jonah Tong RC" }, // Base sheet carries the RC flag
    { cardNumber: "10", player: "Jacob Misiorowski RC" },
    { cardNumber: "20", player: "Vladimir Guerrero Jr." },
  ];

  function classifyAgainstBase(section: string, category: string, rows: Array<{ cardNumber: string; player: string }>) {
    const sections = buildSections([
      { sheet: "Base", section: "Base Set", category: "base", rows: BASE_ROWS },
      { sheet: "Variations", section, category, rows },
    ]);
    return classifySections(sections);
  }

  it("Hobby Exclusive: same numbers, same players (no RC), zero disagreements -> folds", () => {
    const report = classifyAgainstBase("Hobby Exclusive", "insert-hobby-exclusive", [
      { cardNumber: "1", player: "Aaron Judge" },
      { cardNumber: "4", player: "Jonah Tong" }, // Variations sheet never carries RC
      { cardNumber: "10", player: "Jacob Misiorowski" },
    ]);
    const sec = report.find((r: any) => r.section === "Hobby Exclusive");
    expect(sec.role).toBe("parallel");
    expect(sec.rung).toBe("Hobby Exclusive");
    expect(sec.rosterFold).toBe(true);
    expect(sec.agree).toBe(3);
    expect(sec.disagree ?? 0).toBe(0);
  });

  it("a real disagreement (different player at a shared number) refuses the fold", () => {
    const report = classifyAgainstBase("Impostor Exclusive", "insert-impostor-exclusive", [
      { cardNumber: "1", player: "Aaron Judge" },
      { cardNumber: "4", player: "Someone Else" }, // #4 is Jonah Tong on base
    ]);
    const sec = report.find((r: any) => r.section === "Impostor Exclusive");
    expect(sec.role).not.toBe("parallel");
    expect(sec.role).toBe("own-cards");
  });

  it("rosterFoldAgainst reports agree/disagree/extra directly, independent of classifySections", () => {
    const sections = buildSections([
      { sheet: "Base", section: "Base Set", category: "base", rows: BASE_ROWS },
    ]);
    const base = sections.get("Base>Base Set");
    const secRows = [
      { cardNumber: "1", player: "Aaron Judge" },
      { cardNumber: "4", player: "Jonah Tong" },
      { cardNumber: "420", player: "Luis Arraez" }, // no base counterpart
    ];
    const roster = new Map<string, Set<string>>();
    for (const r of secRows) {
      const n = r.cardNumber.toUpperCase();
      if (!roster.has(n)) roster.set(n, new Set());
      roster.get(n)!.add(normalizeRosterPlayer(r.player));
    }
    const fold = rosterFoldAgainst({ roster }, base);
    expect(fold.agree).toBe(2);
    expect(fold.disagree).toBe(0);
    expect(fold.extra).toEqual(["420"]);
  });
});

describe("R67's #420 shape: a clean subset PLUS one card with no base counterpart", () => {
  it("folds the clean-subset numbers and holds the orphan out, not a disagreement", () => {
    const sections = buildSections([
      {
        sheet: "Base", section: "Base Set", category: "base",
        rows: [
          { cardNumber: "1", player: "Aaron Judge" },
          { cardNumber: "20", player: "Vladimir Guerrero Jr." },
          // base's own numbering ends here -- no #420 on base, same as the
          // real file (base ends at #350).
        ],
      },
      {
        sheet: "Inserts", section: "Super Box Exclusive", category: "insert-super-box-exclusive",
        rows: [
          { cardNumber: "1", player: "Aaron Judge" },
          { cardNumber: "20", player: "Vladimir Guerrero Jr." },
          { cardNumber: "420", player: "Luis Arraez" }, // the orphan
        ],
      },
    ]);
    const report = classifySections(sections);
    const sec = report.find((r: any) => r.section === "Super Box Exclusive");
    expect(sec.role).toBe("parallel");
    expect(sec.rosterFold).toBe(true);
    expect(sec.agree).toBe(2);
    expect(sec.disagree ?? 0).toBe(0);
    expect(sec.heldNumbers).toEqual(["420"]);
  });
});

describe("negative case: a same-roster signed section that another section extends must NOT roster-fold onto plain base", () => {
  it("'Base Autographs' stays its own anchor so 'Base Silver Autographs' can fold onto IT (Photogenic shape)", () => {
    const baseRows = [
      { cardNumber: "1", player: "Ja'Marr Chase" },
      { cardNumber: "2", player: "Justin Herbert" },
    ];
    const sections = buildSections([
      { sheet: "Base", section: "Base Set", category: "base", rows: baseRows },
      // Signed, same roster as base -- a roster-fold-only view would pull
      // this straight onto Base Set. It must not: "Base Silver Autographs"
      // extends ITS name (extendsName), so it needs to survive as its own
      // hub for that fold to have somewhere to land.
      { sheet: "Autographs", section: "Base Autographs", category: "auto-base-autographs", rows: baseRows },
      { sheet: "Autographs", section: "Base Silver Autographs", category: "auto-base-autographs-silver", rows: baseRows },
    ]);
    const report = classifySections(sections);
    const baseAutos = report.find((r: any) => r.section === "Base Autographs");
    const silverAutos = report.find((r: any) => r.section === "Base Silver Autographs");
    // "own-cards" is the report role for a section that becomes its own
    // anchor via the ordinary fallback (no fold found for it) -- verified
    // against the real fixture's own manifest.sectionsReport entry for this
    // exact section. It is still `isAnchor: true` internally (that is what
    // lets "Base Silver Autographs" fold onto it below); "own-cards" is what
    // the report calls that outcome, distinct from the "anchor" role used
    // only for a section identified as an anchor OUTRIGHT (category "base" or
    // PLAIN_SECTION) that never went through the fold loop at all.
    expect(baseAutos.role).toBe("own-cards");
    expect(silverAutos.role).toBe("parallel");
    expect(silverAutos.anchor).toBe("Autographs>Base Autographs");
    expect(silverAutos.rung).toBe("Silver");
    // Never folded onto plain Base Set directly.
    expect(baseAutos.anchor).toBeUndefined();
  });

  it("a workbook with several base-category anchors folds a nameless section only onto the true flagship (PLAIN_SECTION), never a same-sheet sibling (Zenith shape)", () => {
    const flagshipRows = [
      { cardNumber: "1", player: "Caleb Williams" },
      { cardNumber: "2", player: "Jayden Daniels" },
    ];
    const rookiesRows = [
      { cardNumber: "101", player: "Marvin Harrison Jr." },
      { cardNumber: "102", player: "Malik Nabers" },
    ];
    const sections = buildSections([
      // Both on the Base sheet, both category "base" -- CF-BECKETT-BASE-
      // SHEET-IS-NOT-ONE-SECTION's own shape. Only "Base Set" matches
      // PLAIN_SECTION; "Rookies" does not.
      { sheet: "Base", section: "Base Set", category: "base", rows: flagshipRows },
      { sheet: "Base", section: "Rookies", category: "base", rows: rookiesRows },
      // Same roster as "Rookies" (a retailer-name spelling of the identical
      // 2-card checklist), no name relationship to either base-category
      // section -- this must fold onto "Rookies" only if it independently
      // earns that via its own name/finish evidence, and must NEVER land on
      // "Base Set" merely because that section is also category "base".
      { sheet: "Autographs", section: "Rookies Autographs No Huddle", category: "auto-rookies-autographs-no-huddle", rows: rookiesRows },
    ]);
    const report = classifySections(sections);
    const noHuddle = report.find((r: any) => r.section === "Rookies Autographs No Huddle");
    // No name relationship to "Rookies" either ("No Huddle" extends nothing
    // "Rookies" states), so with no registered sibling to establish a shared
    // root this stays its own section -- and critically, it must not have
    // been rescued onto "Base Set" by the roster fold, which is the specific
    // regression this test pins.
    expect(noHuddle.role).not.toBe("parallel");
    if (noHuddle.anchor) expect(noHuddle.anchor).not.toBe("Base>Base Set");
  });
});
