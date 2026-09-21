/**
 * CF-A-HAND-ROLLED-MIRROR-DRIFTS (2026-09-21, sale-side wrong-product sweep).
 *
 * backend/scripts/backfill-catalog-driven-canonicalize.cjs carried its own
 * hand-copied "short list" mirror of normalizeSetKey
 * (`normalizeSetToCanonical`), used both to read the card_catalog witness
 * and, critically, to re-normalize the sold_comps row's OWN `setName` as
 * the "two-witness" check before rewriting `hobbyiqCardId`. That mirror:
 *
 *   1. had no rule at all for "Topps 206" or "Bowman's Best" -- both fell
 *      to the bare brand catch-all (`topps` / `bowman`);
 *   2. explicitly collapsed "Bowman Chrome Draft" -> bowman-chrome and
 *      "Topps Chrome Update(-Series)" -> topps-chrome ("collapse subset"),
 *      contradicting the RULED keys normalizeSetKey has carried since D23/
 *      R26 (bowman-draft, topps-chrome-update-series are DISTINCT products);
 *   3. only matched SPACE-separated title text ("bowman chrome sapphire"),
 *      so any row whose `setName` had already been correctly resolved to a
 *      HYPHENATED canonical slug ("bowman-chrome-sapphire",
 *      "topps-chrome-black") read back as UNRECOGNIZED and was rewritten
 *      DOWN to its flagship ancestor by this same "fix" script.
 *
 * Live sold_comps rows sampled 2026-09-21 reproduce every one of these
 * (see the PR body for the real titles). The first fix replaced the mirror
 * with the one normalizeSetKey (+ isProductSetKey / reconciledFixedPoints)
 * the TS ingest path already uses.
 *
 * CF-A-BARE-NORMALIZESETKEY-IS-YEAR-BLIND (2026-09-21 follow-on). That first
 * fix reintroduced the SAME "diverges from the engine" defect class one
 * level up: a bare `normalizeSetKey(setName)` call skips every year/era-
 * dependent ruling `resolveSetKeyForSlug` applies on top of it -- the 2026
 * Bowman Mega Box split (R75) chief among them. A verifier proved
 * `normalizeSetToCanonical("2026 Bowman Mega Box Baseball")` answered
 * `bowman-chrome-mega-box` (the PRE-2026 key) instead of `bowman-mega`,
 * which would have had tonight's scheduled APPLY rewrite ~34k CORRECT 2026
 * sales back to the wrong pool. Fixed by threading year (+ sport) through
 * to `resolveSetKeyForSlug`, the same year-aware function
 * `computeHobbyIqCardId` itself calls -- no new hand-rolled era table.
 */
import * as path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);

// The script's own `main()` throws/exits if COSMOS_CONNECTION_STRING is
// unset -- guarded behind `require.main === module` in the script itself,
// so a plain `require()` here only evaluates the module body (module-load
// side effects: reading dist/ exports, building RECOGNIZED_SET_KEYS) and
// never calls `main()`.
let normalizeSetToCanonical: (setText: string, year?: number | string, sport?: string) => string | null;

beforeAll(() => {
  const mod = require_(path.resolve(__dirname, "../scripts/backfill-catalog-driven-canonicalize.cjs"));
  normalizeSetToCanonical = mod.normalizeSetToCanonical;
});

