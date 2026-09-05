// ---------------------------------------------------------------------------
// CF-A-CATALOG-TITLE-NAMES-NO-PLAYER (2026-09-05)
//
// The vendor's PRODUCT-catalog title names a card by product and never by
// person. parseCardQuery derives the player subtractively, so on such a title
// the residue is a fragment of the PRODUCT NAME -- and it was being promoted
// into a human name ("Rub-offs", "Tip-top Bread", "Willard's Chocolate").
//
// Measured read-only against prod on 2026-09-05 over a 30,000-row sample of
// the `player-` pseudo-number pool: 478 of 829 catalog-shaped rows were
// refused outright (playerTheTitleAllows called a good vendor player
// irreconcilable with a product fragment), and the rows written before that
// guard existed show the collapse -- 31 distinct players share
// `hiq:baseball:1966:topps:player-rub-offs:base:no-auto` and 24 share
// `player-stand-up`.
//
// EVERY TITLE BELOW IS A REAL sold_comps TITLE, pulled with its real vendor
// playerName. The corpus is the pin: a narrower regex stops refusing some of
// them, and a wider one starts eating the controls.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";
import { titleNamesNoPlayer, playerSegmentIsAPerson } from "../src/services/compiq/playerSegmentIsAPerson.js";

/** [title, the vendor's playerName for that row] — real prod rows. */
const CATALOG_TITLES: [string, string][] = [
  ["1951 Topps Connie Mack's All-Stars Baseball #NNO Base", "Walter Johnson"],
  ["1923 V100 Willard's Chocolate Baseball #NNO Base", "Ralph Perkins"],
  ["2003 Donruss Studio Baseball #NNO Jersey", "Freddy Garcia"],
  ["1947 Tip-Top Bread Baseball #NNO Base", "Connie Ryan"],
  ["1964 Topps Stand-Up Baseball #NNO Base", "Billy Williams"],
  ["1966 Topps Rub-Offs Baseball #NNO Base", "John Roseboro"],
  ["1950 Callahan Hall of Fame Baseball #NNO Base", "Ray Cracker Schalk"],
  ["1909 American Caramel E91-B Baseball #NNO Base", "James P. Archer"],
  ["2001 Fleer E-X Baseball #NNO Base", "Chipper Jones"],
  ["1969 Globe Imports Playing Cards Baseball #NNO 6 of Spades", "Tommy John"],
  ["1922 Exhibits Baseball #NNO Base", "Earl Smith"],
  ["1936 National Chicle Fine Pen Premiums R313 Baseball #NNO Base", "Red Lucas"],
  ["2001 Fleer Greats of the Game Baseball #NNO Base", "Hack Wilson"],
  ["1912 American Tobacco Company Brown Background T207 Baseball #NNO Base", "Harry Davis"],
  ["1973 Topps Candy Lids Baseball #NNO Base", "Clay Kirby"],
  ["1963 Topps Baseball #NNO Instruction Back", "Chuck Hinton"],
  ["1954 Dan-Dee Potato Chips Baseball #NNO Base", "Al Lopez"],
  ["1969 Transogram Baseball #NNO Hand Cut", "Ernie Banks"],
  ["2001 Donruss Signature Series Baseball #NNO Master Series", "Orel Hershiser"],
  ["1953 Briggs Meats Baseball #NNO Hand Cut", "Hank Bauer"],
  ["1955 Rodeo Meats Athletics Baseball #NNO Yellow Background", "Bill Wilson"],
  ["1949 Remar Bread Oakland Oaks Baseball #NNO Base", "Earl Rapp"],
  ["1936 Goudey Premiums Baseball #NNO Kneeling", "Jimmy Dykes"],
  ["2002 Fleer Maximum Baseball #NNO Bat", "Derek Jeter"],
  ["2002 Leaf Baseball #NNO Silver", "Phil Rizzuto"],
  ["1939 Goudey Premiums R303-A Baseball #NNO Base", "Gus Mancuso"],
  ["1972 Milton Bradley Baseball #NNO Base", "Roberto Clemente"],
  ["1931 W517 Baseball #NNO No Card Number Hand Cut", "Paul Waner"],
  ["2002 Fleer Showcase Baseball #NNO Base", "Vladimir Guerrero"],
  ["1911 Weber Bakery D304 Baseball #NNO Base", "Honus Wagner"],
  ["1999 Sports Illustrated Greats of the Game Baseball #NNO Base", "Mark Fidrych"],
  ["1909 1909-11 T206 Baseball #NNO Brooklyn", "Harry McIntire"],
  ["1971 Topps Scratch-Offs Baseball #NNO Base", "Hank Aaron"],
  ["1909 1909-11 T206 Baseball #NNO With Bat", "Nap Lajoie"],
  ["2001 Fleer Legacy Baseball #NNO Base", "Billy Martin"],
  ["1969 Topps Stamps Baseball #NNO Base", "Johnny Bench"],
  ["1963 Topps Baseball #NNO Blank Back", "Willie Mays"],
  ["1921 W551 Baseball #NNO Hand Cut", "Walter Johnson"],
  ["1996 Leaf Signature Series Baseball #NNO Bronze", "Brian Williams"],
  ["2019 Topps Dynasty Baseball #NNO Base", "Kyle Schwarber"],
  ["1952 Berk Ross Baseball #NNO Base", "Larry Doby"],
  ["1969 O-Pee-Chee Deckle Edge Baseball #NNO Base", "Willie Mays"],
  ["1927 W560 Hand Cut Baseball #NNO Base", "Kiki Cuyler"],
  ["1921 Oxford Confectionery E253 Baseball #NNO Base", "George Sisler"],
  ["1958 Dodgers Team Issue Baseball #NNO Base", "Walt Alston"],
  ["1965 Topps Transfers Baseball #NNO Base", "Dick Radatz"],
  ["1933 Tattoo Orbit R305 Baseball #NNO Base", "William Herman"],
  ["2002 Fleer Greats of the Game Baseball #NNO Level 2", "Bo Jackson"],
  ["1936 Goudey Wide Pen Premiums R314 Type 1 Baseball #NNO Base", "Virgil Davis"],
  ["2001 Fleer Showcase Baseball #NNO Base", "Matt Lawton"],
  ["1976 Buckmans Discs Basketball #NNO Base", "Bob McAdoo"],
  ["1992 Hoops Basketball #NNO Base", "USA Basketball Team"],
  ["1972 Icee Bear Basketball #NNO Base", "Pete Maravich"],
  ["1992 Pacific Football #NNO Steve Largent Autograph", "Steve Largent"],
  ["1963 Exhibits Statistic Back Baseball #NNO Base", "Eddie Mathews"],
  ["1993 French Majeur 5 Basketball #nno Blue", "Michael Jordan"],
  ["2001 Fleer Game Time Baseball #NNO Base", "Carl Everett"],
  ["1948 1948-52 Exhibit Football #NNO Base", "Frankie Albert"],
  ["1948 1948-52 Exhibits Black & White W468 Football #NNO Base", "Dick Hoerner"],
  ["1975 Carvel Discs Basketball #NNO Orange", "Don Nelson"],
];

