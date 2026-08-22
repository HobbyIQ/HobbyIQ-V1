/**
 * CF-IMPLIED-REFRACTOR-EQUIVALENCE (2026-08-22).
 *
 * canonicalize() validates an adopted match by comparing the parallel it asked
 * for against the parallel in the slug it got back. That check used
 * sameParallelTokens, which is exact — so it threw away correct matches AFTER
 * finding them:
 *
 *   askedParallel "Yellow"  ->  hiq:baseball:2026:topps-chrome:ra-kg:yellow-refractor:auto
 *   matchedBy "exact", confidence 0.98  ->  REJECTED, matchedBy "not-found"
 *
 * Konnor Griffin, $535.36 paid, left with no identity and therefore no price.
 * Measured 2026-08-22: 17 of 18 unidentified holdings failed to re-match, at
 * least two of them after a successful exact match.
 *
 * The strictness must SURVIVE in the direction it was written for. Its own
 * comment: a sale saying only "Refractor" is not evidence of a Green
 * Refractor, and treating it as such is how a plain Refractor became a
 * common-green-refractor /75. These tests pin both directions, because a
 * relaxation that also permits the bad direction is worse than no fix.
 */
import { describe, it, expect } from "vitest";
import {
  parallelTokenSet,
  parallelsEquivalentForAdoption,
} from "../src/services/catalog/catalogMatcher.service.js";

const T = (slug: string) => parallelTokenSet(slug);

describe("parallelsEquivalentForAdoption — the relaxation", () => {
  it("accepts the Konnor Griffin case: Yellow == Yellow Refractor", () => {
    expect(parallelsEquivalentForAdoption(T("yellow-refractor"), T("yellow"))).toBe(true);
  });

  it("is symmetric", () => {
    expect(parallelsEquivalentForAdoption(T("yellow"), T("yellow-refractor"))).toBe(true);
  });

  it("accepts other colours the pricing path already treats as one parallel", () => {
    for (const c of ["blue", "gold", "orange", "green", "purple", "black"]) {
      expect(parallelsEquivalentForAdoption(T(`${c}-refractor`), T(c))).toBe(true);
    }
  });

  it("accepts multi-token qualifiers that differ only by refractor", () => {
    expect(parallelsEquivalentForAdoption(T("gold-wave-refractor"), T("gold-wave"))).toBe(true);
  });

  it("still accepts genuinely identical parallels", () => {
    expect(parallelsEquivalentForAdoption(T("blue-refractor"), T("blue-refractor"))).toBe(true);
    expect(parallelsEquivalentForAdoption(T("base"), T("base"))).toBe(true);
    expect(parallelsEquivalentForAdoption(T(""), T("base"))).toBe(true);
  });
});

describe("parallelsEquivalentForAdoption — the strictness that must survive", () => {
  it("REJECTS bare Refractor against a coloured refractor (the /75 bug)", () => {
    expect(parallelsEquivalentForAdoption(T("green-refractor"), T("refractor"))).toBe(false);
    expect(parallelsEquivalentForAdoption(T("refractor"), T("green-refractor"))).toBe(false);
  });

  it("REJECTS base against a refractor", () => {
    expect(parallelsEquivalentForAdoption(T("refractor"), T("base"))).toBe(false);
    expect(parallelsEquivalentForAdoption(T("base"), T("refractor"))).toBe(false);
  });

  it("REJECTS base against a coloured refractor", () => {
    expect(parallelsEquivalentForAdoption(T("gold-refractor"), T("base"))).toBe(false);
  });

  it("REJECTS two different colours", () => {
    expect(parallelsEquivalentForAdoption(T("blue"), T("gold-refractor"))).toBe(false);
    expect(parallelsEquivalentForAdoption(T("blue-refractor"), T("gold-refractor"))).toBe(false);
  });

  it("REJECTS a strict subset that is not just the refractor token", () => {
    // "gold" is not evidence of "gold mini diamond"
    expect(parallelsEquivalentForAdoption(T("gold-mini-diamond-refractor"), T("gold"))).toBe(false);
  });

  it("REJECTS an extra qualifier even when both carry refractor", () => {
    expect(parallelsEquivalentForAdoption(T("gold-lava-refractor"), T("gold-refractor"))).toBe(false);
  });
});

/**
 * The two internal guards are unreachable through parallelTokenSet, which never
 * returns an empty set — it collapses empties to {base}, so sameParallelTokens
 * already rejects those pairs on size mismatch. A mutation run proved it:
 * deleting either guard left the suite green.
 *
 * They are not dead code, because parallelsEquivalentForAdoption is exported
 * and a future caller can hand it raw sets. So exercise them directly rather
 * than shipping branches nothing can falsify.
 */
describe("parallelsEquivalentForAdoption — guards, driven with raw sets", () => {
  it("REJECTS a bare refractor against an empty set rather than calling them equal", () => {
    // Both reduce to {} once "refractor" is removed. Without the empty-side
    // guard this returns TRUE and a plain Refractor becomes an unparalleled card.
    expect(parallelsEquivalentForAdoption(new Set(["refractor"]), new Set())).toBe(false);
    expect(parallelsEquivalentForAdoption(new Set(), new Set(["refractor"]))).toBe(false);
  });

  it("REJECTS base against base-plus-refractor", () => {
    // Both reduce to {base}. Without the base guard this returns TRUE, which
    // would let an explicit Base adopt a Refractor's identity.
    expect(parallelsEquivalentForAdoption(new Set(["base"]), new Set(["base", "refractor"]))).toBe(false);
    expect(parallelsEquivalentForAdoption(new Set(["base", "refractor"]), new Set(["base"]))).toBe(false);
  });
});
