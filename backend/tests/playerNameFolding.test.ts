// CF-PLAYER-NAME-FOLDING (Drew, 2026-08-12).
//
// The catalog stores display names with diacritics and punctuation
// ("Ronald Acuña, Jr."). Users type ASCII ("Acuna"). Cosmos CONTAINS and `=`
// are byte-exact, so those rows were unreachable — 5.5% of a 1,595-row sample
// of base cards, concentrated in the players who trade most.
//
// resolveSetKey.service carried a local slug() that stripped [^a-z0-9] with NO
// Unicode normalization, so it MANGLED rather than folded: ñ became a hyphen,
// turning "Ronald Acuña, Jr." into ronald-acu-a-jr while the same person typed
// as "Ronald Acuna Jr" produced ronald-acuna-jr. Those never matched.
//
// This is pinned because the failure is invisible: a folding miss returns zero
// rows, and zero rows is indistinguishable from "no such card" — the same
// failure family as the checklistNarrow bug (#999) and the catalogVerify
// playerSlug gap.

import { describe, it, expect } from "vitest";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service";

// Real names taken from card_catalog rows on 2026-08-12, paired with what a
// user actually types into search.
const REAL_PAIRS: Array<[catalogName: string, typed: string]> = [
  ["Ronald Acuña, Jr.", "Ronald Acuna Jr"],
  ["José Ramírez", "Jose Ramirez"],
  ["Jeremy Peña", "Jeremy Pena"],
  ["Javier Báez", "Javier Baez"],
  ["Teoscar Hernández", "Teoscar Hernandez"],
  ["Eloy Jiménez", "Eloy Jimenez"],
  ["Avisaíl García", "Avisail Garcia"],
  ["Ezequiel Durán", "Ezequiel Duran"],
  ["Jerar Encarnación", "Jerar Encarnacion"],
  ["Ramón Laureano", "Ramon Laureano"],
  ["Eury Pérez", "Eury Perez"],
];

describe("accented catalog names fold to what users type", () => {
  it.each(REAL_PAIRS)("%s === %s", (catalogName, typed) => {
    expect(slugify(catalogName)).toBe(slugify(typed));
  });

  it("produces clean ASCII slugs with no stray hyphens from stripped marks", () => {
    // The old mangling signature: a hyphen where the accented letter was.
    for (const [catalogName] of REAL_PAIRS) {
      const s = slugify(catalogName);
      expect(s, catalogName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s, catalogName).not.toMatch(/--/);
    }
  });

  it("folds the exact names the pricing lookup resolved wrongly", () => {
    // "2023 Topps Chrome Acuna Base" silently resolved to topps-chrome-sapphire
    // because his flagship row (#39, "Ronald Acuña, Jr.") was unmatchable.
    expect(slugify("Ronald Acuña, Jr.")).toBe("ronald-acuna-jr");
    expect(slugify("José Ramírez")).toBe("jose-ramirez");
  });

  it("drops punctuation so 'Acuña, Jr.' and 'Acuna Jr' agree", () => {
    expect(slugify("Ronald Acuna, Jr.")).toBe(slugify("Ronald Acuna Jr"));
    expect(slugify("A.J. Preller")).toBe(slugify("AJ Preller"));
  });

  it("keeps distinct players distinct", () => {
    // Folding must not collapse different people into one slug.
    expect(slugify("José Ramírez")).not.toBe(slugify("Jose Ramos"));
    expect(slugify("Ronald Acuña, Jr.")).not.toBe(slugify("Ronald Acuna Sr"));
  });

  it("is idempotent — folding an already-folded slug is a no-op", () => {
    // The backfill re-runs; a second pass must not rewrite what it wrote.
    for (const [catalogName] of REAL_PAIRS) {
      const once = slugify(catalogName);
      expect(slugify(once)).toBe(once);
    }
  });

  it("handles empty and junk input without throwing", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("---")).toBe("");
  });
});

describe("resolveSetKey uses the canonical folding", () => {
  it("no longer carries a local slug that mangles accents", async () => {
    // Guards the regression at its source: a second, subtly different slug
    // implementation in this file is what broke player narrowing.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(
      resolve(__dirname, "..", "src/services/catalog/resolveSetKey.service.ts"), "utf8");

    // Any local slug definition must not strip [^a-z0-9] without normalizing.
    const localSlugBody = src.match(/function slug\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (localSlugBody) {
      expect(localSlugBody[0], "local slug() must NFKD/NFD-normalize before stripping")
        .toMatch(/normalize\(/);
    }
    expect(src).toMatch(/slugify/);
  });
});
