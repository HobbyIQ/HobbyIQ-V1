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
  reSportSlug: (slug: string, toSport: string) => string | null;
  checklistEvidenceCandidateIds: (doc: Record<string, unknown>) => { candidateCurrent: string | null; candidateBefore: string | null };
  checklistMatchOf: (catalogRow: Record<string, unknown> | null, salePlayerName: unknown, catalogAuthorityOf: (s: unknown) => string, playerIdentityKey: (n: unknown) => string) => "match" | "different-card" | "no-row";
  judgeChecklistEvidenceVerdict: (input: { beforeMatch: string; currentMatch: string }) => { verdict: string; reason: string; detail: string };
  planRowChecklistEvidence: (doc: Record<string, unknown>, checklistVerdict: { verdict: string; reason: string; detail: string }) => { action: string; [k: string]: unknown };
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

describe("revert-set-sport-repair: checklistEvidenceCandidateIds (MODE=checklist-evidence)", () => {
  it("builds candidateCurrent from hobbyiqCardId unchanged, candidateBefore as the SAME id with only the sport segment swapped", () => {
    const ids = mod.checklistEvidenceCandidateIds({ hobbyiqCardId: "hiq:baseball:1988:fleer:8:base:no-auto", sportBefore: "basketball" });
    expect(ids.candidateCurrent).toBe("hiq:baseball:1988:fleer:8:base:no-auto");
    expect(ids.candidateBefore).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
  });

  it("candidateBefore carries forward a LATER lane's :num-N tail -- built from the CURRENT id, never hobbyiqCardIdBefore", () => {
    const ids = mod.checklistEvidenceCandidateIds({ hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto:num-23", sportBefore: "basketball" });
    expect(ids.candidateBefore).toBe("hiq:basketball:1988:fleer:17:base:no-auto:num-23");
  });

  it("returns null candidates when hobbyiqCardId is empty or not a well-formed hiq slug", () => {
    expect(mod.checklistEvidenceCandidateIds({ hobbyiqCardId: "", sportBefore: "basketball" })).toEqual({ candidateCurrent: null, candidateBefore: null });
    expect(mod.checklistEvidenceCandidateIds({ hobbyiqCardId: "vendor-123", sportBefore: "basketball" }).candidateBefore).toBeNull();
  });
});

describe("revert-set-sport-repair: checklistMatchOf -- a checklist-authority address is not evidence unless it names the SAME player", () => {
  const authorityOf = (source: string) => (source === "checklistcenter" ? "checklist" : source === "cardhedge" ? "vendor" : "unknown");
  const keyOf = (name: string) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  it("no-row: no catalog row at the address", () => {
    expect(mod.checklistMatchOf(null, "Barry Bonds", authorityOf, keyOf)).toBe("no-row");
  });
  it("no-row: a row exists but is not checklist-authority (vendor/derived/unknown source)", () => {
    expect(mod.checklistMatchOf({ source: "cardhedge", playerName: "Barry Bonds" }, "Barry Bonds", authorityOf, keyOf)).toBe("no-row");
  });
  it("match: checklist-authority AND the same playerIdentityKey as the sale", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Barry Bonds" }, "Barry Bonds", authorityOf, keyOf)).toBe("match");
  });
  it("different-card: checklist-authority but a DIFFERENT player -- the cell-collision case (Barry Bonds catalog row, Patrick Ewing sale, same year/setKey/cardNumber cell)", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Barry Bonds" }, "Patrick Ewing", authorityOf, keyOf)).toBe("different-card");
  });
  it("different-card: checklist-authority but the SALE carries no playerName to compare -- cannot confirm, never trust the bare address", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "Barry Bonds" }, "", authorityOf, keyOf)).toBe("different-card");
  });
  it("different-card: checklist-authority but the ROW carries no playerName", () => {
    expect(mod.checklistMatchOf({ source: "checklistcenter", playerName: "" }, "Barry Bonds", authorityOf, keyOf)).toBe("different-card");
  });
});

