// ---------------------------------------------------------------------------
// CF-A-CATALOG-TITLE-NAMES-NO-PLAYER — the CLASSIFIER half (2026-09-05)
//
// The deriver stops MINTING product names into the player segment
// (playerSegmentCatalogTitle.test.ts). This half decides what the GREAT REMATCH
// fleet does with the rows already stored that way.
//
// Neither existing gate saw them:
//   titleStatesCardNumber("1966 Topps Rub-Offs Baseball #NNO Base") is false —
//     `#NNO` states that there IS no number.
//   isCorruptedPlayerName("rub offs") was false — no trailing particle, no
//     franchise token.
// So the rows diffed `changed:cardNumber` = CONFLICT = report-only forever,
// and 31 distinct players went on sharing one pool.
//
// Measured read-only against prod on 2026-09-05 over a 30,000-row sample of
// the `player-` pool: 829 catalog-shaped rows, of which titleStatesCardNumber
// reached 228 and the setKey test 115. With the title evidence the fleet
// covers all 829 — so no new repair script is needed, only the next pass.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const CLASSIFY = require_("../scripts/lib/rematch-classify.cjs");

/** Real prod rows: [segment name, stored setKey, title]. */
const CATALOG_ROWS: [string, string, string][] = [
  ["rub offs", "topps", "1966 Topps Rub-Offs Baseball #NNO Base"],
  ["stand up", "topps", "1964 Topps Stand-Up Baseball #NNO Base"],
  ["tip top bread", "tip-top-bread", "1947 Tip-Top Bread Baseball #NNO Base"],
  ["willards chocolate", "v100-willards-chocolate", "1923 V100 Willard's Chocolate Baseball #NNO Base"],
  ["the game", "fleer", "2001 Fleer Greats of the Game Baseball #NNO Base"],
  ["candy lids", "topps", "1973 Topps Candy Lids Baseball #NNO Base"],
  ["dan dee potato chips", "dan-dee-potato-chips", "1954 Dan-Dee Potato Chips Baseball #NNO Base"],
  ["studio jersey", "donruss-studio", "2003 Donruss Studio Baseball #NNO Jersey"],
  ["icee bear", "unknown", "1972 Icee Bear Basketball #NNO Base"],
  ["hoops", "panini-hoops", "1992 Hoops Basketball #NNO Base"],
];

/** Real people on rows whose titles DO name them. Must never be called corrupt. */
const REAL_PEOPLE: [string, string, string][] = [
  ["greg maddux", "topps", "1987 Topps Traded Tiffany Greg Maddux #70T PSA 10"],
  ["paul skenes", "topps-chrome", "2024 Topps Chrome Update Paul Skenes #USC88 RC PSA 10"],
  ["honus wagner", "t206", "1909-11 T206 Honus Wagner PSA 3"],
  ["john roseboro", "topps-rub-offs", "1966 Topps Rub-Offs John Roseboro PSA 8"],
  ["larry doby", "berk-ross", "1952 Berk Ross Larry Doby VG-EX"],
];

