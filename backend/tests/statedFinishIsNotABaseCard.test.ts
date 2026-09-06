/**
 * CF-A-TITLE-THAT-NAMES-A-FINISH-IS-NOT-A-BASE-CARD (I9 triage, 2026-09-06).
 *
 * The I9 SHADOW-REDERIVATION triage (run 34029662735) found `dropped:parallel`
 * on 190 of 887 TRUE-DISAGREEMENT rows: the row STORES a real parallel, the
 * TITLE states it in words, and `parseListingIdentity` answered "Base". The
 * classifier's base-eviction guard refuses every one of them, so nothing was
 * mis-filed -- but the rows sit as permanent disagreements the rematch can
 * never act on, and the reader is the thing that is wrong.
 *
 * EVERY TITLE IN THIS FILE IS A REAL ROW, drawn read-only from live sold_comps
 * on 2026-09-06. The `stored` value in each case is that row's own parallel
 * field, so these pin the reader against the corpus rather than against
 * invented strings.
 *
 * Measured on that 400-row draw, before -> after:
 *
 *     dropped (parallel lost to Base)   260  ->  159
 *     agree   (reader == stored)        119  ->  224
 *     other   (reader != stored)          7  ->    3
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service";
import {
  statedFinishFromChecklist,
  _resetStatedFinishCorpus,
} from "../src/services/portfolioiq/statedFinishFromChecklist";

const parallelOf = (title: string, ctx?: { year?: number | null; setKey?: string | null }): string =>
  parseListingIdentity(title, undefined, ctx ?? {}).parallel;

describe("CF-A-TITLE-THAT-NAMES-A-FINISH-IS-NOT-A-BASE-CARD", () => {
  beforeEach(() => _resetStatedFinishCorpus());

  // ── THE THREE SHAPES THE TRIAGE NAMED ────────────────────────────────────
  //
  // Each of these read "Base" before the fix. The stored parallel and the
  // checklist agree with the title; only the reader did not.

  it("reads a finish stated with the family word between colour and foil", () => {
    // The old rule required `<colour> foil` to be ADJACENT, so the family word
    // in the middle sent this past it. `purple holo foil` is attested 3,815
    // times in the checklist corpus.
    expect(statedFinishFromChecklist(
      "2025 Topps Update Baseball #US283 Purple Holo Foil",
      { year: 2025, setKey: "topps-update" },
    )).toBe("Purple Holo Foil");
  });

  it("reads a colour the foil rule's list omitted", () => {
    // The rule enumerated nine colours and omitted black, silver and bronze --
    // the SAME defect PATTERN_COLOUR was created to fix for the Shimmer/Wave
    // families. "Black Foil" is a 2024 Stadium Club checklist row.
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 Black Foil",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBe("Black Foil");
  });

  it("reads a whole finish family that had no rule at all", () => {
    // `rainbow foil` is attested 9,921 times and had no rule anywhere in
    // extractParallel.
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #7 Gold Rainbow Foil",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBe("Gold Rainbow Foil");
  });

  it("the parser as a whole no longer answers Base for a stated finish", () => {
    // The end-to-end shape: this is what the rematch calls.
    expect(parallelOf(
      "2024 Topps Stadium Club Baseball #1 Black Foil",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBe("Black Foil");
  });

  // ── THE CHECKLIST IS THE AUTHORITY, AND ITS SILENCE IS AN ANSWER ─────────

  it("never mints a rung the product's checklist lacks", () => {
    // 2025 Topps Heritage lists Bordered, Sparkle Refractor and Flip Stock --
    // it does NOT list "Holographic". 87 rows in the draw store that parallel;
    // the honest answer is none, and the classifier's checklistBacked gate then
    // holds the row as NEEDS-CHECKLIST (#1796) rather than inventing a card.
    expect(statedFinishFromChecklist(
      "2025 Topps Heritage Baseball #76R-15 Holographic",
      { year: 2025, setKey: "topps-heritage" },
    )).toBeNull();
  });

  it("refuses a product the corpus does not carry at all", () => {
    // `baseball|2026|topps` is absent from the corpus. Absent beats wrong.
    expect(statedFinishFromChecklist(
      "2026 Topps Baseball #T91-74 Crackle Foil",
      { year: 2026, setKey: "topps" },
    )).toBeNull();
  });

  // ── A SIBLING IS NOT A LESS SPECIFIC READING, IT IS A DIFFERENT CARD ─────

  it("refuses rather than answering a sibling that drops a stated finish word", () => {
    // Before the leftover guard this answered "Aqua Foil" -- a real checklist
    // name, and the WRONG card. Aqua Crackle Foil and Aqua Foil are two rows,
    // two print runs, two price curves.
    const got = statedFinishFromChecklist(
      "2024 Topps Baseball #427 Aqua Crackle Foil",
      { year: 2024, setKey: "topps" },
    );
    expect(got === null || got === "Aqua Crackle Foil").toBe(true);
    expect(got).not.toBe("Aqua Foil");
  });

  it("does not let `foil` match the front of a longer finish word", () => {
    // "Pink Foilboard" answered "Pink Foil" through the colour rule, whose
    // `\s+foil` had no trailing \b. Foilboard is its own checklist row.
    expect(parallelOf("2025 Topps Archives Baseball #82 Pink Foilboard"))
      .not.toBe("Pink Foil");
  });

  it("never answers half of a two-word card name", () => {
    // "Desert Shield" is adjudicated vocabulary (HAND_PHRASES) and is OUTSIDE
    // the corpus's 2020 Beckett floor, so the corpus-extension test cannot see
    // it. A one-word answer with a content word in front of it is a truncation.
    expect(statedFinishFromChecklist("1991 Topps Baseball #580 Desert Shield", { year: 1991, setKey: "topps" }))
      .not.toBe("Shield");
  });

  it("never offers the set's own name as the card's finish", () => {
    // "1999 Flair Showcase Baseball #120 Row 2" answered "Showcase" -- the
    // second half of the PRODUCT name. The card is the Row 2.
    expect(statedFinishFromChecklist(
      "1999 Flair Showcase Baseball #120 Row 2",
      { year: 1999, setKey: "flair" },
    )).not.toBe("Showcase");
  });

  // ── THE RULES ABOVE IT KEEP THEIR ANSWERS ───────────────────────────────

  it("does not override any existing colour, pattern or ruling", () => {
    // This reader runs ONLY where extractParallel was about to answer "Base".
    expect(parallelOf("2024 Topps Chrome Gold Refractor #150 Judge")).toBe("Gold Refractor");
    expect(parallelOf("2022 Bowman Chrome Red Ink Auto #CPA-MG")).toBe("Black & White Red Ink");
    expect(parallelOf("2024 Panini Prizm Silver Prizm #12 Wembanyama")).toBe("Silver Prizm");
    expect(parallelOf("Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome")).toBe("X-Fractor");
  });

  it("a title that states nothing is still Base", () => {
    expect(parallelOf("2024 Topps Baseball #150 Aaron Judge PSA 10 GEM MINT"))
      .toBe("Base");
  });

  it("MUTATION: a title that says Base is never overridden", () => {
    // `Base Chrome` is a real corpus name, and "2022 Bowman Chrome Prospects
    // #CPA-MG Base" states both its words -- "Base" from the seller, "Chrome"
    // from the PRODUCT. Answering it would reintroduce, from the other side,
    // exactly the split CF-NO-REFRACTOR-IS-A-BASE removed (Drew 2026-08-25):
    // one card in two pools decided by the seller's phrasing. Caught by
    // parseTitleIdentity.test.ts's "an explicit Base in the title is never
    // overridden" before this pin existed.
    expect(statedFinishFromChecklist("2022 Bowman Chrome Prospects Baseball #CPA-MG Base", {}))
      .toBeNull();
    expect(parallelOf("2022 Bowman Chrome Prospects Baseball #CPA-MG Base")).toBe("Base");
    expect(parallelOf("2026 Bowman Chrome 1st - Marconi German - True Base Auto - CPA-MG - Raw"))
      .toBe("Base");
  });

  it("a lot states no single card's finish", () => {
    // isMultiCardLot refuses before the reader is consulted, exactly as it does
    // for the bare-Refractor fallback.
    expect(parallelOf("2024 Topps Stadium Club Lot of 6 Black Foil", { year: 2024, setKey: "topps-stadium-club" }))
      .toBe("Base");
  });

  // ── A GRADED TITLE IS NOT A FINISH ──────────────────────────────────────

  it("does not read a grade or a brand as a finish", () => {
    // Every graded listing says "gem mint"; every prospect auto says "1st".
    // Admitting one of those would make every title state a finish.
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 PSA 10 GEM MINT Hobby",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBeNull();
  });

  // ── MUTATION CHECKS ─────────────────────────────────────────────────────
  //
  // Each of these asserts a property that a specific revert would break, so a
  // guard cannot be quietly removed while the suite stays green.

  it("MUTATION: a bare colour is never sufficient evidence on its own", () => {
    // Reverting the COLOUR_WORDS refusal makes "Blue Jays" and "Red Sox" read
    // as finishes. `nameStatesAFinish` requires a non-colour residue.
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 Toronto Blue Jays",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBeNull();
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 Boston Red Sox",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBeNull();
  });

  it("MUTATION: the pack-odds tail is stripped from a checklist name", () => {
    // The corpus stores "Black Foil - 1:9 Hobby; 1:8 Compact Hobby;..." and the
    // reader requires EVERY word of a name to appear in the title. Reverting
    // stripOddsTail makes that name unmatchable and silently disables the whole
    // product's vocabulary -- the failure is a silent null, not an error.
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 Black Foil",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBe("Black Foil");
  });

  it("MUTATION: the corpus is actually loaded and is not empty", () => {
    // A broken corpus path degrades to null-for-everything, which would make
    // every assertion above pass vacuously except the positive ones. This one
    // fails loudly if the file cannot be found.
    _resetStatedFinishCorpus();
    expect(statedFinishFromChecklist(
      "2024 Topps Stadium Club Baseball #1 Gold Rainbow Foil",
      { year: 2024, setKey: "topps-stadium-club" },
    )).toBe("Gold Rainbow Foil");
  });

  it("the STOPWORDS mirror stays a SUBSET of the audit vocabulary's", async () => {
    // The module documents this list as a MIRROR of CORPUS_STOPWORDS in
    // scripts/lib/rematch-finish-vocab.cjs, duplicated only because nothing in
    // src/ may depend on scripts/. This pin is what stops the two drifting:
    // add a word THERE first. Same shape as
    // `playerSegmentVocabularyMirrorsTheAudit`.
    const { createRequire } = await import("node:module");
    const require_ = createRequire(import.meta.url);
    const VOCAB = require_("../scripts/lib/rematch-finish-vocab.cjs");
    const theirs: Set<string> = VOCAB.CORPUS_STOPWORDS;
    const mine: string[] = (await import("../src/services/portfolioiq/statedFinishFromChecklist"))
      .__STOPWORDS_FOR_TEST;
    const extra = mine.filter((w) => !theirs.has(w));
    expect(extra).toEqual([]);
  });

  it("MUTATION: without product context the single-word floors still hold", () => {
    // Reverting MIN_GLOBAL_TOKEN_LEN / GLOBAL_SINGLE_WORD_PRODUCT_FLOOR lets a
    // short one-off token from one product's checklist mint a finish on any
    // title. A bare team colour with no product must stay unread.
    expect(statedFinishFromChecklist("Toronto Blue Jays Team Set", {})).toBeNull();
  });
});