describe("backfill-catalog-driven-canonicalize: normalizeSetToCanonical", () => {
  // Defect 1: "2024 Topps 206 Baseball ..." -- topps-206 is a registered,
  // checklist-backed (11,445 rows) distinct key; the old mirror had no rule
  // for "206" at all and fell to the bare `/\btopps\b/` catch-all.
  it("resolves a real Topps 206 vendor setName to topps-206, not bare topps", () => {
    expect(normalizeSetToCanonical("2024 Topps 206 Baseball")).toBe("topps-206");
  });

  // Defect 2: "2025 Bowman's Best Baseball ..." -- bowmans-best is registered
  // in PRODUCT_SET_KEYS; the old mirror had no rule for "best" at all.
  it("resolves a real Bowman's Best vendor setName to bowmans-best, not bare bowman", () => {
    expect(normalizeSetToCanonical("2025 Bowman's Best Baseball")).toBe("bowmans-best");
  });

  // Defect 3: the two-witness check re-normalizes the row's OWN setName,
  // which on a tca-ebay row already IS the canonical hyphenated slug. The
  // old space-only regexes never matched a hyphenated string.
  it("round-trips an already-canonical bowman-chrome-sapphire slug (hyphenated witness)", () => {
    expect(normalizeSetToCanonical("bowman-chrome-sapphire")).toBe("bowman-chrome-sapphire");
  });
  it("resolves a title-style Bowman Chrome Sapphire vendor setName to bowman-chrome-sapphire", () => {
    expect(normalizeSetToCanonical("2025 Bowman Chrome Sapphire Baseball")).toBe("bowman-chrome-sapphire");
  });
  it("resolves bare Bowman Sapphire (no 'Chrome') to bowman-chrome-sapphire", () => {
    expect(normalizeSetToCanonical("2025 Bowman Sapphire Baseball")).toBe("bowman-chrome-sapphire");
  });

  // Defect 4: "Bowman Chrome Draft" / "Bowman Draft Chrome" is bowman-draft
  // (a checklist-backed product with 336,463 rows), not a bowman-chrome
  // subset. The old mirror's line 92 explicitly collapsed it the wrong way.
  it("resolves Bowman Chrome Draft to bowman-draft, not bowman-chrome", () => {
    expect(normalizeSetToCanonical("2025 Bowman Chrome Draft Baseball")).toBe("bowman-draft");
  });
  it("round-trips an already-canonical bowman-draft-chrome slug to bowman-draft", () => {
    expect(normalizeSetToCanonical("bowman-draft-chrome")).toBe("bowman-draft");
  });

  // Defect 5a: Topps Chrome Update Series is a DISTINCT ruled key (D23),
  // not a topps-chrome subset. The old mirror's line 105 explicitly
  // collapsed it.
  it("resolves Topps Chrome Update Series to topps-chrome-update-series, not bare topps-chrome", () => {
    expect(normalizeSetToCanonical("2025 Topps Chrome Update Series Baseball")).toBe("topps-chrome-update-series");
  });
  it("round-trips an already-canonical topps-chrome-update-series slug", () => {
    expect(normalizeSetToCanonical("topps-chrome-update-series")).toBe("topps-chrome-update-series");
  });

  // Defect 5b: Topps Chrome Black is a DISTINCT ruled key (R26). The
  // title-style form matched the old mirror correctly; only the
  // already-hyphenated slug witness broke.
  it("resolves Topps Chrome Black title text to topps-chrome-black", () => {
    expect(normalizeSetToCanonical("2026 Topps Chrome Black Baseball")).toBe("topps-chrome-black");
  });
  it("round-trips an already-canonical topps-chrome-black slug (was the live regression)", () => {
    expect(normalizeSetToCanonical("topps-chrome-black")).toBe("topps-chrome-black");
  });

  // Safety net preserved: an unrecognized string must still yield null so
  // the two-witness check treats it as "no opinion" rather than a
  // confident witness for some invented key.
  it("still returns null for unrecognized text (preserves the skip-on-miss contract)", () => {
    expect(normalizeSetToCanonical("Some Completely Unrelated Sticker Pack Text")).toBeNull();
  });
  it("still returns null for empty/blank input", () => {
    expect(normalizeSetToCanonical("")).toBeNull();
    expect(normalizeSetToCanonical("   ")).toBeNull();
  });

  // MUTATION CHECK (manual, see PR body): reverting the fix to the old
  // hand-rolled regex list makes every test above except the null-safety
  // ones fail, proving each assertion is load-bearing against the specific
  // regression rather than trivially true.
});

