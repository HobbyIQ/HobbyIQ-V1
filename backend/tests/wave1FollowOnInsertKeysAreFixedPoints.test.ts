// Wave-1 follow-on registration (Drew, ruling round of 2026-09-19). Follows
// the same method as #2276 (Zenith) and #2342 (Illusions/Mosaic): a named
// insert/auto set with its own roster is its own card set (its own key); a
// colour/finish rung that REPRINTS a root's roster is a PARALLEL and never
// gets a key, whatever word the source spells it with.
//
// 85 keys registered across four products (23 Prizm FB + 19 Prizm BK, with 4
// shared names deduped to 38 unique panini-prizm-* keys + 16 Donruss FB + 27
// Select BK). See productSetKeys.ts's own registration comment for the full
// per-key row counts, numbering, and the roster-overlap checks run against
// every same-root-word sibling on each file.
import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const PRIZM_FB_ONLY = [
  "prizmatic", "hype", "rookie-patch-autographs-prizm-silver",
  "franchise-legends-signatures", "portals", "prizm-break",
  "all-purpose-prizms-silver", "flashback-autographs", "premier-jerseys",
  "rookie-gear", "lockdown-prizms-silver", "significant-signatures",
  "color-blast", "prizm-flashback-prizms-silver", "aurora", "profiles",
  "manga-horizontal", "manga-vertical", "rookie-variations-prizms-silver",
];

const PRIZM_SHARED_FB_BK = ["fireworks", "sensational-signatures", "emergent", "prizmania"];

const PRIZM_BK_ONLY = [
  "signatures", "kaleidoscopic", "fast-break-autographs", "talismen",
  "dominance", "instant-impact", "fast-break-rookie-autographs",
  "penmanship", "luck-of-the-lottery", "fractal", "deep-space",
  "global-reach", "groovy", "sublime", "manga",
];

const DONRUSS_FB_GENUINE = [
  "rated-rookies-throwback", "unleashed", "bomb-squad", "galaxy-of-stars",
  "best-of-instant", "retro-1994", "retro-2004",
  "rated-rookies-throwback-autographs", "retro-2004-autographs",
  "retro-1994-autographs", "1-per-costco-bundle", "rated-rookies-retro",
  "bomb-squad-autographs", "rated-rookies-retro-autographs",
  "best-of-instant-autographs", "red-hot-rookies-autographs",
];

// Deliberately NOT registered — 100% roster match against Base's own Rated
// Rookies subset (#301-400), on-card autograph PARALLELS, not real sets.
const DONRUSS_FB_FOLD_CANDIDATES = [
  "rated-rookies-autographs", "optic-rated-rookies-preview-autographs",
];

const SELECT_BK_GENUINE = [
  "rookie-jersey-autographs", "signature-selections", "in-flight-signatures",
  "youth-explosion-signatures", "neon-icon", "rookie-revolution",
  "jumbo-rookie-swatches", "autographed-memorabilia", "clutch",
  "select-certified", "throwback-memorabilia", "selection-committee-signatures",
  "sky-high", "hot-stars", "lodestars", "en-fuego",
  "select-pairings-signatures", "top-shelf-signatures", "select-few-signatures",
  "x-factor-memorabilia-signatures", "sparks-relics",
  "select-stars-jersey-autographs", "2024-origins-update-autographs",
  "solar-eclipse", "artistic-selections", "crown-jewels",
  "2024-hoops-update-autographs",
];

const PRIZM_ALL_UNIQUE = [...PRIZM_FB_ONLY, ...PRIZM_SHARED_FB_BK, ...PRIZM_BK_ONLY];