describe("revert-set-sport-repair: judgeChecklistEvidenceVerdict (MODE=checklist-evidence)", () => {
  it("restore: only the before-sport candidate MATCHES", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "no-row" });
    expect(v.verdict).toBe("restore");
    expect(v.reason).toBe("checklist-backs-before");
  });
  it("keep: only the current-sport candidate MATCHES", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "no-row", currentMatch: "match" });
    expect(v.verdict).toBe("keep");
    expect(v.reason).toBe("checklist-backs-current");
  });
  it("leave (both-sports-have-checklist-row): both candidates MATCH", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "match" });
    expect(v.verdict).toBe("leave");
    expect(v.reason).toBe("both-sports-have-checklist-row");
  });
  it("leave (no-checklist-row-either): neither candidate has any row", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "no-row", currentMatch: "no-row" });
    expect(v.verdict).toBe("leave");
    expect(v.reason).toBe("no-checklist-row-either");
  });
  it("leave (checklist-row-names-different-card): a candidate is checklist-authority but names a DIFFERENT player -- named separately from no-checklist-row-either", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "different-card", currentMatch: "no-row" });
    expect(v.verdict).toBe("leave");
    expect(v.reason).toBe("checklist-row-names-different-card");
  });
  it("leave (checklist-row-names-different-card) takes priority over no-checklist-row-either when only one side has a mismatched row", () => {
    const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "no-row", currentMatch: "different-card" });
    expect(v.reason).toBe("checklist-row-names-different-card");
  });

  describe("two-sport-athlete bound (orchestrator ruling, review MEDIUM, 2026-09-19)", () => {
    it("leave (two-sport-athlete): before=match, current=no-row, AND the sale is a known two-sport athlete -- absence is not enough", () => {
      const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "no-row", saleIsTwoSportAthlete: true });
      expect(v.verdict).toBe("leave");
      expect(v.reason).toBe("two-sport-athlete");
    });
    it("restore (unchanged): before=match, current=no-row, but saleIsTwoSportAthlete is false/omitted -- the ordinary case", () => {
      expect(mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "no-row", saleIsTwoSportAthlete: false }).verdict).toBe("restore");
      expect(mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "no-row" }).verdict).toBe("restore");
    });
    it("restore: before=match, current=different-card, AND the sale IS a two-sport athlete -- POSITIVE counter-evidence overrides the bound", () => {
      const v = mod.judgeChecklistEvidenceVerdict({ beforeMatch: "match", currentMatch: "different-card", saleIsTwoSportAthlete: true });
      expect(v.verdict).toBe("restore");
      expect(v.reason).toBe("checklist-backs-before");
    });
    it("the bound only fires on the restore branch -- a two-sport athlete flagged on a KEEP or LEAVE verdict is unaffected", () => {
      expect(mod.judgeChecklistEvidenceVerdict({ beforeMatch: "no-row", currentMatch: "match", saleIsTwoSportAthlete: true }).verdict).toBe("keep");
      expect(mod.judgeChecklistEvidenceVerdict({ beforeMatch: "no-row", currentMatch: "no-row", saleIsTwoSportAthlete: true }).verdict).toBe("leave");
    });
  });
});

describe("revert-set-sport-repair: two-sport-athletes gazetteer", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const gaz = require("../scripts/lib/two-sport-athletes.cjs") as {
    TWO_SPORT_ATHLETES: string[];
    buildTwoSportAthleteKeys: (playerIdentityKey: (n: unknown) => string) => Set<string>;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { playerIdentityKey } = require("../dist/services/catalog/playerIdentityKey.js") as { playerIdentityKey: (n: unknown) => string };

  it("builds one distinct key per listed name -- no accidental collisions", () => {
    const keys = gaz.buildTwoSportAthleteKeys(playerIdentityKey);
    expect(keys.size).toBe(gaz.TWO_SPORT_ATHLETES.length);
  });

  it("recognises the reviewer's own worked example (Bo Jackson) and rejects an ordinary player", () => {
    const keys = gaz.buildTwoSportAthleteKeys(playerIdentityKey);
    expect(keys.has(playerIdentityKey("Bo Jackson"))).toBe(true);
    expect(keys.has(playerIdentityKey("Kevin McHale"))).toBe(false);
  });

  it("matches a name-variant via the SAME playerIdentityKey reduction (punctuation-insensitive)", () => {
    const keys = gaz.buildTwoSportAthleteKeys(playerIdentityKey);
    expect(keys.has(playerIdentityKey("D.J. Dozier"))).toBe(true);
    expect(keys.has(playerIdentityKey("DJ Dozier"))).toBe(true);
  });
});

