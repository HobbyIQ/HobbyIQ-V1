// CF-TRADED-TIFFANY-IS-A-PRODUCT (2026-09-04).
//
// Topps Traded, Topps Tiffany and Topps Traded Tiffany are three distinct
// products that `normalizeSetKey` has ruled on since 2026-08-04 and that
// productSetKeys.ts carries with their parent ladder — but the TITLE PARSER
// had no rule for either word, so every such title fell past the ~30
// `topps <product>` rules to the bare `/topps/` catch-all
// (parseTitleIdentity.service.ts) and came back as flagship "Topps".
//
// The measured cost, read-only against sold_comps on 2026-09-04:
//   - 6,299 rows whose TITLE says Tiffany carry a slug that does not
//   - 27,538 rows whose TITLE says Traded sit under flagship `:topps:`
//   - the 1987 #70T Greg Maddux identity holds 2,418 sales of SEVERAL
//     DIFFERENT CARDS in one pool. Within its PSA 10 tier, 23 Tiffany
//     sales ($910–$1,560) are outnumbered ~5:1 by non-Tiffany Traded
//     sales (~$150), so the Tiffany card prices as the common one:
//     holding 6fc204f7 published $148.32 against a genuine market of
//     roughly $1,500.
//
// These tests pin the parser to the vocabulary's ruling. The mutation pin
// at the bottom is the load-bearing one: it fails if the specific rules are
// deleted, which is the regression that produced the defect.
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle, parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The parser's answer, as the ingest path stores it: normalized. */
const key = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

describe("CF-TRADED-TIFFANY-IS-A-PRODUCT — the parser reaches the ruled keys", () => {
  it("Traded Tiffany is topps-traded-tiffany, not flagship topps", () => {
    // Drew's holding 6fc204f7, and the title shape of the 23 PSA 10 sales
    // whose $910–$1,560 market the flagship pool was hiding.
    expect(key("1987 Topps Traded Tiffany Greg Maddux #70T")).toBe("topps-traded-tiffany");
    expect(key("1987 TOPPS TRADED TIFFANY #70T GREG MADDUX RC CUBS HOF PSA 10")).toBe("topps-traded-tiffany");
    expect(key("1987 Topps Traded Tiffany Baseball #70T Base")).toBe("topps-traded-tiffany");
  });

  it("Traded WITHOUT Tiffany is topps-traded — a different card, a different pool", () => {
    // The ~$150 population. It must NOT land on topps-traded-tiffany, or
    // the fix would merely move the pool collision rather than end it.
    expect(key("1987 Topps Traded Greg Maddux #70T Cubs Rookie PSA 10")).toBe("topps-traded");
    expect(key("1987 TOPPS TRADED #70T GREG MADDUX RC CUBS HOF PSA 10")).toBe("topps-traded");
  });

  it("Tiffany WITHOUT Traded is topps-tiffany (the 792-card glossy factory set)", () => {
    expect(key("1987 Topps Tiffany George Brett #400")).toBe("topps-tiffany");
  });

  it("Bowman Tiffany is its own ruled key (setkey-reconciliation: distinct)", () => {
    expect(key("1990 Bowman Tiffany: # 27 Greg Maddux NM-MT OR BETTER")).toBe("bowman-tiffany");
  });

  it("the three-word variant wins over its own two-word prefixes (ordering)", () => {
    // Mirrors hobbyIqCardId.service.ts:454 "Order: 3-word variants first".
    // A title containing all of topps/traded/tiffany must resolve to the
    // most specific product, never to topps-traded or topps-tiffany.
    const k = key("1987 Topps Traded Tiffany #70T");
    expect(k).toBe("topps-traded-tiffany");
    expect(k).not.toBe("topps-traded");
    expect(k).not.toBe("topps-tiffany");
  });

  it("every destination is a normalizeSetKey FIXED POINT (invents no vocabulary)", () => {
    // The parser may only reach keys the vocabulary already rules on; a
    // destination that normalizes to something else would silently
    // re-collapse and reintroduce the defect one layer down.
    for (const k of ["topps-traded-tiffany", "topps-traded", "topps-tiffany", "bowman-tiffany"]) {
      expect(normalizeSetKey(k)).toBe(k);
    }
  });

  it("flagship and neighbouring Topps products are unaffected", () => {
    // Blast-radius pin: the new rules sit above the bare /topps/ catch-all,
    // so they must not shadow any sibling product rule.
    expect(key("1987 Topps #70 Some Player")).toBe("topps");
    expect(key("2024 Topps Chrome Update Refractor #USC1")).toBe("topps-chrome");
    expect(key("2025 Topps Finest #168 Xavier Worthy Purple Refractor")).toBe("topps-finest");
    expect(key("2023 Bowman Chrome Sapphire #BCP-1")).toBe("bowman-chrome-sapphire");
  });
});

