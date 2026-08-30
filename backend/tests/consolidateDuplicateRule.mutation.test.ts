/**
 * MUTATION CHECKS. Flip each winner rule's sign and assert the group count
 * MOVES.
 *
 * "The recurring bug shape: right guard, wrong scope" -- #1177-#1180 were all
 * one shape, and the lesson was: measure blast radius, verify OUTPUT not
 * process, mutation-check every guard. A guard that classifies the same way
 * whether or not its condition holds is decoration, and a green test over it
 * proves nothing.
 *
 * Each test below builds two corpora that differ ONLY in the fact the rule
 * keys on, and asserts the decision differs. If a rule is ever weakened into a
 * no-op, exactly one of these fails.
 */
import { describe, expect, it } from "vitest";
import { decideDuplicateGroup, type DupRow } from "../src/services/catalog/duplicateWinnerRule.js";

const row = (o: Partial<DupRow> & { id: string }): DupRow => ({
  source: "checklistcenter",
  sport: "baseball",
  year: 2025,
  setKey: "topps-chrome",
  cardNumber: "79",
  parallelSlug: "gold",
  isAuto: false,
  playerName: "A Player",
  ...o,
});

const kindOf = (rows: DupRow[], rulings: Parameters<typeof decideDuplicateGroup>[0]["rulings"] = []) =>
  decideDuplicateGroup({ rows, rulings }).kind;

describe("mutation: the player gate", () => {
  it("same player folds; DIFFERENT player does not -- the only change is the name", () => {
    const same = [row({ id: "a", playerName: "Angel Nunez" }), row({ id: "b", parallelSlug: "base-gold", playerName: "Angel Nunez" })];
    const diff = [row({ id: "a", playerName: "Angel Nunez" }), row({ id: "b", parallelSlug: "base-gold", playerName: "Alejandro Nunez" })];
    expect(kindOf(same)).toBe("consolidate");
    expect(kindOf(diff)).toBe("not-a-group");
  });
});

describe("mutation: the D31 colour gate", () => {
  it("ONE source naming both forms blocks; TWO sources naming them folds", () => {
    const oneSource = [row({ id: "a", parallelSlug: "uncommon" }), row({ id: "b", parallelSlug: "uncommon-refractor" })];
    const twoSources = [
      row({ id: "a", parallelSlug: "uncommon" }),
      row({ id: "b", parallelSlug: "uncommon-refractor", source: "checklistcenter-2026-08-29" }),
    ];
    expect(kindOf(oneSource)).toBe("ambiguous");
    expect(kindOf(twoSources)).toBe("consolidate");
  });

  it("a CHECKLIST row naming both blocks; a DERIVED row naming both does not", () => {
    const checklistBoth = [row({ id: "a", parallelSlug: "gold" }), row({ id: "b", parallelSlug: "gold-refractor" })];
    const derivedBoth = [
      row({ id: "a", parallelSlug: "gold", source: "ingest-auto-seed" }),
      row({ id: "b", parallelSlug: "gold-refractor", source: "ingest-auto-seed" }),
      row({ id: "c", parallelSlug: "gold-refractor" }),
    ];
    expect(kindOf(checklistBoth)).toBe("ambiguous");
    expect(kindOf(derivedBoth)).toBe("consolidate");
  });
});

describe("mutation: the print-run gate", () => {
  it("two checklist print runs block; ONE print run folds", () => {
    const two = [row({ id: "a", printRun: 55 }), row({ id: "b", source: "beckett", printRun: 75 })];
    const one = [row({ id: "a", printRun: 55 }), row({ id: "b", source: "beckett", printRun: 55, parallelSlug: "base-gold" })];
    expect(kindOf(two)).toBe("ambiguous");
    expect(kindOf(one)).toBe("consolidate");
  });

  it("the near-miss flag moves with the numbers, and never decides", () => {
    const near = decideDuplicateGroup({ rows: [row({ id: "a", printRun: 149 }), row({ id: "b", source: "beckett", printRun: 150 })] });
    const far = decideDuplicateGroup({ rows: [row({ id: "a", printRun: 55 }), row({ id: "b", source: "beckett", printRun: 75 })] });
    expect(near.kind).toBe("ambiguous");
    expect(far.kind).toBe("ambiguous");
    if (near.kind === "ambiguous" && far.kind === "ambiguous") {
      expect(near.nearMiss).toBe(true);
      expect(far.nearMiss).toBe(false);
    }
  });
});

