// CF-TCG-VERTICAL-VOCABULARY (Drew, 2026-08-17).
//
// Yu-Gi-Oh, Magic and One Piece sales had NO sport tag AND no set vocabulary,
// so slugGuard refused every one on both counts — ~84,000 sales a day. The two
// fixes only work together: a set table the row never reaches is worthless, and
// a sport tag with no table still yields a year-prefixed key the guard rejects.
//
// Sources are free and keyless: db.ygoprodeck.com (1,032 sets) and
// api.scryfall.com (1,047 sets). Match rates were MEASURED against the setNames
// actually present in our unkeyed rows before any code was written — Yu-Gi-Oh
// 97.8%, Magic ~98% with four manual aliases.

import { describe, it, expect } from "vitest";
import { resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSportFromContext } from "../src/services/portfolioiq/soldCompsStore.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

/** End to end: the row must actually produce a slug, not merely a nicer key. */
function slugs(setName: string): { sport: string | null; key: string; ok: boolean } {
  const sport = inferSportFromContext(setName, setName, null);
  const key = resolveSetKeyForSlug(sport ?? "", setName, 2024);
  const guard = guardSlugInputs({ sport, year: 2024, normalizedSetKey: key, cardNumber: "1" });
  return { sport, key, ok: guard.ok };
}

describe("CF-TCG-VERTICAL-VOCABULARY", () => {
  it("tags the vertical from the set name", () => {
    expect(inferSportFromContext("2024 Yu-Gi-Oh! Rage of the Abyss", "", null)).toBe("yugioh");
    expect(inferSportFromContext("1993 Magic The Gathering Beta", "", null)).toBe("tcg-other");
    expect(inferSportFromContext("2024 One Piece Two Legends", "", null)).toBe("anime-tcg");
  });

  it("resolves Yu-Gi-Oh sets to their real set code", () => {
    expect(resolveSetKeyForSlug("yugioh", "2024 Yu-Gi-Oh! Rage of the Abyss", 2024)).toBe("rota");
    expect(resolveSetKeyForSlug("yugioh", "2002 Yu-Gi-Oh! Legend of Blue Eyes White Dragon", 2002)).toBe("lob");
    // Same set, three vendor spellings, one key — the point of stripping the
    // year and the vertical before lookup.
    for (const n of ["Rage of the Abyss", "Yu-Gi-Oh Rage of the Abyss", "2024 Yu-Gi-Oh! Rage of the Abyss"]) {
      expect(resolveSetKeyForSlug("yugioh", n, 2024)).toBe("rota");
    }
  });

  it("resolves Magic sets, including the vendor names Scryfall spells differently", () => {
    // Scryfall calls these "Limited Edition Beta"/"Limited Edition Alpha";
    // sellers write "Beta"/"Alpha". Those two alone were 5,561 of Magic's
    // 5,914 unmatched sales.
    expect(resolveSetKeyForSlug("tcg-other", "1993 Magic The Gathering Beta", 1993)).toBe("leb");
    expect(resolveSetKeyForSlug("tcg-other", "1993 Magic The Gathering Alpha", 1993)).toBe("lea");
    expect(resolveSetKeyForSlug("tcg-other", "2025 Magic The Gathering Aetherdrift", 2025)).toBe("dft");
  });

  it("gives One Piece a clean stable key without a keyed API dependency", () => {
    // Every One Piece API found needs a key or is a personal project. Its set
    // names are already clean product names, so the year strip is enough. A
    // clean name still joins to itself across spellings and passes the guard.
    expect(resolveSetKeyForSlug("anime-tcg", "2024 One Piece Two Legends", 2024)).toBe("one-piece-two-legends");
    expect(resolveSetKeyForSlug("anime-tcg", "2022 One Piece Romance Dawn", 2022)).toBe("one-piece-romance-dawn");
  });

  it("actually produces a slug end to end — the whole point", () => {
    for (const n of [
      "2024 Yu-Gi-Oh! Quarter Century Bonanza",
      "2002 Yu-Gi-Oh! Legend of Blue Eyes White Dragon",
      "1993 Magic The Gathering Beta",
      "2025 Magic The Gathering Aetherdrift",
      "2024 One Piece Two Legends",
    ]) {
      const r = slugs(n);
      expect(r.ok, `"${n}" still refused (sport=${r.sport} key=${r.key})`).toBe(true);
    }
  });

  it("never lets a TCG name reach the SPORTS vocabulary", () => {
    // CF-NO-CROSS-VERTICAL-FALLBACK, extended to the other verticals: Pokemon
    // names were matching Panini products before that fix. A miss here must
    // degrade to the clean name, never to a sports key.
    const key = resolveSetKeyForSlug("yugioh", "Some Set That Does Not Exist", 2024);
    expect(key).toBe("some-set-that-does-not-exist");
    for (const bad of ["panini-obsidian", "panini-zenith", "panini-origins", "leaf", "ultra", "topps"]) {
      expect(key).not.toBe(bad);
    }
  });

  it("leaves the sports vocabulary untouched", () => {
    expect(resolveSetKeyForSlug("baseball", "2024 Topps Chrome", 2024)).toBe("topps-chrome");
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm", 2024)).toBe("panini-prizm");
    expect(inferSportFromContext("2024 Topps Chrome Baseball", "", null)).toBe("baseball");
  });
});
