/**
 * resolve-split-identity-parks.cjs -- pure decision unit tests.
 *
 * No Cosmos, no I/O: judgeSplitIdentityVerdict/titleVetoes are pure functions
 * of already-computed inputs, so REPORT and APPLY share the exact same
 * decision (see resolveSplitIdentityParksLane.test.ts for the end-to-end
 * fixture proving REPORT's counts equal APPLY's).
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../scripts/resolve-split-identity-parks.cjs") as {
  segmentsOf: (slug: string) => string[] | null;
  sportSegmentOf: (slug: string) => string | null;
  yearSegmentOf: (slug: string) => string | null;
  setKeySegmentOf: (slug: string) => string | null;
  withSportSegment: (slug: string, sport: string) => string | null;
  cellsOf: (cardId: string, hobbyiqCardId: string) => Set<string>;
  checklistMatchOf: (catalogRow: Record<string, unknown> | null, salePlayerName: unknown, catalogAuthorityOf: (s: unknown) => string, playerIdentityKey: (n: unknown) => string) => "match" | "different-card" | "no-row";
  multiPlayerKeysOf: (playerName: unknown, playerIdentityKey: (n: unknown) => string) => Set<string>;
  judgeSplitIdentityVerdict: (input: { hMatch: string; cMatch: string; saleIsTwoSportAthlete?: boolean }) => { verdict: string; reason: string; detail: string };
  titleVetoes: (input: Record<string, unknown>, deps: Record<string, unknown>) => { vetoed: boolean; detail?: string };
  guessTitlePlayer: (title: string, deps: Record<string, unknown>) => string | null;
  playerIdentityTokens: (name: unknown, deps: Record<string, unknown>) => string[];
  physicalSaleKeyOf: (doc: Record<string, unknown>, dest?: string) => string;
  listingIdOf: (doc: Record<string, unknown>) => string;
  sameListingIdentity: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean;
  isPinnedOrFlagged: (doc: Record<string, unknown>) => boolean;
  USER_SEED_SOURCES: Set<string>;
  CELL_RE: RegExp;
  ALL_SPLITS: string;
  PARK_FIELDS: string[];
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { playerIdentityKey } = require("../dist/services/catalog/playerIdentityKey.js") as { playerIdentityKey: (n: unknown) => string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { catalogAuthorityOf } = require("../dist/services/catalog/catalogAuthority.service.js") as { catalogAuthorityOf: (s: unknown) => string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { inferSetKeyFromTitle } = require("../dist/services/portfolioiq/parseTitleIdentity.service.js") as { inferSetKeyFromTitle: (t: string, cn?: string | null) => string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractCardNumberFromTitle } = require("../dist/services/portfolioiq/soldCompsStore.service.js") as { extractCardNumberFromTitle: (t: string | null | undefined) => string | null };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sameCardNumber, resolveSetKeyForSlug } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js") as { sameCardNumber: (a: unknown, b: unknown) => boolean; resolveSetKeyForSlug: (sport: string, setName: string, year: number) => string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseCardQuery } = require("../dist/services/compiq/cardQueryParser.js") as { parseCardQuery: (q: string) => { playerName?: string; confidence?: number } };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cleanPlayerName } = require("../dist/services/portfolioiq/cardCatalog.service.js") as { cleanPlayerName: (n: unknown) => string };

const { sportEvidence } = require("../scripts/lib/sport-title-evidence.cjs") as { sportEvidence: (t: string) => { sports: Set<string> } };

const TITLE_DEPS = { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, sportEvidenceFn: sportEvidence, parseCardQuery, cleanPlayerName, playerIdentityKey };

describe("resolve-split-identity-parks: segment helpers", () => {
  it("segmentsOf/sportSegmentOf/yearSegmentOf/setKeySegmentOf read a well-formed hiq slug", () => {
    const slug = "hiq:baseball:2023:topps:vw-3:base:no-auto";
    expect(mod.sportSegmentOf(slug)).toBe("baseball");
    expect(mod.yearSegmentOf(slug)).toBe("2023");
    expect(mod.setKeySegmentOf(slug)).toBe("topps");
  });

  it("returns null for a non-hiq or too-short slug", () => {
    expect(mod.segmentsOf("1649639019826x860979551007433600")).toBeNull();
    expect(mod.segmentsOf("hiq:baseball:2023")).toBeNull();
    expect(mod.sportSegmentOf("")).toBeNull();
  });

  it("withSportSegment swaps ONLY the sport segment, byte-preserving a later :num-N tail", () => {
    expect(mod.withSportSegment("hiq:baseball:2023:topps:vw-3:base:no-auto", "basketball")).toBe("hiq:basketball:2023:topps:vw-3:base:no-auto");
    expect(mod.withSportSegment("hiq:baseball:1988:fleer:17:base:no-auto:num-23", "basketball")).toBe("hiq:basketball:1988:fleer:17:base:no-auto:num-23");
  });

  it("cellsOf returns BOTH sides' sport:year cells -- a split-identity row disagrees on sport by definition", () => {
    const cells = mod.cellsOf("hiq:baseball:2023:topps:vw-3:base:no-auto", "hiq:basketball:2023:topps:vw3:base:no-auto");
    expect(cells).toEqual(new Set(["baseball:2023", "basketball:2023"]));
  });
});

describe("resolve-split-identity-parks: checklistMatchOf / multiPlayerKeysOf", () => {
  it("no-row: no catalog row at the address", () => {
    expect(mod.checklistMatchOf(null, "Victor Wembanyama", catalogAuthorityOf, playerIdentityKey)).toBe("no-row");
  });
  it("no-row: a row exists but is not checklist-authority", () => {
    expect(mod.checklistMatchOf({ source: "cardhedge", playerName: "Victor Wembanyama" }, "Victor Wembanyama", catalogAuthorityOf, playerIdentityKey)).toBe("no-row");
  });
  it("match: checklist-authority AND same playerIdentityKey", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Victor Wembanyama" }, "Victor Wembanyama", catalogAuthorityOf, playerIdentityKey)).toBe("match");
  });
  it("different-card: checklist-authority but a DIFFERENT player -- cell collision", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Barry Bonds" }, "Patrick Ewing", catalogAuthorityOf, playerIdentityKey)).toBe("different-card");
  });
  it("different-card: sale carries no playerName -- cannot confirm, never trust the bare address", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Barry Bonds" }, "", catalogAuthorityOf, playerIdentityKey)).toBe("different-card");
  });
  it("multi-player row: matches if the sale's player is ANY name listed (Eddie Murray / Cal Ripken Jr. shape)", () => {
    const row = { source: "checklistcenter", playerName: "Eddie Murray / Cal Ripken Jr." };
    expect(mod.checklistMatchOf(row, "Cal Ripken Jr.", catalogAuthorityOf, playerIdentityKey)).toBe("match");
    expect(mod.checklistMatchOf(row, "Eddie Murray", catalogAuthorityOf, playerIdentityKey)).toBe("match");
    expect(mod.checklistMatchOf(row, "Barry Bonds", catalogAuthorityOf, playerIdentityKey)).toBe("different-card");
  });
  it("multi-player row joined by '&' also splits correctly", () => {
    const row = { source: "checklistcenter", playerName: "Ken Griffey Jr. & Barry Bonds" };
    expect(mod.checklistMatchOf(row, "Barry Bonds", catalogAuthorityOf, playerIdentityKey)).toBe("match");
  });
});

describe("resolve-split-identity-parks: judgeSplitIdentityVerdict -- every verdict shape", () => {
  it("RESOLVE-TO-H (the VW3 shape): only hobbyiqCardId candidate matches", () => {
    const v = mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "no-row" });
    expect(v.verdict).toBe("resolve-to-h");
    expect(v.reason).toBe("checklist-backs-hobbyiqcardid");
  });

  it("RESOLVE-TO-C (the Barry Sanders shape): only cardId candidate matches", () => {
    const v = mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "match" });
    expect(v.verdict).toBe("resolve-to-c");
    expect(v.reason).toBe("checklist-backs-cardid");
  });

  it("LEAVE (both-sides-name-the-player): both candidates match", () => {
    const v = mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "match" });
    expect(v.verdict).toBe("leave");
    expect(v.reason).toBe("both-sides-name-the-player");
  });

  it("LEAVE (neither-side-names-the-player): neither candidate has any row", () => {
    const v = mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "no-row" });
    expect(v.verdict).toBe("leave");
    expect(v.reason).toBe("neither-side-names-the-player");
  });

  it("LEAVE (neither-side-names-the-player): a candidate is checklist-authority but names a DIFFERENT player", () => {
    expect(mod.judgeSplitIdentityVerdict({ hMatch: "different-card", cMatch: "no-row" }).reason).toBe("neither-side-names-the-player");
    expect(mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "different-card" }).reason).toBe("neither-side-names-the-player");
  });

  describe("two-sport-athlete bound, symmetric", () => {
    it("LEAVEs (two-sport-athlete) when H matches, C is no-row, and the sale is a two-sport athlete", () => {
      const v = mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "no-row", saleIsTwoSportAthlete: true });
      expect(v.verdict).toBe("leave");
      expect(v.reason).toBe("two-sport-athlete");
    });
    it("LEAVEs (two-sport-athlete) when C matches, H is no-row, and the sale is a two-sport athlete -- the bound is symmetric", () => {
      const v = mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "match", saleIsTwoSportAthlete: true });
      expect(v.verdict).toBe("leave");
      expect(v.reason).toBe("two-sport-athlete");
    });
    it("RESOLVEs (unchanged) for an ORDINARY player when the loser is no-row", () => {
      expect(mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "no-row", saleIsTwoSportAthlete: false }).verdict).toBe("resolve-to-h");
      expect(mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "match" }).verdict).toBe("resolve-to-c");
    });
    it("RESOLVEs for a two-sport athlete when the loser is 'different-card' -- POSITIVE counter-evidence overrides the bound", () => {
      const v = mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "different-card", saleIsTwoSportAthlete: true });
      expect(v.verdict).toBe("resolve-to-h");
    });
    it("the bound only fires on a resolve branch -- a two-sport athlete flagged on a leave verdict is unaffected", () => {
      expect(mod.judgeSplitIdentityVerdict({ hMatch: "no-row", cMatch: "no-row", saleIsTwoSportAthlete: true }).verdict).toBe("leave");
      expect(mod.judgeSplitIdentityVerdict({ hMatch: "match", cMatch: "match", saleIsTwoSportAthlete: true }).verdict).toBe("leave");
    });
  });
});

describe("resolve-split-identity-parks: the VW3 worked example end to end (pure)", () => {
  it("Wembanyama 2023 Topps Now #VW3: hobbyiqCardId (basketball) wins, cardId (baseball) has no row", () => {
    const hMatch = mod.checklistMatchOf(
      { source: "checklistcenter", playerName: "Victor Wembanyama" }, "Victor Wembanyama", catalogAuthorityOf, playerIdentityKey,
    );
    const cMatch = mod.checklistMatchOf(null, "Victor Wembanyama", catalogAuthorityOf, playerIdentityKey);
    const v = mod.judgeSplitIdentityVerdict({ hMatch, cMatch });
    expect(v.verdict).toBe("resolve-to-h");
  });
});

describe("resolve-split-identity-parks: Barry Sanders football-title-on-baseball-hobbyiqCardId shape", () => {
  it("resolves to C (cardId, football) when the football checklist names him and hobbyiqCardId (baseball) has no row", () => {
    const hMatch = mod.checklistMatchOf(null, "Barry Sanders", catalogAuthorityOf, playerIdentityKey);
    const cMatch = mod.checklistMatchOf(
      { source: "checklistcenter", playerName: "Barry Sanders" }, "Barry Sanders", catalogAuthorityOf, playerIdentityKey,
    );
    const v = mod.judgeSplitIdentityVerdict({ hMatch, cMatch });
    expect(v.verdict).toBe("resolve-to-c");

    // Title veto: the title states football evidence (the winning side) and
    // does not contradict it -- never vetoed.
    const veto = mod.titleVetoes({
      title: "1989 Score Barry Sanders Detroit Lions Rookie RC #257",
      winnerSport: "football",
      winnerYear: 1989,
      winnerSetKey: "score",
      winnerCardNumber: "257",
      winnerCatalogPlayerName: "Barry Sanders",
      otherSport: "baseball",
    }, TITLE_DEPS);
    expect(veto.vetoed).toBe(false);
  });
});

describe("resolve-split-identity-parks: multi-player row resolves via ANY listed name", () => {
  it("resolves to H when the sale's player is one of two names on the winning checklist row", () => {
    const hMatch = mod.checklistMatchOf(
      { source: "checklistcenter", playerName: "Eddie Murray / Cal Ripken Jr." }, "Cal Ripken Jr.", catalogAuthorityOf, playerIdentityKey,
    );
    const cMatch = mod.checklistMatchOf(null, "Cal Ripken Jr.", catalogAuthorityOf, playerIdentityKey);
    expect(mod.judgeSplitIdentityVerdict({ hMatch, cMatch }).verdict).toBe("resolve-to-h");
  });
});

describe("resolve-split-identity-parks: titleVetoes", () => {
  const BASE = {
    title: "2023 Topps Now Victor Wembanyama Rookie #VW3",
    winnerSport: "basketball",
    winnerYear: 2023,
    winnerSetKey: "topps-now",
    winnerCardNumber: "VW3",
    winnerCatalogPlayerName: "Victor Wembanyama",
    otherSport: "baseball",
  };

  it("does NOT veto a title that is silent on the losing side and backs (or does not contradict) the winner", () => {
    expect(mod.titleVetoes(BASE, TITLE_DEPS).vetoed).toBe(false);
  });

  it("does NOT veto an empty/missing title -- silence is never a veto", () => {
    expect(mod.titleVetoes({ ...BASE, title: "" }, TITLE_DEPS).vetoed).toBe(false);
    expect(mod.titleVetoes({ ...BASE, title: undefined }, TITLE_DEPS).vetoed).toBe(false);
  });

  it("VETOES when the title's own sport evidence names a THIRD sport neither side claims", () => {
    const veto = mod.titleVetoes({
      ...BASE,
      title: "2018 Topps Chrome UEFA Champions League Lightning Strike Gold #LSKM Kylian Mbappe",
      winnerSport: "basketball",
      otherSport: "baseball",
    }, TITLE_DEPS);
    expect(veto.vetoed).toBe(true);
  });

  it("does NOT veto when the title's evidence backs the WINNING side outright, even if it also brushes the loser's ambiguous nickname", () => {
    // "basketball" is an authoritative hit for the winner; nothing else in
    // the title contradicts it.
    const veto = mod.titleVetoes({ ...BASE, title: "2023 Topps Now NBA Basketball Victor Wembanyama #VW3" }, TITLE_DEPS);
    expect(veto.vetoed).toBe(false);
  });

  it("VETOES when the title's own card-number extraction disagrees with the winner's own number", () => {
    const veto = mod.titleVetoes({ ...BASE, title: "2023 Topps Now Victor Wembanyama Rookie #VW9" }, TITLE_DEPS);
    expect(veto.vetoed).toBe(true);
  });

  it("does NOT veto when the title states no number at all", () => {
    const veto = mod.titleVetoes({ ...BASE, title: "2023 Topps Now Victor Wembanyama Rookie card" }, TITLE_DEPS);
    expect(veto.vetoed).toBe(false);
  });
});

describe("resolve-split-identity-parks: PARK_FIELDS is the full park stamp", () => {
  it("names exactly the five fields guardSoldCompDoc/relocate-pool-rows-by-list write on park", () => {
    expect(mod.PARK_FIELDS).toEqual([
      "identityUnverified", "identityUnverifiedAt", "identityUnverifiedBy",
      "identityUnverifiedReason", "identityUnverifiedDetail",
    ]);
  });
});

describe("resolve-split-identity-parks: SCOPE cell shape", () => {
  it("CELL_RE accepts sport:year, matching cellsOf's own output shape", () => {
    expect(mod.CELL_RE.test("basketball:2023")).toBe(true);
    expect(mod.CELL_RE.test("fleer|1988")).toBe(false); // the model lane's pipe shape, deliberately different
    expect(mod.CELL_RE.test("basketball-2023")).toBe(false);
  });
});

describe("resolve-split-identity-parks: REVIEW #2 -- guessTitlePlayer + playerIdentityTokens (the real title-player veto)", () => {
  it("guessTitlePlayer returns null for a bare, low-confidence single word", () => {
    expect(mod.guessTitlePlayer("James", TITLE_DEPS)).toBeNull();
  });

  it("guessTitlePlayer returns a real multi-token guess for an ordinary title", () => {
    expect(mod.guessTitlePlayer("2023 Topps LeBron James #VW3", TITLE_DEPS)).toBe("Lebron James");
  });

  it("playerIdentityTokens strips the RC/RR/DP/TC/UER/SP/SSP family via cleanPlayerName BEFORE tokenizing", () => {
    expect(mod.playerIdentityTokens("James Wood RC", TITLE_DEPS)).toEqual(["james", "wood"]);
    expect(mod.playerIdentityTokens("James Wood", TITLE_DEPS)).toEqual(["james", "wood"]);
  });

  describe("the three measured production false positives -- none veto", () => {
    it('title guess "James" vs winner "James Wood RC"', () => {
      const veto = mod.titleVetoes({
        title: "2023 Bowman James Wood RC Prospect #1",
        winnerSport: "baseball", winnerYear: 2023, winnerSetKey: null, winnerCardNumber: null,
        winnerCatalogPlayerName: "James Wood RC", otherSport: "basketball",
      }, TITLE_DEPS);
      expect(veto.vetoed).toBe(false);
    });

    it('title guess "Mason Montgomery" vs winner "Mason Montgomery RC"', () => {
      const veto = mod.titleVetoes({
        title: "2023 Bowman Mason Montgomery RC Prospect",
        winnerSport: "baseball", winnerYear: 2023, winnerSetKey: null, winnerCardNumber: null,
        winnerCatalogPlayerName: "Mason Montgomery RC", otherSport: "basketball",
      }, TITLE_DEPS);
      expect(veto.vetoed).toBe(false);
    });

    it('title guess "Roki Sasaki Ff Nyc" vs winner "Roki Sasaki RC"', () => {
      const veto = mod.titleVetoes({
        title: "Roki Sasaki Ff Nyc RC rookie card",
        winnerSport: "baseball", winnerYear: 2023, winnerSetKey: null, winnerCardNumber: null,
        winnerCatalogPlayerName: "Roki Sasaki RC", otherSport: "basketball",
      }, TITLE_DEPS);
      expect(veto.vetoed).toBe(false);
    });
  });

  it("VETOES a genuine contradiction: title names LeBron James, winner is Wembanyama", () => {
    const veto = mod.titleVetoes({
      title: "2023 Topps LeBron James #VW3",
      winnerSport: "basketball", winnerYear: 2023, winnerSetKey: null, winnerCardNumber: null,
      winnerCatalogPlayerName: "Victor Wembanyama", otherSport: "baseball",
    }, TITLE_DEPS);
    expect(veto.vetoed).toBe(true);
    expect(veto.detail).toMatch(/Lebron James/);
  });

  it("multi-player winner row: shares a token with ANY listed name -- no veto", () => {
    const veto = mod.titleVetoes({
      title: "1988 Donruss Cal Ripken Jr #1",
      winnerSport: "baseball", winnerYear: 1988, winnerSetKey: null, winnerCardNumber: null,
      winnerCatalogPlayerName: "Eddie Murray / Cal Ripken Jr.", otherSport: "basketball",
    }, TITLE_DEPS);
    expect(veto.vetoed).toBe(false);
  });

  it("never vetoes when the title carries no player guess at all (confidence-floor silence)", () => {
    const veto = mod.titleVetoes({
      title: "PSA 10 GEM MINT card lot vintage",
      winnerSport: "basketball", winnerYear: 2023, winnerSetKey: null, winnerCardNumber: null,
      winnerCatalogPlayerName: "Victor Wembanyama", otherSport: "baseball",
    }, TITLE_DEPS);
    expect(veto.vetoed).toBe(false);
  });
});

describe("resolve-split-identity-parks: REVIEW #1 -- physicalSaleKeyOf", () => {
  it("keys on destination|price (cents)|soldAt (day) -- title is deliberately NOT part of this key", () => {
    expect(mod.physicalSaleKeyOf({ price: 12.5, soldAt: "2026-06-02T02:59:03.000Z", title: "  Pikachu   V  Holo  " }, "hiq:basketball:2023:topps:vw3:base:no-auto"))
      .toBe("hiq:basketball:2023:topps:vw3:base:no-auto|1250|2026-06-02");
  });

  it("two differently-titled twins of the SAME physical sale AT THE SAME DESTINATION (different id, same price/day, DIFFERENT title formatting) still share one lock key", () => {
    // The delta review's own finding: a CardHedge-templated title and a
    // tca-ebay title for the exact same physical sale do not byte-match, so
    // keying the LOCK on title let two such twins serialize under different
    // keys. Dropping title from the key fixes that.
    const dest = "hiq:basketball:2023:topps:vw3:base:no-auto";
    const a = { id: "cardhedge::abc", price: 12.5, soldAt: "2026-06-02T02:59:03.000Z", title: "2023 Topps Now Victor Wembanyama RC #VW3 PSA-clean raw" };
    const b = { id: "tca-ebay::999-dup", price: 12.5, soldAt: "2026-06-02T18:00:00.000Z", title: "Wembanyama 2023 Topps Now Rookie VW3 Basketball Card" };
    expect(mod.physicalSaleKeyOf(a, dest)).toBe(mod.physicalSaleKeyOf(b, dest));
  });

  it("REVIEW #1 (MEDIUM follow-up): the SAME price+day at TWO DIFFERENT destinations gets TWO DIFFERENT keys -- unrelated cards must never share a lock queue", () => {
    const a = { id: "a", price: 1.99, soldAt: "2026-06-02T00:00:00.000Z", title: "unrelated card A" };
    const b = { id: "b", price: 1.99, soldAt: "2026-06-02T00:00:00.000Z", title: "unrelated card B" };
    expect(mod.physicalSaleKeyOf(a, "hiq:baseball:2023:topps:1:base:no-auto"))
      .not.toBe(mod.physicalSaleKeyOf(b, "hiq:baseball:2023:topps:2:base:no-auto"));
  });

  it("a genuinely different sale (different price) at the SAME destination gets a different key", () => {
    const dest = "hiq:baseball:2023:topps:1:base:no-auto";
    const a = { id: "a", price: 12.5, soldAt: "2026-06-02T00:00:00.000Z", title: "Pikachu V Holo" };
    const b = { id: "b", price: 99.99, soldAt: "2026-06-02T00:00:00.000Z", title: "Pikachu V Holo" };
    expect(mod.physicalSaleKeyOf(a, dest)).not.toBe(mod.physicalSaleKeyOf(b, dest));
  });
});

describe("resolve-split-identity-parks: REVIEW #1 (delta review) -- listingIdOf / sameListingIdentity", () => {
  it("prefers sourceExternalId when present", () => {
    expect(mod.listingIdOf({ id: "cardhedge::internal-1", sourceExternalId: "168568127039" })).toBe("168568127039");
  });

  it("falls back to the substring after the first '::' in id when sourceExternalId is absent", () => {
    expect(mod.listingIdOf({ id: "tca-ebay::168568127039" })).toBe("168568127039");
  });

  it("returns empty string for an id with no '::' and no sourceExternalId", () => {
    expect(mod.listingIdOf({ id: "no-separator-here" })).toBe("");
  });

  it("returns empty string when sourceExternalId is blank/whitespace and id has no separator", () => {
    expect(mod.listingIdOf({ id: "plainid", sourceExternalId: "   " })).toBe("");
  });

  it("sameListingIdentity: TRUE for two docs sharing a non-empty eBay item id under different id shapes/sources", () => {
    const a = { id: "cardhedge::internal-1", sourceExternalId: "168568127039", source: "cardhedge" };
    const b = { id: "tca-ebay::168568127039", source: "tca-ebay" };
    expect(mod.sameListingIdentity(a, b)).toBe(true);
  });

  it("sameListingIdentity: FALSE for a CardHedge sale id vs an eBay item id -- no cross-vendor listing id proof exists", () => {
    const a = { id: "cardhedge::ch-daily-1", sourceExternalId: "ch-daily::555001", source: "cardhedge" };
    const b = { id: "tca-ebay::168568127039", source: "tca-ebay" };
    expect(mod.sameListingIdentity(a, b)).toBe(false);
  });

  it("sameListingIdentity: FALSE when either side has no derivable listing id (absent beats wrong -- never guess)", () => {
    expect(mod.sameListingIdentity({ id: "no-sep" }, { id: "tca-ebay::123" })).toBe(false);
    expect(mod.sameListingIdentity({ id: "tca-ebay::123" }, { id: "also-no-sep" })).toBe(false);
    expect(mod.sameListingIdentity({ id: "no-sep-a" }, { id: "no-sep-b" })).toBe(false);
  });

  // REVIEW #1 (LOW follow-up, 2026-09-20). "undefined"/"null"/"NaN" (case-
  // insensitive, trimmed) are known corruption shapes for sourceExternalId
  // (or an id tail) -- a JS undefined/null/NaN stringified into a template
  // literal upstream -- and must read as EMPTY, never as a real listing id,
  // so two independently-corrupted rows can never "prove" a shared listing.
  it("listingIdOf: treats a literal 'undefined' sourceExternalId as empty and falls back to the id tail", () => {
    expect(mod.listingIdOf({ id: "tca-ebay::168568127039", sourceExternalId: "undefined" })).toBe("168568127039");
  });

  it("listingIdOf: treats 'null'/'NaN' (any case, whitespace-padded) sourceExternalId as empty", () => {
    expect(mod.listingIdOf({ id: "cardhedge::abc", sourceExternalId: "null" })).toBe("abc");
    expect(mod.listingIdOf({ id: "cardhedge::abc", sourceExternalId: "  NULL  " })).toBe("abc");
    expect(mod.listingIdOf({ id: "cardhedge::abc", sourceExternalId: "NaN" })).toBe("abc");
  });

  it("listingIdOf: treats a corrupted id TAIL (after sourceExternalId is absent) as empty too", () => {
    expect(mod.listingIdOf({ id: "cardhedge::undefined" })).toBe("");
    expect(mod.listingIdOf({ id: "tca-ebay::null" })).toBe("");
    expect(mod.listingIdOf({ id: "tca-ebay:: NaN " })).toBe("");
  });

  it("sameListingIdentity: FALSE for two docs that both stringified to the literal 'undefined' -- never a proof of a shared listing", () => {
    const a = { id: "cardhedge::internal-a", sourceExternalId: "undefined", source: "cardhedge" };
    const b = { id: "tca-ebay::internal-b", sourceExternalId: "undefined", source: "tca-ebay" };
    expect(mod.sameListingIdentity(a, b)).toBe(false);
  });

  it("sameListingIdentity: FALSE for two docs whose id TAIL both corrupted to 'null'", () => {
    const a = { id: "cardhedge::null" };
    const b = { id: "tca-ebay::null" };
    expect(mod.sameListingIdentity(a, b)).toBe(false);
  });
});

describe("resolve-split-identity-parks: REVIEW #5 -- isPinnedOrFlagged", () => {
  it("true for verifiedByUser", () => {
    expect(mod.isPinnedOrFlagged({ verifiedByUser: true })).toBe(true);
  });
  it("true for flaggedWrong", () => {
    expect(mod.isPinnedOrFlagged({ flaggedWrong: true })).toBe(true);
  });
  it("true for excludedFromFmv", () => {
    expect(mod.isPinnedOrFlagged({ excludedFromFmv: true })).toBe(true);
  });
  it("true for every USER_SEED_SOURCES source", () => {
    for (const source of mod.USER_SEED_SOURCES) {
      expect(mod.isPinnedOrFlagged({ source })).toBe(true);
    }
  });
  it("false for an ordinary vendor row with none of the flags", () => {
    expect(mod.isPinnedOrFlagged({ source: "tca-ebay", verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false })).toBe(false);
  });
  it("USER_SEED_SOURCES is the exact literal from soldCompsStore.service.ts (not exported there, kept in sync by inspection)", () => {
    expect([...mod.USER_SEED_SOURCES].sort()).toEqual(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"].sort());
  });
});
