/**
 * revert-set-sport-repair.cjs -- pure decision unit tests (planRow, cellOf).
 *
 * No Cosmos, no I/O: planRow is a pure function of the doc so REPORT and
 * APPLY can share the exact same decision (see revertSetSportRepairLane.test.ts
 * for the end-to-end fixture proving REPORT's counts equal APPLY's).
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../scripts/revert-set-sport-repair.cjs") as {
  planRow: (doc: Record<string, unknown>) => { action: string; [k: string]: unknown };
  cellOf: (hobbyiqCardIdBefore: string) => string | null;
  CELL_RE: RegExp;
  ALL_REPAIRED: string;
};

const baseDoc = (over: Record<string, unknown> = {}) => ({
  id: "cardhedge::ch-daily::1",
  cardId: "1649639019826x860979551007433600",
  sport: "baseball",
  hobbyiqCardId: "hiq:baseball:1988:fleer:8:base:no-auto",
  sportBefore: "basketball",
  hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:8:base:no-auto",
  setSportRepairedAt: "2026-08-20T21:57:21.352Z",
  title: "1988-89 Fleer Danny Ainge Celtics #8  MINT F3593 - Raw 10",
  ...over,
});

describe("revert-set-sport-repair: cellOf", () => {
  it("reads setKey|year from a well-formed hiq hobbyiqCardIdBefore", () => {
    expect(mod.cellOf("hiq:basketball:1988:fleer:8:base:no-auto")).toBe("fleer|1988");
  });
  it("returns null for a non-hiq / malformed value", () => {
    expect(mod.cellOf("")).toBeNull();
    expect(mod.cellOf(undefined as unknown as string)).toBeNull();
    expect(mod.cellOf("1649639019826x860979551007433600")).toBeNull();
    expect(mod.cellOf("hiq:basketball:not-a-year:fleer:8:base:no-auto")).toBeNull();
  });
});

describe("revert-set-sport-repair: planRow -- both write shapes", () => {
  it("PATCH shape: cardId is a vendor partition, unaffected by the flip -- restores in place", () => {
    const plan = mod.planRow(baseDoc());
    expect(plan.action).toBe("patch");
    expect(plan.newSport).toBe("basketball");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
  });

  it("RELOCATE shape: cardId equals the CURRENT (wrong) hobbyiqCardId -- the partition itself must move", () => {
    const plan = mod.planRow(baseDoc({
      cardId: "hiq:baseball:1988:fleer:8:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1988:fleer:8:base:no-auto",
      title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
    }));
    expect(plan.action).toBe("relocate");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
  });
});

describe("revert-set-sport-repair: planRow -- keep / leave / already-at-target / moved-since", () => {
  it("KEEP: title evidence backs the CURRENT sport, not sportBefore -- the flip was right", () => {
    const plan = mod.planRow(baseDoc({
      sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:99:base:no-auto",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:99:base:no-auto",
      title: "1988 Fleer Wade Boggs Red Sox #99",
    }));
    expect(plan.action).toBe("keep");
  });

  it("LEAVE (third-sport): title names neither sportBefore nor the current sport", () => {
    const plan = mod.planRow(baseDoc({
      sport: "basketball", hobbyiqCardId: "hiq:basketball:2018:topps-chrome:01:gold-refractor:no-auto",
      sportBefore: "hockey", hobbyiqCardIdBefore: "hiq:hockey:2018:topps-chrome:01:gold-refractor:no-auto",
      title: "2018 Topps Chrome UEFA Champions League Lightning Strike Gold #LSKM Kylian Mbappe",
    }));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("third-sport");
  });

  it("LEAVE (malformed-before-id): sportBefore or hobbyiqCardIdBefore missing", () => {
    const plan = mod.planRow(baseDoc({ sportBefore: "", hobbyiqCardIdBefore: "" }));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("malformed-before-id");
  });

  it("PATCH (alreadyAtTarget): current fields already equal the *Before fields -- stamp only, no new decision", () => {
    const plan = mod.planRow(baseDoc({
      sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:8:base:no-auto",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:8:base:no-auto",
      title: "irrelevant -- alreadyAtTarget short-circuits before judgeRestoreVerdict",
    }));
    expect(plan.action).toBe("patch");
    expect(plan.alreadyAtTarget).toBe(true);
  });

  it("LEAVE (rekeyed-since): sport and hobbyiqCardId's own sport segment disagree because a later lane independently patched `sport` to a third value without touching hobbyiqCardId", () => {
    // hobbyiqCardIdBefore is well-formed (7 segments), so reSportSlug succeeds;
    // the reconstruction (segment 1 swapped to the CURRENT sport, "baseball")
    // no longer matches the stored hobbyiqCardId (still carrying "football",
    // the value some other patch left it at) -- caught as rekeyed-since, not
    // a separate "sport disagrees with itself" branch (see the code comment:
    // once the reconstruction test passes, they can never disagree by
    // construction, so there is only ONE check, not two).
    const plan = mod.planRow(baseDoc({
      sport: "baseball", hobbyiqCardId: "hiq:football:2020:donruss:1:base:no-auto",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:2020:donruss:1:base:no-auto",
    }));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("rekeyed-since");
  });

  it("LEAVE (rekeyed-since): the exact Jordan :23 interleaving from the review -- a later checklist-numbered repoint added a :num-N tail within the wrong sport", () => {
    // PATCH shape: cardId is a vendor partition, hobbyiqCardId carries the
    // later lane's added precision.
    const patchShape = mod.planRow(baseDoc({
      cardId: "vendor-1",
      sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto:num-23",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
      title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
    }));
    expect(patchShape.action).toBe("leave");
    expect(patchShape.reason).toBe("rekeyed-since");

    // RELOCATE shape: cardId also carries the rekeyed id.
    const relocateShape = mod.planRow(baseDoc({
      cardId: "hiq:baseball:1988:fleer:17:base:no-auto:num-23",
      sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto:num-23",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
      title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
    }));
    expect(relocateShape.action).toBe("leave");
    expect(relocateShape.reason).toBe("rekeyed-since");
  });

  it("does NOT leave (rekeyed-since) when the current id is EXACTLY reSportSlug(hobbyiqCardIdBefore, sport) -- the untouched, restorable case", () => {
    const plan = mod.planRow(baseDoc({
      cardId: "vendor-2",
      sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
      title: "1988-89 FLEER MICHAEL JORDAN PSA 10 GEM MT #17 CHICAGO BULLS RARE GOAT !!",
    }));
    expect(plan.action).toBe("patch");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:17:base:no-auto");
  });

  it("LEAVE (malformed-current-id): hobbyiqCardId empty/absent never falls through to reasoning about cardId", () => {
    const plan = mod.planRow(baseDoc({ hobbyiqCardId: "", cardId: "hiq:baseball:1988:fleer:8:base:no-auto" }));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("malformed-current-id");
  });

  it("LEAVE (malformed-current-id): hobbyiqCardIdBefore is not well-formed enough for reSportSlug to reconstruct", () => {
    const plan = mod.planRow(baseDoc({ hobbyiqCardIdBefore: "hiq:basketball:1988:fleer" }));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("malformed-current-id");
  });
});

describe("revert-set-sport-repair: REPORT and APPLY decide identically", () => {
  it("planRow takes no APPLY-mode-dependent input -- same doc always yields the same plan", () => {
    const doc = baseDoc();
    const a = mod.planRow(doc);
    const b = mod.planRow(doc);
    expect(a).toEqual(b);
  });
});
