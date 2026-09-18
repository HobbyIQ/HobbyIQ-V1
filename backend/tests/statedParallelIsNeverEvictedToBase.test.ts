/**
 * CF-A-STATED-PARALLEL-IS-NEVER-EVICTED-TO-BASE (post-wave audit, 2026-09-15).
 *
 * THE LARGEST SINGLE DEFECT IN THE POOL. The 1,300-row post-wave identity
 * audit's top sports CONFLICT pattern is "stated-parallel-evicted-to-Base by
 * the DERIVER" -- 95 of 400 sampled rows, where the stored row is RIGHT and
 * the deriver drops the parallel. The same shape hides another 41 on the
 * AGREE side, where BOTH sides answer Base and the census can therefore never
 * surface them. The audit's own conclusion: "this is the single largest
 * conflict pattern and it argues against applying the deriver here."
 *
 * Every title in this file is a REAL pool row, taken verbatim from
 * `audit-postwave-sample-2026-09-15.jsonl`, and every `stored` value is that
 * row's own field. The pins are against the corpus, not invented strings --
 * the same discipline `deriverStatedParallelAndNamedProduct.test.ts` and
 * `statedFinishIsNotABaseCard.test.ts` state for their own draws.
 *
 * -- WHY "BASE" IS THE WRONG DEFAULT ----------------------------------------
 *
 * `rematch-derive-identity.cjs` read `parsed.parallel || row.parallel ||
 * "Base"`, and `parsed.parallel` is the STRING "Base" -- truthy -- whenever
 * the parser could not name a rung. So the `||` chain never reached the row's
 * own stored field: a title stating a parallel the parser could not resolve
 * derived Base, discarding the title's evidence AND the stored field in one
 * move.
 *
 * Base is a CLAIM, not an absence. It names the unparalleled card, which has
 * its own pool, its own print run and its own price curve. Emitting it for a
 * title reading "Purple Scope" does not merely lose information -- it files
 * the sale on a different card, which is the pool-split
 * `feedback_one_card_one_row_one_pool` rules on. Blank means unknown; Base
 * means we read the title and it said this card has no parallel.
 *
 * -- THE TWO HALVES OF THE FIX ----------------------------------------------
 *
 *   1. `titleStatesAnUnconfirmedFinish` (statedFinishFromChecklist.ts) reports
 *      the difference the `parallel` string cannot carry: the title states
 *      finish evidence, and no reader could turn it into a rung. It is asked
 *      ONLY where the answer was about to be Base, so it overrides nothing.
 *   2. The deriver, seeing that flag, WITHHOLDS -- falling back to the row's
 *      own stored parallel, or to `unknown` when the row has none. `unknown`
 *      is already in the classifier's GENERIC_PARALLELS and already reads as
 *      BLANK to `axisIsBlank`, so a withheld parallel shows on the diff as
 *      absent rather than as a named rung that would trip R26's
 *      identity-axis-moved guard.
 *
 * Absent beats wrong: a withheld parallel leaves the row where it already is
 * and is recoverable by a later pass with a better vocabulary. An invented
 * Base is a confident wrong address.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as pti from "../src/services/portfolioiq/parseTitleIdentity.service";
import * as hid from "../src/services/portfolioiq/hobbyIqCardId.service";
import {
  titleStatesAnUnconfirmedFinish,
  _resetStatedFinishCorpus,
} from "../src/services/portfolioiq/statedFinishFromChecklist";
import { _resetBareColourAliasMap } from "../src/services/portfolioiq/bareColourAliasFromChecklist";
import { _resetParallelNameVocabulary } from "../src/services/portfolioiq/parallelNameVocabulary";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deriveIdentity } = require("../scripts/lib/rematch-derive-identity.cjs");

beforeEach(() => {
  _resetStatedFinishCorpus();
  _resetBareColourAliasMap();
  _resetParallelNameVocabulary();
});

/**
 * The deps the fleet driver hands `deriveIdentity`, reduced to the ones this
 * seam reads. The title parser and the setKey vocabulary are the REAL ones --
 * a stub there would prove nothing about the derivation.
 */
const deps: Record<string, unknown> = {
  parseListingIdentity: pti.parseListingIdentity,
  ingestGradeFromTitle: () => ({ gradeCompany: null, gradeValue: null }),
  inferSportFromTitle: pti.inferSportFromTitle,
  normalizeSportStrict: (s: unknown) => (s ? String(s) : null),
  extractYearFromTitle: (t: string) => {
    const m = String(t).match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  },
  inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
  normalizeSetKey: hid.normalizeSetKey,
  guardSlugInputs: ({ sport }: { sport: string | null }) => ({
    ok: true, sport: sport ?? "football", reasons: [],
  }),
  computeHobbyIqCardId: () => "slug",
  applySiblingChecklistOverride: hid.applySiblingChecklistOverride,
  isCardNumberAutoSubset: () => false,
};