describe("revert-set-sport-repair: planRowChecklistEvidence -- write shapes and guards mirror planRow", () => {
  const RESTORE_VERDICT = { verdict: "restore", reason: "checklist-backs-before", detail: "x" };
  const KEEP_VERDICT = { verdict: "keep", reason: "checklist-backs-current", detail: "x" };
  const LEAVE_VERDICT = { verdict: "leave", reason: "no-checklist-row-either", detail: "x" };

  it("PATCH shape: cardId is a vendor partition -- restores in place, target is candidateBefore", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc(), RESTORE_VERDICT);
    expect(plan.action).toBe("patch");
    expect(plan.newSport).toBe("basketball");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
  });

  it("RELOCATE shape: cardId equals the CURRENT hobbyiqCardId", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc({
      cardId: "hiq:baseball:1988:fleer:8:base:no-auto",
      hobbyiqCardId: "hiq:baseball:1988:fleer:8:base:no-auto",
    }), RESTORE_VERDICT);
    expect(plan.action).toBe("relocate");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:8:base:no-auto");
  });

  it("restores the rekeyed-since Jordan :23 case -- planRow LEAVES this same doc, planRowChecklistEvidence RESTOREs it to candidateBefore (carrying the tail)", () => {
    const doc = baseDoc({
      cardId: "vendor-1",
      sport: "baseball", hobbyiqCardId: "hiq:baseball:1988:fleer:17:base:no-auto:num-23",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:17:base:no-auto",
    });
    expect(mod.planRow(doc).action).toBe("leave"); // the default mode's own documented refusal
    expect(mod.planRow(doc).reason).toBe("rekeyed-since");

    const plan = mod.planRowChecklistEvidence(doc, RESTORE_VERDICT);
    expect(plan.action).toBe("patch");
    expect(plan.newHobbyiqCardId).toBe("hiq:basketball:1988:fleer:17:base:no-auto:num-23"); // NOT hobbyiqCardIdBefore
    expect(plan.newSport).toBe("basketball");
  });

  it("KEEP passes the checklist verdict's own reason/detail through untouched", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc(), KEEP_VERDICT);
    expect(plan.action).toBe("keep");
    expect(plan.reason).toBe("checklist-backs-current");
  });

  it("LEAVE passes the checklist verdict's own reason/detail through untouched", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc(), LEAVE_VERDICT);
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("no-checklist-row-either");
  });

  it("LEAVE (malformed-before-id): sportBefore or hobbyiqCardIdBefore missing, same as planRow", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc({ sportBefore: "", hobbyiqCardIdBefore: "" }), RESTORE_VERDICT);
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("malformed-before-id");
  });

  it("LEAVE (malformed-current-id): hobbyiqCardId empty/absent", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc({ hobbyiqCardId: "" }), RESTORE_VERDICT);
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("malformed-current-id");
  });

  it("PATCH (alreadyAtTarget): current fields already equal the *Before fields -- stamp only, checklist verdict never consulted", () => {
    const plan = mod.planRowChecklistEvidence(baseDoc({
      sport: "basketball", hobbyiqCardId: "hiq:basketball:1988:fleer:8:base:no-auto",
      sportBefore: "basketball", hobbyiqCardIdBefore: "hiq:basketball:1988:fleer:8:base:no-auto",
    }), LEAVE_VERDICT);
    expect(plan.action).toBe("patch");
    expect(plan.alreadyAtTarget).toBe(true);
  });

  it("takes no APPLY-mode-dependent input -- same doc + verdict always yields the same plan", () => {
    const doc = baseDoc();
    const a = mod.planRowChecklistEvidence(doc, RESTORE_VERDICT);
    const b = mod.planRowChecklistEvidence(doc, RESTORE_VERDICT);
    expect(a).toEqual(b);
  });
});

describe("revert-set-sport-repair: reSportSlug (shared reconstruction helper)", () => {
  it("swaps ONLY the sport segment, byte-preserving every other segment including a later :num-N tail", () => {
    expect(mod.reSportSlug("hiq:baseball:1988:fleer:17:base:no-auto:num-23", "basketball")).toBe("hiq:basketball:1988:fleer:17:base:no-auto:num-23");
  });
  it("returns null for a non-hiq or too-short slug", () => {
    expect(mod.reSportSlug("vendor-123", "basketball")).toBeNull();
    expect(mod.reSportSlug("hiq:baseball:1988", "basketball")).toBeNull();
  });
});
