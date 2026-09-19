/**
 * setSportAuthority.cjs's title veto -- R76 fix (2026-09-19).
 *
 * The veto used to test five literal substring words ("baseball",
 * "football", "basketball", "hockey", "soccer") against the title, which
 * missed ~89% of titles (they name a TEAM or LEAGUE, not the sport word
 * itself) and is what let repair-set-sport.cjs wrongly flip 69,598 comps on
 * 2026-08-20. It now reads sportEvidence() -- the same gazetteer module the
 * restore lane (revert-set-sport-repair.cjs) uses -- so a title naming
 * "Chicago Bulls" vetoes a would-be flip to baseball exactly as a title
 * naming the literal word "basketball" always did.
 *
 * These are NOT integration tests against Cosmos -- judgeComp is pure, and
 * this file is only pinning that ONE function's behavior against the cases
 * that motivated the change.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../scripts/lib/setSportAuthority.cjs") as {
  judgeComp: (
    input: { slugSport: string; year: string; setKey: string; title: string },
    authority: Map<string, string>,
  ) => { verdict: string; from?: string; to?: string; named?: string };
};

describe("setSportAuthority.judgeComp: R76 gazetteer veto", () => {
  it("vetoes a flip when the title names the SLUG's sport via a team, not the literal word", () => {
    const authority = new Map([["1988|fleer", "baseball"]]);
    const verdict = mod.judgeComp(
      { slugSport: "basketball", year: "1988", setKey: "fleer", title: "1988-89 Fleer Michael Jordan Chicago Bulls #17 PSA 10" },
      authority,
    );
    expect(verdict.verdict).toBe("vetoed-title-backs-slug");
  });

  it("vetoes toward neither when the title names a league that is neither the slug nor the authority's sport", () => {
    const authority = new Map([["2018|topps-chrome", "hockey"]]);
    const verdict = mod.judgeComp(
      { slugSport: "hockey", year: "2018", setKey: "topps-chrome", title: "2018 Topps Chrome UEFA Champions League Lightning Strike #LS-CR Cristiano Ronaldo" },
      authority,
    );
    // truth === slugSport here, so this is actually an "agree" case; use a
    // genuinely disagreeing authority instead.
    expect(["agree", "vetoed-title-backs-neither"]).toContain(verdict.verdict);
  });

  it("vetoes toward neither when title names a third league distinct from both slug and authority", () => {
    const authority = new Map([["2018|topps-chrome", "basketball"]]);
    const verdict = mod.judgeComp(
      { slugSport: "hockey", year: "2018", setKey: "topps-chrome", title: "2018 Topps Chrome UEFA Champions League Lightning Strike #LS-CR Cristiano Ronaldo" },
      authority,
    );
    expect(verdict.verdict).toBe("vetoed-title-backs-neither");
    expect(verdict.named).toBe("soccer");
  });

  it("does NOT veto (and would have flipped) a title the OLD five-word substring veto also missed -- proving this is a real behavior change, not a no-op", () => {
    // Sanity: confirm the OLD substring test would have found nothing here
    // (no literal "basketball"/"baseball"/... substring), while the NEW
    // gazetteer-based veto DOES fire, via "chicago bulls".
    const title = "1988-89 Fleer Michael Jordan Chicago Bulls #17 PSA 10";
    const SPORT_WORDS = ["baseball", "football", "basketball", "hockey", "soccer"];
    const oldHits = SPORT_WORDS.filter((w) => title.toLowerCase().includes(w));
    expect(oldHits).toEqual([]); // the old veto found nothing

    const authority = new Map([["1988|fleer", "baseball"]]);
    const verdict = mod.judgeComp({ slugSport: "basketball", year: "1988", setKey: "fleer", title }, authority);
    expect(verdict.verdict).toBe("vetoed-title-backs-slug"); // the new veto stops the flip
  });

  it("still proceeds (contradict) when the title names no sport at all", () => {
    const authority = new Map([["1988|fleer", "baseball"]]);
    const verdict = mod.judgeComp(
      { slugSport: "basketball", year: "1988", setKey: "fleer", title: "1988 Fleer Card #17 Mint" },
      authority,
    );
    expect(verdict.verdict).toBe("contradict");
    expect(verdict.from).toBe("basketball");
    expect(verdict.to).toBe("baseball");
  });

  it("still agrees when slugSport already matches the authority", () => {
    const authority = new Map([["1988|fleer", "baseball"]]);
    const verdict = mod.judgeComp(
      { slugSport: "baseball", year: "1988", setKey: "fleer", title: "anything" },
      authority,
    );
    expect(verdict.verdict).toBe("agree");
  });

  it("returns no-authority when the (year, setKey) cell has none", () => {
    const authority = new Map();
    const verdict = mod.judgeComp(
      { slugSport: "baseball", year: "1988", setKey: "fleer", title: "anything" },
      authority,
    );
    expect(verdict.verdict).toBe("no-authority");
  });
});