describe("CF-A-CATALOG-TITLE-NAMES-NO-PLAYER (classifier)", () => {
  it("calls the pseudo-number corrupted on every catalog row", () => {
    const missed = CATALOG_ROWS
      .filter(([name, setKey, title]) => !CLASSIFY.isCorruptedPlayerName(name, setKey, title))
      .map(([name]) => name);
    expect(missed).toEqual([]);
  });

  it("the OLD gates missed these rows — this is the gap being closed", () => {
    for (const [name, setKey, title] of CATALOG_ROWS) {
      // Neither pre-existing signal fires; only the title evidence does.
      expect(CLASSIFY.titleStatesCardNumber(title), title).toBe(false);
      const bySetKeyOnly = CLASSIFY.isCorruptedPlayerName(name, setKey, null);
      const withTitle = CLASSIFY.isCorruptedPlayerName(name, setKey, title);
      expect(withTitle, title).toBe(true);
      // For the flagship-setKey rows the setKey test alone cannot see it.
      if (!bySetKeyOnly) expect(withTitle).toBe(true);
    }
  });

  it("never calls a real person corrupted", () => {
    for (const [name, setKey, title] of REAL_PEOPLE) {
      expect(CLASSIFY.isCorruptedPlayerName(name, setKey, title), name).toBe(false);
    }
  });

  it("blanks the stored cardNumber axis so the diff is FILLED, not CHANGED", () => {
    // FILLED is the IMPROVE path; CHANGED is CONFLICT and report-only. This is
    // the whole reason the row becomes writable by the ordinary fleet pass.
    const stored = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "player-rub-offs", parallel: "base", isAuto: false };
    const derived = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "player-john-roseboro", parallel: "base", isAuto: false };
    const axes = CLASSIFY.diffAxes(stored, derived, { title: "1966 Topps Rub-Offs Baseball #NNO Base" });
    expect(axes.filled).toContain("cardNumber");
    expect(axes.changed).not.toContain("cardNumber");
  });

  it("without the title fact the diff stays CHANGED (report-only)", () => {
    const stored = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "player-rub-offs", parallel: "base", isAuto: false };
    const derived = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "player-john-roseboro", parallel: "base", isAuto: false };
    const axes = CLASSIFY.diffAxes(stored, derived, {});
    expect(axes.changed).toContain("cardNumber");
    expect(axes.filled).not.toContain("cardNumber");
  });
});

// ---------------------------------------------------------------------------
// MUTATION CHECKS
// ---------------------------------------------------------------------------
describe("CF-A-CATALOG-TITLE-NAMES-NO-PLAYER (classifier) — mutation checks", () => {
  it("MUTANT: dropping the title argument is caught", () => {
    // If the call site stops passing the title, the flagship-setKey rows go
    // back to being invisible to the fleet.
    expect(CLASSIFY.isCorruptedPlayerName("rub offs", "topps", null)).toBe(false);
    expect(CLASSIFY.isCorruptedPlayerName("rub offs", "topps", "1966 Topps Rub-Offs Baseball #NNO Base")).toBe(true);
  });

  it("MUTANT: a title-only rule that ignores the sport word is caught", () => {
    // Widened to "any title with a sport word", these seller titles — which
    // DO name their player — would be declared player-less.
    expect(CLASSIFY.isCorruptedPlayerName("tom brady", "topps", "2000 Topps Tom Brady #236 Football Rookie PSA 8")).toBe(false);
    expect(CLASSIFY.isCorruptedPlayerName("peyton manning", "bowman-chrome", "1998 Bowman Chrome Peyton Manning #1 Football RC PSA 9")).toBe(false);
  });

  it("MUTANT: the setKey test loosened to ANY overlapping word is caught", () => {
    // One shared word is a coincidence, not evidence. "Chase Utley" on
    // topps-chase must survive; only a name made ENTIRELY of product words is
    // the defect.
    expect(CLASSIFY.isCorruptedPlayerName("chase utley", "topps-chase", null)).toBe(false);
    expect(CLASSIFY.isCorruptedPlayerName("rub offs", "topps-rub-offs", null)).toBe(true);
  });

  it("MUTANT: blanking the DERIVED side too is caught", () => {
    // The blank is STORED-side only. A numbered stored key re-deriving TO a
    // pseudo-number is a demotion, and blanking the derived side would turn
    // that into a fill.
    const stored = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "70t", parallel: "base", isAuto: false };
    const derived = { sport: "baseball", cardYear: 1966, setKey: "topps", cardNumber: "player-rub-offs", parallel: "base", isAuto: false };
    const axes = CLASSIFY.diffAxes(stored, derived, { title: "1966 Topps Rub-Offs Baseball #NNO Base" });
    expect(axes.filled).not.toContain("cardNumber");
  });
});