/** Real seller-written titles that DO name their player. The fix must not
 *  touch these: a sport word alone is not the catalog shape. */
const SELLER_TITLES: [string, string][] = [
  ["1987 Topps Traded Tiffany Greg Maddux #70T PSA 10", "Greg Maddux"],
  ["2024 Topps Chrome Update Paul Skenes #USC88 RC PSA 10", "Paul Skenes"],
  // Title-cased by titleCaseToken, which does not know interior capitals
  // outside Mc/Mac/O'. Pre-existing and pinned as measured.
  ["2003 Topps Chrome LeBron James #111 Rookie PSA 9", "Lebron James"],
  ["2000 Topps Tom Brady #236 Football Rookie PSA 8", "Tom Brady"],
  ["2018 Bowman Chrome Juan Soto #BCP-40 Refractor BGS 9.5", "Juan Soto"],
  ["1998 Bowman Chrome Peyton Manning #1 Football RC PSA 9", "Peyton Manning"],
  // Pinned AS MEASURED, not as wished. "Larry" is a corpus parallel token
  // (2024 Panini Flawless lists a player-named insert), so the strip takes it
  // and the surname survives alone. That is a PRE-EXISTING defect of the
  // corpus harvest, unrelated to the catalog-title shape, and it is pinned here
  // so this test tells the truth about today's behaviour: if a later PR fixes
  // the harvest, this line is the one that says so.
  ["1980-81 Topps Larry Bird Rookie PSA 7", "Bird"],
];

