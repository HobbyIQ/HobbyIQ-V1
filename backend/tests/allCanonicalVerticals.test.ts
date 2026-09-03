// CF-ALL-CANONICAL-VERTICALS + CF-LONGTAIL-VERTICAL-FALLBACK (Drew, 2026-08-17:
// "find it and find it ALL").
//
// CANONICAL_SPORTS already contained golf, racing, wrestling, mma, boxing,
// tennis, multi-sport and non-sport — the namespace was never the problem.
// Nothing DETECTED them, so sport stayed null, slugGuard refused on
// sport-uncanonical, and the row never got a slug however good its setKey
// vocabulary was.
//
// Measured over the 45,288 rows still unkeyed after the TCG verticals shipped,
// these tokens classify 87.5%:
//
//     non-sport   20,938      mma          1,918
//     golf         4,615      tennis       1,116
//     wrestling    4,099      boxing         437
//     racing       3,511      multi-sport  3,008

import { describe, it, expect } from "vitest";
import { resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSportFromContext } from "../src/services/portfolioiq/soldCompsStore.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

function endToEnd(setName: string) {
  const sport = inferSportFromContext(setName, setName, null);
  const key = resolveSetKeyForSlug(sport ?? "", setName, 2020);
  const guard = guardSlugInputs({ sport, year: 2020, normalizedSetKey: key, cardNumber: "1" });
  return { sport, key, ok: guard.ok };
}

describe("CF-ALL-CANONICAL-VERTICALS — every vertical gets detected", () => {
  it("tags each vertical from its own set name", () => {
    const cases: Array<[string, string]> = [
      ["2001 Upper Deck Golf", "golf"],
      ["2020 Topps Chrome F1 Racing", "racing"],
      ["2022 Panini Prizm WWE Wrestling", "wrestling"],
      ["1985 Topps WWF Wrestling", "wrestling"],
      ["2022 Panini Prizm UFC", "mma"],
      ["2003 Netpro Tennis", "tennis"],
      ["1985 Garbage Pail Kids Original Series 1", "non-sport"],
      ["1990 Impel Marvel Universe", "non-sport"],
      ["2024 Topps Now Olympics Multi-Sport", "multi-sport"],
    ];
    for (const [name, want] of cases) {
      expect(inferSportFromContext(name, name, null), `"${name}"`).toBe(want);
    }
  });

  it("orders league acronyms ahead of generic words", () => {
    // "Panini Prizm UFC" must be mma, not caught by a looser rule; non-sport is
    // last so a product merely mentioning a character cannot outrank a sport.
    expect(inferSportFromContext("2022 Panini Prizm UFC", "", null)).toBe("mma");
    expect(inferSportFromContext("2022 Panini Prizm WWE Wrestling", "", null)).toBe("wrestling");
  });

  it("still prefers the real vocabulary where the product is known", () => {
    // Most long-tail products ARE known — the manufacturer rule resolves them.
    // The fallback must not shadow that.
    expect(resolveSetKeyForSlug("racing", "2020 Topps Chrome F1 Racing", 2020)).toBe("topps-chrome");
    expect(resolveSetKeyForSlug("mma", "2022 Panini Prizm UFC", 2022)).toBe("panini-prizm");
    expect(resolveSetKeyForSlug("golf", "2001 Upper Deck Golf", 2001)).toBe("upper-deck");
  });

  it("falls back to the CLEAN product name instead of a year-prefixed refusal", () => {
    // The year is redundant — slug segment 2 carries it — so stripping it yields
    // a truthful stable key. Strictly better than no slug at all.
    expect(resolveSetKeyForSlug("non-sport", "1992 Marvel Masterpieces", 1992)).toBe("marvel-masterpieces");
    expect(resolveSetKeyForSlug("non-sport", "1990 Impel Marvel Universe", 1990)).toBe("impel-marvel-universe");
    expect(resolveSetKeyForSlug("tennis", "2003 Netpro Tennis", 2003)).toBe("netpro-tennis");
  });

  it("produces a slug end to end for every vertical — the whole point", () => {
    for (const n of [
      "2001 Upper Deck Golf",
      "2020 Topps Chrome F1 Racing",
      "2022 Panini Prizm WWE Wrestling",
      "2022 Panini Prizm UFC",
      "2003 Netpro Tennis",
      "1985 Garbage Pail Kids Original Series 1",
      "1992 Marvel Masterpieces",
      "2024 Topps Now Olympics Multi-Sport",
    ]) {
      const r = endToEnd(n);
      expect(r.ok, `"${n}" still refused (sport=${r.sport} key=${r.key})`).toBe(true);
    }
  });

  it("leaves the major sports strict — a year-prefixed key there is a real parse failure", () => {
    // The fallback is scoped to long-tail verticals deliberately. For baseball a
    // year-prefixed key means the parse failed, and refusing is still correct.
    //
    // CF-CHRONIC-REDS-DRIFT (2026-09-03). This used to feed the guard
    // `resolveSetKeyForSlug("baseball", "2019 Some Unknown Product", 2019)` and
    // expect a refusal, relying on that call RETURNING a year-prefixed key.
    // normalizeSetKey now strips the leading year upstream
    // (CF-YEAR-IS-NOT-A-SEGMENT), so the resolver no longer emits one and the
    // guard correctly accepted -- the test was asserting the old plumbing, not
    // the rule. The rule itself is unchanged, so assert it directly: for a
    // major sport, a year-prefixed key is still refused.
    const key = resolveSetKeyForSlug("baseball", "2019 Some Unknown Product", 2019);
    expect(
      guardSlugInputs({ sport: "baseball", year: 2019, normalizedSetKey: `2019-${key}`, cardNumber: "1" }).ok,
      "a year-prefixed key on a major sport must still be refused",
    ).toBe(false);
    // And the resolver no longer hands the guard one in the first place.
    expect(key).not.toMatch(/^\d{4}-/);
  });

  it("does not disturb the major sports", () => {
    expect(inferSportFromContext("2024 Topps Chrome Baseball", "", null)).toBe("baseball");
    expect(inferSportFromContext("2024 Panini Prizm Football", "", null)).toBe("football");
    expect(inferSportFromContext("1955 Bowman Baseball", "", null)).toBe("baseball");
    expect(resolveSetKeyForSlug("baseball", "2024 Topps Chrome", 2024)).toBe("topps-chrome");
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm", 2024)).toBe("panini-prizm");
  });
});
