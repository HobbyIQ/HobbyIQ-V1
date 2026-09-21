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
 * (see the PR body for the real titles). The fix replaces the mirror with
 * the one normalizeSetKey (+ isProductSetKey / reconciledFixedPoints) the
 * TS ingest path already uses, so this lane cannot drift from the ruled
 * vocabulary again.
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
let normalizeSetToCanonical: (setText: string) => string | null;

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
