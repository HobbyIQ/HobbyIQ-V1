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
const { playerTheTitleAllows } = require("../dist/services/portfolioiq/playerTheTitleAllows.js") as { playerTheTitleAllows: (a: unknown, b: unknown) => unknown };

const { sportEvidence } = require("../scripts/lib/sport-title-evidence.cjs") as { sportEvidence: (t: string) => { sports: Set<string> } };

const TITLE_DEPS = { inferSetKeyFromTitle, resolveSetKeyForSlug, extractCardNumberFromTitle, sameCardNumber, playerTheTitleAllows, sportEvidenceFn: sportEvidence };

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