describe("CF-A-CATALOG-TITLE-NAMES-NO-PLAYER", () => {
  it("recognises the vendor catalog shape on every corpus title", () => {
    const missed = CATALOG_TITLES.filter(([t]) => !titleNamesNoPlayer(t)).map(([t]) => t);
    expect(missed).toEqual([]);
    expect(CATALOG_TITLES.length).toBeGreaterThanOrEqual(50);
  });

  it("names NO player on a catalog title — the residue is product text", () => {
    const promoted = CATALOG_TITLES
      .map(([t]) => [t, parseCardQuery(t)?.playerName ?? null] as const)
      .filter(([, p]) => p !== null);
    // Every one of these used to return a product fragment as a person.
    expect(promoted).toEqual([]);
  });

  it("never mistakes a seller title for the catalog shape", () => {
    for (const [title] of SELLER_TITLES) {
      expect(titleNamesNoPlayer(title), title).toBe(false);
    }
  });

  it("keeps the player on every seller title (no regression)", () => {
    for (const [title, expected] of SELLER_TITLES) {
      expect(parseCardQuery(title)?.playerName, title).toBe(expected);
    }
  });

  it("refuses the residue even when it reads exactly like a name", () => {
    // "Connie Mack's All-Stars" is a PRODUCT; "Connie Mack" is also a person.
    // Shape decides, not plausibility — that is the whole point.
    expect(parseCardQuery("1951 Topps Connie Mack's All-Stars Baseball #NNO Base")?.playerName).toBeNull();
    expect(parseCardQuery("1972 Milton Bradley Baseball #NNO Base")?.playerName).toBeNull();
  });

  it("the checklist still outranks the flag", () => {
    // A checklist player is the authority and is not a guess about the title.
    const seg = playerSegmentIsAPerson("rub offs", {
      titleNamesNoPlayer: true,
      checklistPlayer: "John Roseboro",
    });
    expect(seg.player).toBe("John Roseboro");
    expect(seg.reason).toBe("checklist");
  });
});

// ---------------------------------------------------------------------------
// MUTATION CHECKS
//
// A pin that a mutant survives is not a pin. Each of these fails against a
// specific way the guard could be weakened back into the defect, so the test
// suite refuses the mutant rather than merely describing the fix.
// ---------------------------------------------------------------------------
describe("CF-A-CATALOG-TITLE-NAMES-NO-PLAYER — mutation checks", () => {
  it("MUTANT: titleNamesNoPlayer() hardcoded to false is caught", () => {
    // The whole corpus depends on the predicate firing. If it returns false
    // for everything, these titles start promoting product text again.
    const detected = CATALOG_TITLES.filter(([t]) => titleNamesNoPlayer(t)).length;
    expect(detected).toBe(CATALOG_TITLES.length);
    expect(detected).toBeGreaterThan(0);
  });

  it("MUTANT: the flag ignored inside playerSegmentIsAPerson is caught", () => {
    // Called DIRECTLY with a residue that bounds cleanly as a name. Only the
    // flag can refuse it — so if the branch is deleted, this returns a name.
    const seg = playerSegmentIsAPerson("tip top bread", { titleNamesNoPlayer: true });
    expect(seg.player).toBeNull();
    expect(seg.reason).toBe("refused-not-a-person");
    // ...and with the flag off, the same residue still bounds — proving the
    // refusal comes from the flag and not from the residue being unbounded.
    expect(playerSegmentIsAPerson("tip top bread", {}).player).not.toBeNull();
  });

  it("MUTANT: requiring the '#' would miss nothing, but dropping the sport word eats sellers", () => {
    // The sport token must be IMMEDIATELY before the number. A regex widened
    // to "sport appears anywhere" would swallow these real seller titles.
    expect(titleNamesNoPlayer("2000 Topps Tom Brady #236 Football Rookie PSA 8")).toBe(false);
    expect(titleNamesNoPlayer("1998 Bowman Chrome Peyton Manning #1 Football RC PSA 9")).toBe(false);
    // ...while the genuine template still matches.
    expect(titleNamesNoPlayer("1966 Topps Rub-Offs Baseball #NNO Base")).toBe(true);
  });

  it("MUTANT: refusing on the vendor field instead of the title is caught", () => {
    // The guard is about the TITLE's shape. A row whose title names a person
    // must keep them even when the vendor field is junk — nothing here reads
    // the vendor field at all.
    expect(parseCardQuery("2024 Topps Chrome Update Paul Skenes #USC88 RC PSA 10")?.playerName)
      .toBe("Paul Skenes");
  });
});