describe("CF-TRADED-TIFFANY-IS-A-PRODUCT — mutation pin", () => {
  it("Traded/Tiffany titles never fall through to the bare /topps/ catch-all", () => {
    // THE REGRESSION ITSELF. Before the fix every one of these returned
    // "topps". Deleting the parser rules makes this test fail — which is
    // the whole point of pinning it separately from the positive cases.
    const tradedOrTiffanyTitles = [
      "1987 Topps Traded Tiffany Greg Maddux #70T",
      "1986 Topps Traded Tiffany Barry Bonds #11T",
      "1987 Topps Traded #70T Greg Maddux RC",
      "1984 Topps Tiffany Don Mattingly #8",
      "1991 Topps Tiffany Chipper Jones #333",
    ];
    for (const t of tradedOrTiffanyTitles) {
      expect(key(t), `"${t}" collapsed to flagship topps`).not.toBe("topps");
    }
  });
});

// CF-A-TRAILING-LETTER-IS-PART-OF-THE-NUMBER (2026-09-04).
//
// The second half of the identity. Getting the setKey right is useless if
// the card number is null: `isUnnumberedCardNumber` (hobbyIqCardId.service
// .ts:114) treats a PARSE FAILURE as the vendor asserting "this card has no
// number", and the row is then minted under a `player-<name>` pseudo-number.
// 89,138 sold_comps rows carry that shape, 87,671 with a null cardNumber.
//
// `DEFAULT_CARD_NUMBER_RE` read letter-LED codes and bare integers but had
// no digits-THEN-letter alternative, so "#70T" matched "70" and then failed
// its own `\b` against the "T" — returning NO match at all.
describe("CF-A-TRAILING-LETTER-IS-PART-OF-THE-NUMBER — #70T is a card number", () => {
  const num = (title: string): string | null =>
    (parseListingIdentity(title) as { cardNumber?: string | null }).cardNumber ?? null;

  it("reads the T-suffixed number every Traded card carries", () => {
    expect(num("1987 Topps Traded Tiffany Greg Maddux #70T")).toBe("70T");
    expect(num("1987 TOPPS TRADED #70T GREG MADDUX RC CUBS HOF PSA 10")).toBe("70T");
    expect(num("1986 Topps Traded #11T Barry Bonds")).toBe("11T");
  });

  it("reads the same shape across the Traded-numbered rookies", () => {
    // The population measured in sold_comps: 2,358 of 3,000 sampled
    // "traded"+"#" titles carry this shape.
    expect(num("1989 Topps Traded #41T Ken Griffey Jr RC PSA 10")).toBe("41T");
    expect(num("1986 Topps Traded Jose Canseco #20T Oakland A's SGC 9")).toBe("20T");
    expect(num("Topps 1985 Traded Vince Coleman Rookie #24T Cardinals")).toBe("24T");
  });

  it("does not disturb bare or letter-led numbers", () => {
    // Blast-radius pin: the new alternative sits before the bare `\d{1,4}`
    // and must not change a title that has no trailing letter.
    expect(num("1987 Topps #70 Greg Maddux")).toBe("70");
    expect(num("2024 Topps Chrome #USC1 Player Name")).toBe("USC1");
  });

  it("keeps a hyphenated retro-insert SKU whole", () => {
    // "#83T-6" is ONE card number (2018 Topps Chrome, 1983 Topps refractor
    // insert). The first version of this fix matched only its "83T" prefix
    // and split a real SKU; cardNumberIntegrityParity.test.ts caught it.
    expect(num("2018 Topps Chrome Shohei Ohtani #83T-6 1983 Topps Baseball Refractor RC PSA 9")).toBe("83T-6");
  });

  it("mutation pin: a T-suffixed number is never null", () => {
    // THE REGRESSION. Before the fix every one of these returned null,
    // which is what fed the `player-<name>` bucket.
    for (const t of [
      "1987 Topps Traded Tiffany Greg Maddux #70T",
      "1989 Topps Traded #41T Ken Griffey Jr RC",
      "1986 Topps Traded #11T Barry Bonds",
    ]) {
      expect(num(t), `"${t}" lost its card number`).not.toBeNull();
    }
  });
});