describe("mutation: the authority gate", () => {
  it("a checklist row present folds the derived twin; ALL-derived is ambiguous", () => {
    const withChecklist = [row({ id: "a" }), row({ id: "b", source: "ingest-auto-seed", parallelSlug: "base-gold" })];
    const allDerived = [
      row({ id: "a", source: "ingest-auto-seed" }),
      row({ id: "b", source: "sold-comps-stub", parallelSlug: "base-gold" }),
    ];
    expect(kindOf(withChecklist)).toBe("consolidate");
    expect(kindOf(allDerived)).toBe("ambiguous");
  });

  it("the checklist row is the WINNER, never the derived one", () => {
    const d = decideDuplicateGroup({
      rows: [
        row({ id: "derived", source: "ingest-auto-seed", parallelSlug: "base-gold", salesCount: 9999 }),
        row({ id: "checklist", source: "checklistcenter", parallelSlug: "gold" }),
      ],
    });
    expect(d.kind).toBe("consolidate");
    // Sales are a TIE-BREAK, never an authority: 9,999 sales must not beat a
    // checklist row. If ranking ever puts salesCount above authority, this fails.
    if (d.kind === "consolidate") expect(d.winner.id).toBe("checklist");
  });
});

describe("mutation: the rulings guard", () => {
  const ruled = "hiq:baseball:2025:bowman:cpa-fa:purple-refractor:auto:num-250";
  // The guard fires only when a ruled id would be RETIRED as a loser -- which is
  // the correct semantics: a ruled id that WINS is the ruling being honoured,
  // not contradicted. So the rival is given the longer id, which out-ranks the
  // ruled row and makes it the loser. (Ranking breaks ties on id length.)
  const rows = [
    row({ id: `${ruled}:rival-longer`, setKey: "bowman", cardNumber: "cpa-fa", parallelSlug: "purple-refractor", printRun: 250, isAuto: true, playerName: "F Arias" }),
    row({ id: ruled, source: "beckett", setKey: "bowman", cardNumber: "cpa-fa", parallelSlug: "purple-refractor", printRun: 250, isAuto: true, playerName: "F Arias" }),
  ];

  it("with the ruling loaded it is ambiguous; without it, it folds", () => {
    expect(kindOf(rows, [{ to: ruled }])).toBe("ambiguous");
    expect(kindOf(rows, [])).toBe("consolidate");
  });

  it("a ruling naming an UNRELATED id does not block", () => {
    expect(kindOf(rows, [{ to: "hiq:baseball:2024:topps:1:base:no-auto" }])).toBe("consolidate");
  });

  it("a ruled id that WINS is the ruling honoured, not contradicted -- it folds", () => {
    // The mirror image of the case above, and the reason the guard keys on the
    // LOSERS rather than on "is this id mentioned anywhere".
    const ruledWins = [
      row({ id: ruled, source: "beckett", setKey: "bowman", cardNumber: "cpa-fa", parallelSlug: "purple-refractor", printRun: 250, isAuto: true, playerName: "F Arias" }),
      row({ id: "short", source: "ingest-auto-seed", setKey: "bowman", cardNumber: "cpa-fa", parallelSlug: "purple-refractor", printRun: 250, isAuto: true, playerName: "F Arias" }),
    ];
    const d = decideDuplicateGroup({ rows: ruledWins, rulings: [{ to: ruled }] });
    expect(d.kind).toBe("consolidate");
    if (d.kind === "consolidate") expect(d.winner.id).toBe(ruled);
  });
});

describe("mutation: winnerBy actually tracks the reason", () => {
  it("a numbered twin reports `numbered`, a respelling reports a spelling rule", () => {
    const numbered = decideDuplicateGroup({
      rows: [row({ id: "a", printRun: 50 }), row({ id: "b", source: "ingest-auto-seed" })],
    });
    const spelled = decideDuplicateGroup({
      rows: [row({ id: "a", parallelSlug: "refractor" }), row({ id: "b", source: "ingest-auto-seed", parallelSlug: "base-refractor" })],
    });
    expect(numbered.kind).toBe("consolidate");
    expect(spelled.kind).toBe("consolidate");
    if (numbered.kind === "consolidate" && spelled.kind === "consolidate") {
      expect(numbered.winnerBy).toBe("numbered");
      expect(spelled.winnerBy).not.toBe("numbered");
    }
  });
});