/** 16 of the audit's 95 CONFLICT rows: [title, stored setKey, year, stored parallel]. */
const AUDIT_ROWS: Array<[string, string, number, string]> = [
  ["2025 Panini Rookies & Stars Football #28 Silver", "panini-rookies-and-stars", 2025, "Silver"],
  ["2025 Panini Rookies & Stars Football #CT-OHN Prime", "panini-rookies-and-stars", 2025, "Prime"],
  ["2025 Panini Mosaic Football #79 Purple Scope", "panini-mosaic", 2025, "Purple Scope"],
  ["2025 Panini Rookies & Stars Football #17 Orange", "panini-rookies-and-stars", 2025, "Orange"],
  ["2024 Panini Score Football #71 Green", "panini-score", 2024, "Green"],
  ["2024 Panini Illusions Football #11 Gold", "panini-illusions", 2024, "Gold"],
  // REMOVED 2026-09-15, and the reason is the point.
  //
  //   "2024 Panini Zenith - Rookie Patch Autographs Trey Benson #227 /399"
  //        stored parallel: "Rookie Patch Autographs Ice"
  //
  // This row used to read as "the title states a finish we cannot confirm",
  // and it no longer does. That is CORRECT, not a regression:
  //
  //   * "Rookie Patch Autographs" is an INSERT SET, not a parallel of the
  //     zenith base card. Since the insert-set split it lives in
  //     `insertSets[]`, and the 2024 zenith ladder is Blue / Gold / Red /
  //     White / Prime / Gold Ice / ... -- no Rookie Patch rung, on any source.
  //   * The evidence reader saw `patch` and `rookie` as FINISH WORDS only
  //     because flattened insert names inflated their product coverage
  //     (measured: patch 63 -> 34 products, rookie 111 -> 36 after the split).
  //   * The TITLE never says "Ice". The stored parallel's distinguishing word
  //     is absent, so there is no stated finish here to withhold.
  //
  // The row is not evidence of the defect this file pins, so keeping it would
  // pin the flattening instead. The 16 rows below are all real stated
  // parallels and still carry the case.
  ["2024 Panini Select Football #156 Red and Blue Shock", "panini-select", 2024, "Red and Blue Shock"],
  ["2024 Panini Prizm Black & White Checker Checkerboard Prizm #286 JEVON KEARSE - Raw", "panini-prizm", 2024, "Black and White Checker"],
  ["2024 Panini Zenith Football #149 No Huddle", "panini-zenith", 2024, "No Huddle"],
  ["2024 Panini Select Football #25 Black and Green Shock", "panini-select", 2024, "Black and Green Shock"],
  ["2024 Panini Select Football #232 Green and Yellow Shock", "panini-select", 2024, "Green and Yellow Shock"],
  ["2024 Panini Select Football #199 Green and Red Shock", "panini-select", 2024, "Green and Red Shock"],
  ["2024 Topps Finest Drake Maye Checkerboard Rookie Card Uncommon", "topps-finest", 2024, "Checkerboard"],
  ["2024 Panini Select - Premier Level Pat Freiermuth #186 Black & Blue Shock Prizm - Raw", "panini-select", 2024, "Black and Blue Shock"],
  ["2024 Panini Totally Certified - Portraits Marvin Harrison Jr #6 Mirror - Raw", "panini-totally-certified", 2024, "Mirror"],
  ["2026 Topps Baseball #282 Wood", "topps", 2026, "Wood"],
];

