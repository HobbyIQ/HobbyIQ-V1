// CF-A-CODE-TWO-PLAYERS-SHARE-GETS-A-PLAYER-SEGMENT (Drew, 2026-09-28 14:35Z).
// Table validity + resolution tests for codeCollisions.ts, kept separate from
// hobbyIqCardId.test.ts's id-minting tests (which cover the integration).

import { describe, it, expect } from "vitest";
import {
  CODE_COLLISIONS,
  PRIZM_SS_XX_PLACEHOLDER,
  findCodeCollision,
  resolveCodeCollisionClaimant,
  resolveCodeCollisionFromTitle,
} from "../src/services/catalog/codeCollisions.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CODE_COLLISIONS — table validity", () => {
  it("has at least the 14 confirmed 2024 Bowman Chrome codes", () => {
    expect(CODE_COLLISIONS.length).toBeGreaterThanOrEqual(14);
  });

  it("every entry has exactly 2+ claimants with distinct surname slugs", () => {
    for (const entry of CODE_COLLISIONS) {
      const slugs = entry.claimants.map((c) => c.surnameSlug);
      const distinct = new Set(slugs);
      expect(distinct.size, `${entry.code}: surname slugs must be distinct (got ${slugs.join(", ")})`).toBe(slugs.length);
      for (const slug of slugs) {
        expect(slug.length, `${entry.code}: surname slug must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every entry's claimant playerNames are distinct", () => {
    for (const entry of CODE_COLLISIONS) {
      const names = entry.claimants.map((c) => c.playerName.toLowerCase().trim());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("no duplicate (sport, year, setKey, code) rows", () => {
    const seen = new Set<string>();
    for (const entry of CODE_COLLISIONS) {
      const key = `${entry.sport}|${entry.year}|${entry.setKey}|${entry.code}`.toLowerCase();
      expect(seen.has(key), `duplicate registration for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("CPA-GD, CPA-JF are NOT registered (provisional/unconfirmed per the ruling)", () => {
    for (const code of ["CPA-GD", "CPA-JF"]) {
      const hit = findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code });
      expect(hit, `${code} must stay excluded until confirmed`).toBeNull();
    }
  });

  it("CPA-ES is registered (Estuar Suero / Emilio Sanchez, confirmed 2026-09-28)", () => {
    const hit = findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-ES" });
    expect(hit).not.toBeNull();
    const slugs = hit!.claimants.map((c) => c.surnameSlug).sort();
    expect(slugs).toEqual(["sanchez", "suero"]);
  });
});

describe("findCodeCollision", () => {
  it("finds a registered code hyphen/case-insensitively", () => {
    expect(findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-PS" })).not.toBeNull();
    expect(findCodeCollision({ sport: "BASEBALL", year: 2024, setKey: "Bowman-Chrome", code: "cpaps" })).not.toBeNull();
    expect(findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "cpa ps" })).not.toBeNull();
  });

  it("does not find an unregistered code", () => {
    expect(findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-GLO" })).toBeNull();
  });

  it("does not find a registered code under the wrong year/setKey", () => {
    expect(findCodeCollision({ sport: "baseball", year: 2025, setKey: "bowman-chrome", code: "CPA-PS" })).toBeNull();
    expect(findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman", code: "CPA-PS" })).toBeNull();
  });

  it("refuses on missing inputs rather than guessing", () => {
    expect(findCodeCollision({ sport: "", year: 2024, setKey: "bowman-chrome", code: "CPA-PS" })).toBeNull();
    expect(findCodeCollision({ sport: "baseball", year: NaN, setKey: "bowman-chrome", code: "CPA-PS" })).toBeNull();
  });
});

describe("resolveCodeCollisionClaimant", () => {
  const entry = findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-PS" })!;

  it("resolves each claimant by exact name", () => {
    expect(resolveCodeCollisionClaimant(entry, "Paul Skenes")?.surnameSlug).toBe("skenes");
    expect(resolveCodeCollisionClaimant(entry, "Paulino Santana")?.surnameSlug).toBe("santana");
  });

  it("is case/punctuation insensitive", () => {
    expect(resolveCodeCollisionClaimant(entry, "  paul   SKENES ")?.surnameSlug).toBe("skenes");
  });

  it("returns null for blank, unrelated, or ambiguous input", () => {
    expect(resolveCodeCollisionClaimant(entry, "")).toBeNull();
    expect(resolveCodeCollisionClaimant(entry, null)).toBeNull();
    expect(resolveCodeCollisionClaimant(entry, "Someone Else")).toBeNull();
  });
});

describe("resolveCodeCollisionFromTitle — the R34-style resolution", () => {
  const entry = findCodeCollision({ sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-PS" })!;

  it("resolves when the title names exactly one claimant", () => {
    const title = "2024 Bowman Chrome Paul Skenes 1st Bowman Auto Refractor #CPA-PS";
    expect(resolveCodeCollisionFromTitle(entry, title)?.surnameSlug).toBe("skenes");
  });

  it("resolves the OTHER claimant from a different title", () => {
    const title = "Paulino Santana 2024 Bowman Chrome Autographs Green 83/99 #CPA-PS Auto PSA 10";
    expect(resolveCodeCollisionFromTitle(entry, title)?.surnameSlug).toBe("santana");
  });

  it("is UNDERIVABLE when the title names neither player", () => {
    const title = "2024 Bowman Chrome Auto #CPA-PS PSA 10";
    expect(resolveCodeCollisionFromTitle(entry, title)).toBeNull();
  });

  it("is UNDERIVABLE when the title names BOTH players (never a guess)", () => {
    const title = "2024 Bowman Chrome #CPA-PS Paul Skenes / Paulino Santana lot";
    expect(resolveCodeCollisionFromTitle(entry, title)).toBeNull();
  });

  it("does not false-match a surname as a substring of another word", () => {
    // "santana" must not match inside an unrelated longer token.
    const title = "2024 Bowman Chrome Santanawood Auto #CPA-PS";
    expect(resolveCodeCollisionFromTitle(entry, title)).toBeNull();
  });
});

describe("PRIZM_SS_XX_PLACEHOLDER — shape only, not a ruling", () => {
  it("is well-formed like a real entry (surname slugs distinct, names distinct)", () => {
    const slugs = PRIZM_SS_XX_PLACEHOLDER.claimants.map((c) => c.surnameSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((s) => s.length > 0)).toBe(true);
  });

  it("is NOT registered in CODE_COLLISIONS / findCodeCollision", () => {
    expect(CODE_COLLISIONS).not.toContain(PRIZM_SS_XX_PLACEHOLDER);
    expect(findCodeCollision({
      sport: PRIZM_SS_XX_PLACEHOLDER.sport,
      year: PRIZM_SS_XX_PLACEHOLDER.year,
      setKey: PRIZM_SS_XX_PLACEHOLDER.setKey,
      code: PRIZM_SS_XX_PLACEHOLDER.code,
    })).toBeNull();
  });

  it("proves the id-minting SHAPE works for a non-baseball, non-CPA code, given the table entry directly", () => {
    // findCodeCollision won't find it (it is deliberately unregistered), so
    // this calls resolveCodeCollisionClaimant against the placeholder entry
    // directly -- exercising the same mechanics computeHobbyIqCardId uses
    // internally, for a basketball Prizm-shaped code, without registering a
    // fictional card in the real table.
    const won = resolveCodeCollisionClaimant(PRIZM_SS_XX_PLACEHOLDER, "Placeholder Player One");
    expect(won?.surnameSlug).toBe("one");

    // And a card NUMBER shaped like SS-99 mints normally through
    // computeHobbyIqCardId when it is NOT a registered collision -- proving
    // the shape (basketball, Prizm, an SS- prefix) is not itself special.
    const slug = computeHobbyIqCardId({
      sport: PRIZM_SS_XX_PLACEHOLDER.sport,
      year: PRIZM_SS_XX_PLACEHOLDER.year,
      setKey: PRIZM_SS_XX_PLACEHOLDER.setKey,
      cardNumber: PRIZM_SS_XX_PLACEHOLDER.code,
      parallel: "Base",
      isAuto: false,
      authoritativeSetKey: true,
    });
    expect(slug).toBe("hiq:basketball:2024:panini-prizm:ss-99:base:no-auto");
  });
});