describe("2024 Panini Prizm Football + 2024-25 Panini Prizm Basketball — 38 unique keys under shared panini-prizm parent", () => {
  it("registers every FB-only, BK-only, and FB/BK-shared key exactly once — 38 unique subs total", () => {
    expect(new Set(PRIZM_ALL_UNIQUE).size).toBe(PRIZM_ALL_UNIQUE.length); // no duplicates in this test's own lists
    expect(PRIZM_ALL_UNIQUE.length).toBe(38);
    const missing = PRIZM_ALL_UNIQUE.filter((sub) => !isProductSetKey(`panini-prizm-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = PRIZM_ALL_UNIQUE
      .map((sub) => `panini-prizm-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-prizm", () => {
    for (const sub of PRIZM_ALL_UNIQUE) {
      const key = `panini-prizm-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-prizm`).toBe("panini-prizm");
    }
  });

  it("does NOT register the 18-category Rookie Autographs Prizm <colour> cluster — a 100% base-roster PARALLEL, not a set", () => {
    // Verified directly against the live CSV (see productSetKeys.ts's own
    // comment): all eighteen colour spellings are number-for-number,
    // player-for-player identical to Base's own Rookies subset (#301-400).
    // The module's own colour-strip fold already resolves them to root
    // `rookie-autographs-prizm`, which must keep normalizing to bare
    // `panini-prizm`, never to a registered subset key.
    expect(isProductSetKey("panini-prizm-rookie-autographs-prizm")).toBe(false);
    expect(normalizeSetKey("panini-prizm-rookie-autographs-prizm")).toBe("panini-prizm");
  });

  it("Rookie Patch Autographs Prizm Silver and Rookie Variations Prizms Silver stay separate keys — zero roster overlap despite sharing 1-42 numbering", () => {
    expect(isProductSetKey("panini-prizm-rookie-patch-autographs-prizm-silver")).toBe(true);
    expect(isProductSetKey("panini-prizm-rookie-variations-prizms-silver")).toBe(true);
  });

  it("Fast Break Rookie Autographs and Fast Break Autographs stay separate keys — 0% roster overlap, not a fold", () => {
    expect(isProductSetKey("panini-prizm-fast-break-rookie-autographs")).toBe(true);
    expect(isProductSetKey("panini-prizm-fast-break-autographs")).toBe(true);
  });

  it("Kaleidoscopic is registered as an INSERT for this product/year — never appears as a base parallel value in this file", () => {
    expect(isProductSetKey("panini-prizm-kaleidoscopic")).toBe(true);
    expect(normalizeSetKey("panini-prizm-kaleidoscopic")).toBe("panini-prizm-kaleidoscopic");
  });
});

describe("2024 Panini Donruss Football, full workbook — 16 genuine keys registered, 2 fold-candidates deliberately withheld", () => {
  it("registers all 16 genuine keys", () => {
    const missing = DONRUSS_FB_GENUINE.filter((sub) => !isProductSetKey(`panini-donruss-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every genuine key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = DONRUSS_FB_GENUINE
      .map((sub) => `panini-donruss-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-donruss", () => {
    for (const sub of DONRUSS_FB_GENUINE) {
      const key = `panini-donruss-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-donruss`).toBe("panini-donruss");
    }
  });

  it("does NOT register the 2 fold-candidates — both are a 100% base-Rated-Rookies roster match", () => {
    for (const sub of DONRUSS_FB_FOLD_CANDIDATES) {
      expect(isProductSetKey(`panini-donruss-${sub}`), `${sub} must stay unregistered`).toBe(false);
    }
  });

  it("each -autographs sibling is a signed SUBSET of its own plain insert, not folded into it", () => {
    // retro-1994 / retro-1994-autographs, retro-2004 / retro-2004-autographs,
    // bomb-squad / bomb-squad-autographs, best-of-instant / ...-autographs,
    // rated-rookies-retro / ...-autographs, rated-rookies-throwback / ...
    // -autographs: six pairs, each registered as two DISTINCT keys (verified
    // against the live CSV: every "-autographs" sibling's roster is a 100%
    // subset of its plain sibling's own roster, never of base).
    const pairs: Array<[string, string]> = [
      ["retro-1994", "retro-1994-autographs"],
      ["retro-2004", "retro-2004-autographs"],
      ["bomb-squad", "bomb-squad-autographs"],
      ["best-of-instant", "best-of-instant-autographs"],
      ["rated-rookies-retro", "rated-rookies-retro-autographs"],
      ["rated-rookies-throwback", "rated-rookies-throwback-autographs"],
    ];
    for (const [plain, signed] of pairs) {
      expect(isProductSetKey(`panini-donruss-${plain}`), plain).toBe(true);
      expect(isProductSetKey(`panini-donruss-${signed}`), signed).toBe(true);
      expect(plain).not.toBe(signed);
    }
  });

  it("red-hot-rookies-autographs completes the ALREADY-registered red-hot-rookies pair (R38, #2157)", () => {
    expect(isProductSetKey("panini-donruss-red-hot-rookies")).toBe(true);
    expect(isProductSetKey("panini-donruss-red-hot-rookies-autographs")).toBe(true);
  });

  it("does not touch the pre-existing R38/Zenith-era Donruss registrations", () => {
    for (const sub of ["rookie-revolution", "vortex", "production-line", "dominators", "the-elite-series"]) {
      expect(isProductSetKey(`panini-donruss-${sub}`), sub).toBe(true);
    }
  });
});

describe("2024 Panini Select Basketball — 27 genuine keys registered", () => {
  it("registers all 27", () => {
    expect(SELECT_BK_GENUINE.length).toBe(27);
    const missing = SELECT_BK_GENUINE.filter((sub) => !isProductSetKey(`panini-select-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = SELECT_BK_GENUINE
      .map((sub) => `panini-select-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-select", () => {
    for (const sub of SELECT_BK_GENUINE) {
      const key = `panini-select-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-select`).toBe("panini-select");
    }
  });

  it("sparks-relics is its own key, NOT a rung of the already-registered panini-select-sparks", () => {
    // This file has no bare "Sparks" section at all (0 rows) — "Sparks" on
    // panini-select-sparks belongs to a different Select release entirely.
    expect(isProductSetKey("panini-select-sparks")).toBe(true);
    expect(isProductSetKey("panini-select-sparks-relics")).toBe(true);
    expect(normalizeSetKey("panini-select-sparks-relics")).toBe("panini-select-sparks-relics");
  });

  it("does not touch the pre-existing Select registrations", () => {
    for (const sub of ["sparks", "select-certified-rookies", "mezzanine-level", "courtside"]) {
      expect(isProductSetKey(`panini-select-${sub}`), sub).toBe(true);
    }
  });
});