// ---------------------------------------------------------------------------
// THE EVIDENCE READER
// ---------------------------------------------------------------------------
describe("titleStatesAnUnconfirmedFinish", () => {
  it.each(AUDIT_ROWS)(
    "sees the parallel stated in %s",
    (title, setKey, year) => {
      // THE INVARIANT IS "NOT BASE", NOT "UNCONFIRMED". Either answer is
      // correct and both close the defect: the reader may NAME the rung (the
      // better outcome -- one of these 17 rows resolves to the real "Portraits
      // Mirror" once the corpus is consulted), or it may withhold. What must
      // never happen is the third option, where the title states a parallel
      // and the pipeline answers Base. Asserting `unconfirmed === true` would
      // pin the weaker of the two good outcomes and fail the moment a
      // vocabulary improvement upgrades a row from withheld to named.
      const parsed = pti.parseListingIdentity(title, undefined, { setKey, year });
      const named = parsed.parallel && !/^base$/i.test(parsed.parallel);
      expect(
        named || titleStatesAnUnconfirmedFinish(title, { setKey, year }),
      ).toBe(true);
    },
  );

  it("is silent when the title genuinely states no parallel", () => {
    // These must NOT be flagged: a false positive here withholds a parallel
    // from a row whose Base is the correct, honest answer.
    const noFinish: Array<[string, string, number]> = [
      ["2026 Bowman Baseball #BCP-150 Base", "bowman", 2026],
      ["1975 Topps #370 Tom Seaver", "topps", 1975],
      ["2002 Fleer Showcase Baseball #NNO", "fleer", 2002],
    ];
    for (const [title, setKey, year] of noFinish) {
      expect(titleStatesAnUnconfirmedFinish(title, { setKey, year })).toBe(false);
    }
  });

  it("refuses a title where the seller said Base", () => {
    // CF-NO-REFRACTOR-IS-A-BASE's other half: a seller who typed "Base" has
    // answered, and this reader must not override them from either direction.
    expect(
      titleStatesAnUnconfirmedFinish(
        "2022 Bowman Chrome Prospects Baseball #CPA-MG Base",
        { setKey: "bowman-chrome", year: 2022 },
      ),
    ).toBe(false);
  });

  it("never fires for a finish the reader CAN name", () => {
    // The reader gets first refusal. A title it resolves is not "unconfirmed",
    // and flagging it would withhold a rung we successfully read.
    const title = "2023 Topps Chrome Platinum Baseball #250 Rose Gold Mini-Diamond Refractor";
    const parsed = pti.parseListingIdentity(title, undefined, {
      setKey: "topps-chrome-platinum", year: 2023,
    });
    expect(parsed.parallel).toBe("Rose Gold Mini-Diamond Refractor");
    expect(parsed.parallelIsUnconfirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE PARSER SURFACES IT
// ---------------------------------------------------------------------------
describe("parseListingIdentity reports an unconfirmed parallel", () => {
  it.each(AUDIT_ROWS)(
    "flags %s rather than silently answering Base",
    (title, setKey, year) => {
      const parsed = pti.parseListingIdentity(title, undefined, { setKey, year });
      // Where the parser has no rung to give it still ANSWERS Base -- what
      // changes is that it now SAYS SO, instead of being indistinguishable
      // from a title that states nothing. Where it can name the rung, it does,
      // and no flag is needed. Both are correct; a silent Base is not.
      if (/^base$/i.test(parsed.parallel)) {
        expect(parsed.parallelIsUnconfirmed).toBe(true);
      } else {
        expect(parsed.parallelIsUnconfirmed).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// THE DERIVER WITHHOLDS
// ---------------------------------------------------------------------------
describe("deriveIdentity never evicts a stated parallel to Base", () => {
  it.each(AUDIT_ROWS)(
    "keeps the stored parallel for %s",
    (title, setKey, year, stored) => {
      const row = {
        title, parallel: stored, sport: "football",
        cardYear: year, setName: setKey,
      };
      const d = deriveIdentity(row, deps);
      expect(d.ok).toBe(true);
      // THE WHOLE POINT: the row's own reading survives.
      expect(d.identity.parallel).toBe(stored);
      // MUTATION CHECK: this is the value the deriver produced before the fix,
      // on every one of these rows. Asserting only the new value would also
      // pass against a deriver that answered something else entirely.
      expect(d.identity.parallel).not.toBe("Base");
    },
  );

  it("withholds rather than claiming Base when the row stores nothing either", () => {
    // The title states a parallel; the row has no stored parallel to fall back
    // on. The honest answer is neither the title's unreadable rung nor Base --
    // it is "unknown", which the classifier already reads as BLANK.
    const row = {
      title: "2024 Panini Score Football #71 Green",
      parallel: null, sport: "football", cardYear: 2024, setName: "panini-score",
    };
    const d = deriveIdentity(row, deps);
    expect(d.ok).toBe(true);
    expect(d.identity.parallel).toBe("unknown");
    expect(d.identity.parallel).not.toBe("Base");
  });

  it("STILL answers Base when the title really states no parallel", () => {
    // The guard against over-correction. If this row withheld, the fix would
    // be trading one eviction for a blanket refusal to ever derive a base
    // card -- which is most of the pool.
    const row = {
      title: "2026 Bowman Baseball #BCP-150 Base",
      parallel: null, sport: "baseball", cardYear: 2026, setName: "bowman",
    };
    const d = deriveIdentity(row, deps);
    expect(d.ok).toBe(true);
    expect(d.identity.parallel).toBe("Base");
  });

  it("a rung the parser NAMED still wins over the stored field", () => {
    // The title is the evidence. A stored parallel is the fallback for a
    // withheld read, never an override of a successful one.
    const row = {
      title: "2023 Topps Chrome Platinum Baseball #250 Rose Gold Mini-Diamond Refractor",
      parallel: "Something Else", sport: "baseball",
      cardYear: 2023, setName: "topps-chrome-platinum",
    };
    const d = deriveIdentity(row, deps);
    expect(d.identity.parallel).toBe("Rose Gold Mini-Diamond Refractor");
  });
});

// ---------------------------------------------------------------------------
// THE SENTINEL IS THE ONE THE CLASSIFIER ALREADY KNOWS
// ---------------------------------------------------------------------------
describe("the withheld value reads as blank, not as a named rung", () => {
  it("uses a sentinel already in GENERIC_PARALLELS", () => {
    // If this drifts, a withheld parallel starts reading as `changed:parallel`
    // and trips R26's identity-axis-moved guard -- turning a withholding into
    // a CONFLICT the rematch can never act on. Pinned against the classifier's
    // own set rather than restated here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const K = require("../scripts/lib/rematch-classify.cjs");
    expect([...K.GENERIC_PARALLELS]).toContain("unknown");
  });
});
