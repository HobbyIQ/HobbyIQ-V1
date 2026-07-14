// CF-CH-BRIDGE-VARIANT-GUARD (Drew, 2026-07-14, PR-B) — pins the guard
// that prevents CH's AI matcher from serving wrong-variant comps when the
// user-requested SKU isn't in CH's catalog.
//
// Real symptom (2026-07-14 investigation): Hartman CPA-EHA Blue Refractor
// Auto is a $1800 card. CH's catalog has 36 CPA-EHA variants but ZERO
// "Blue Refractor" among them. CH's AI matcher, asked for this card, will
// pin the nearest variant (CPA-EHA Refractor, Blue X-Fractor, or the
// BCP-102 Blue Refractor BASE card — all different sub-markets). Prior
// bridge code accepted the pin, so downstream comps came from the wrong
// SKU (~$420 price).
//
// Guard rules pinned here:
//   1. card_number mismatch → reject (BCP-102 answer to CPA-EHA ask)
//   2. parallel mismatch → reject (Refractor answer to Blue Refractor ask)
//   3. Normalization is case-insensitive + hyphen-collapsing
//   4. Empty identity fields short-circuit the check (no false rejects
//      when the user didn't specify a parallel or number)
//   5. Missing match fields also short-circuit (can't guard on what CH
//      didn't return)

import { describe, expect, it } from "vitest";
import {
  matchHonorsIdentity,
  normalizeParallelForVariantGuard,
} from "../src/services/compiq/cardsight.router.js";

describe("normalizeParallelForVariantGuard", () => {
  it("lowercases, collapses hyphens/underscores/slashes to spaces, trims", () => {
    expect(normalizeParallelForVariantGuard("Blue Refractor")).toBe("blue refractor");
    expect(normalizeParallelForVariantGuard("Blue-Refractor")).toBe("blue refractor");
    expect(normalizeParallelForVariantGuard("  Blue  Refractor  ")).toBe("blue refractor");
    expect(normalizeParallelForVariantGuard("X-Fractor/Auto")).toBe("x fractor auto");
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(normalizeParallelForVariantGuard(null)).toBe("");
    expect(normalizeParallelForVariantGuard(undefined)).toBe("");
    expect(normalizeParallelForVariantGuard("")).toBe("");
  });
});

describe("matchHonorsIdentity — the Hartman scenario", () => {
  it("REJECTS: user asked CPA-EHA Blue Refractor, CH matched CPA-EHA Refractor (parallel narrowing)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Refractor", number: "CPA-EHA" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parallel_mismatch");
      expect(result.wanted).toBe("blue refractor");
      expect(result.got).toBe("refractor");
    }
  });

  it("REJECTS: user asked CPA-EHA Blue Refractor, CH matched CPA-EHA Blue X-Fractor (parallel drift)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue X-Fractor", number: "CPA-EHA" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parallel_mismatch");
  });

  it("REJECTS: user asked CPA-EHA Blue Refractor, CH matched BCP-102 Blue Refractor (card_number leak)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue Refractor", number: "BCP-102" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("card_number_mismatch");
      expect(result.wanted).toBe("cpa-eha");
      expect(result.got).toBe("bcp-102");
    }
  });
});

describe("matchHonorsIdentity — accepts honest matches", () => {
  it("ACCEPTS: exact parallel + exact number", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Green Shimmer Refractor", number: "CPA-EHA" },
      { parallel: "Green Shimmer Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(true);
  });

  it("ACCEPTS: hyphen normalization survives (Blue-Refractor vs Blue Refractor)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue-Refractor", number: "CPA-EHA" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(true);
  });

  it("ACCEPTS: case difference survives", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "GREEN REFRACTOR", number: "CPA-EHA" },
      { parallel: "Green Refractor", number: "cpa-eha" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("matchHonorsIdentity — short-circuits", () => {
  it("null match → ok (nothing to guard)", () => {
    expect(matchHonorsIdentity(null, { parallel: "Blue Refractor" }).ok).toBe(true);
  });

  it("identity without parallel or number → ok (no signal to check)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Whatever", number: "CPA-EHA" },
      {},
    );
    expect(result.ok).toBe(true);
  });

  it("identity has parallel but match has no variant → ok (can't compare)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: null, number: "CPA-EHA" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(true);
  });

  it("identity has number but match has no number → ok", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue Refractor", number: null },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
    );
    expect(result.ok).toBe(true);
  });
});