describe("backfill-catalog-driven-canonicalize: normalizeSetToCanonical is year-aware", () => {
  // THE LIVE REGRESSION a verifier caught before tonight's 03:00 UTC APPLY:
  // a bare "2026 Bowman Mega Box" text names the plain (non-Chrome) 2026
  // release -- R75, BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR -- and must resolve to
  // `bowman-mega`, NOT the pre-2026 `bowman-chrome-mega-box` fold. Without a
  // year this function could not have told 2026 from 2025 at all.
  it("2026 bare 'Bowman Mega Box' text resolves to bowman-mega, not bowman-chrome-mega-box", () => {
    expect(normalizeSetToCanonical("2026 Bowman Mega Box Baseball", 2026, "baseball")).toBe("bowman-mega");
  });
  // The SAME bare text in 2025 (pre-split) is still the year-agnostic fold
  // -- "Mega Box" and "Chrome Mega Box" name ONE product before 2026.
  it("2025 bare 'Bowman Mega Box' text still resolves to bowman-chrome-mega-box (pre-split)", () => {
    expect(normalizeSetToCanonical("2025 Bowman Mega Box Baseball", 2025, "baseball")).toBe("bowman-chrome-mega-box");
  });
  // A title that SAYS "Chrome" is left alone in every year -- the split only
  // ever redirects the BARE spelling.
  it("2026 'Bowman Chrome Mega Box' (states Chrome) still resolves to bowman-chrome-mega-box", () => {
    expect(normalizeSetToCanonical("2026 Bowman Chrome Mega Box Baseball", 2026, "baseball")).toBe("bowman-chrome-mega-box");
  });
  // Both witnesses this script actually reads may already be the canonical
  // hyphenated slug (from an earlier correct resolution) rather than title
  // text -- the round-trip must hold with a year in hand on both sides of
  // the split.
  it("round-trips an already-canonical bowman-mega slug for 2026", () => {
    expect(normalizeSetToCanonical("bowman-mega", 2026, "baseball")).toBe("bowman-mega");
  });
  it("round-trips an already-canonical bowman-chrome-mega-box slug for 2025", () => {
    expect(normalizeSetToCanonical("bowman-chrome-mega-box", 2025, "baseball")).toBe("bowman-chrome-mega-box");
  });

  // A second, independently-ruled era boundary reached through the SAME
  // resolveSetKeyForSlug call (spellForEra -> PANINI_DONRUSS_FROM_YEAR):
  // Panini did not acquire Donruss until 2009, so a bare "Donruss" card
  // must not be stamped panini-donruss before that year, and must be after.
  it("1987 Donruss stays donruss (pre-Panini-acquisition)", () => {
    expect(normalizeSetToCanonical("1987 Donruss Baseball", 1987, "baseball")).toBe("donruss");
  });
  it("2020 Donruss resolves to panini-donruss (post-acquisition)", () => {
    expect(normalizeSetToCanonical("2020 Donruss Baseball", 2020, "baseball")).toBe("panini-donruss");
  });

  // AUDIT (coordinator request): every OTHER year/era-dependent rule
  // spellForEra applies, reached the same way through resolveSetKeyForSlug.
  // None of these were reachable through the bare normalizeSetKey call the
  // first fix (#2390) used either -- this fix restores all of them, not
  // just the Mega Box case that triggered it.
  it("era: pre-1996 'Fleer Tiffany' is a misnomer for the glossy product (fleer-glossy)", () => {
    expect(normalizeSetToCanonical("1990 Fleer Tiffany Baseball", 1990, "baseball")).toBe("fleer-glossy");
  });
  it("era: 1996+ 'Fleer Tiffany' is the real, separately checklist-backed product", () => {
    expect(normalizeSetToCanonical("2000 Fleer Tiffany Baseball", 2000, "baseball")).toBe("fleer-tiffany");
  });
  it("era: pre-2000 'Skybox Metal Universe' is a misnomer for vintage metal-universe", () => {
    expect(normalizeSetToCanonical("1997 Skybox Metal Universe Baseball", 1997, "baseball")).toBe("metal-universe");
  });
  it("era: 2000+ 'Skybox Metal Universe' is the real 2020s revival product", () => {
    expect(normalizeSetToCanonical("2021 Skybox Metal Universe Baseball", 2021, "baseball")).toBe("skybox-metal-universe");
  });
  it("era: 2006 'Greats of the Game' is Fleer's (fleer-greats-of-the-game)", () => {
    expect(normalizeSetToCanonical("2006 Greats of the Game Baseball", 2006, "baseball")).toBe("fleer-greats-of-the-game");
  });
  // Never-acquired maker prefixes fire in EVERY year (no boundary to sit
  // on) -- "Panini Score" names a product Panini never made; the real
  // maker is bare `score`. Confirmed live: this is the one unexpected-
  // looking transition the >=2,000-row diff surfaced, and it is this rule,
  // not a defect.
  it("maker: 'Panini Score' always resolves to score (Panini never acquired Score)", () => {
    expect(normalizeSetToCanonical("2022 Panini Score Baseball", 2022, "baseball")).toBe("score");
  });

  // NO YEAR: every era correction inside resolveSetKeyForSlug explicitly
  // refuses to fire without a usable year and returns the bare (pre-era)
  // key unchanged -- so omitting year/sport must behave EXACTLY as a plain
  // normalizeSetKey call would (this function's behaviour before this
  // year-aware fix), never a guessed era. Documented here as the answer to
  // "what does a row with no year do": it is not skipped by this function
  // (it still returns a value), but that value carries no era correction,
  // exactly matching a caller that has no cardYear to pass.
  it("no year: behaves exactly like the year-agnostic normalizeSetKey (2026 Mega Box text)", () => {
    expect(normalizeSetToCanonical("2026 Bowman Mega Box Baseball")).toBe("bowman-chrome-mega-box");
  });
  it("no year: Donruss falls to the post-acquisition spelling normalizeSetKey alone would give", () => {
    expect(normalizeSetToCanonical("1987 Donruss Baseball")).toBe("panini-donruss");
  });

  // The five original defect classes (PR #2390) still resolve correctly
  // with a year now threaded through -- the year-aware path must not
  // regress the fix that shipped ahead of this one.
  it("still resolves Topps 206 correctly with a year passed", () => {
    expect(normalizeSetToCanonical("2024 Topps 206 Baseball", 2024, "baseball")).toBe("topps-206");
  });
  it("still resolves Bowman's Best correctly with a year passed", () => {
    expect(normalizeSetToCanonical("2025 Bowman's Best Baseball", 2025, "baseball")).toBe("bowmans-best");
  });
  it("still round-trips the bowman-chrome-sapphire slug with a year passed", () => {
    expect(normalizeSetToCanonical("bowman-chrome-sapphire", 2025, "baseball")).toBe("bowman-chrome-sapphire");
  });
  it("still resolves Bowman Chrome Draft to bowman-draft with a year passed", () => {
    expect(normalizeSetToCanonical("2025 Bowman Chrome Draft Baseball", 2025, "baseball")).toBe("bowman-draft");
  });
  it("still resolves Topps Chrome Update Series with a year passed", () => {
    expect(normalizeSetToCanonical("2025 Topps Chrome Update Series Baseball", 2025, "baseball")).toBe("topps-chrome-update-series");
  });

  // Safety net still holds with year/sport in the call.
  it("still returns null for unrecognized text even with a year passed", () => {
    expect(normalizeSetToCanonical("Some Completely Unrelated Sticker Pack Text", 2026, "baseball")).toBeNull();
  });

  // MUTATION CHECK (manual, see PR body): reverting to a bare
  // normalizeSetKey call (no year threaded) makes the 2026 Mega Box and
  // era-boundary assertions above fail while leaving the five original
  // defect-class tests green -- proving these assertions are specifically
  // pinned against the year-blindness regression, not a re-test of #2390.
});
