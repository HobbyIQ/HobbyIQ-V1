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

// CF-VARIANT-GUARD-SUPERSET (Drew, 2026-07-15) — the parser under-
// specification rescue. When our parser strips tokens (Reptilian,
// Speckle, etc.) leaving identity.parallel as a proper SUBSTRING of
// CH's returned variant, and the user's raw query has the missing
// tokens, we ACCEPT the superset match. Without this, ~4 real CH-
// catalog cards silently fail to bridge every time Drew tries to
// price them.
describe("matchHonorsIdentity — CF-VARIANT-GUARD-SUPERSET (query-aware acceptance)", () => {
  it("accepts CH's more-specific parallel when raw query has the extra tokens", () => {
    // Parser stripped "Reptilian" → identity="Refractor". CH returned
    // "Reptilian Refractor" (correct SKU). Query text has "reptilian".
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Reptilian Refractor", number: "BCP-102" },
      { parallel: "Refractor", number: "BCP-102" },
      "Eric Hartman 2026 Bowman Chrome Reptilian Refractor",
    );
    expect(result.ok).toBe(true);
  });

  it("STILL rejects superset match when extra tokens are NOT in the query", () => {
    // identity="Refractor", CH matched "Reptilian Refractor", but user's
    // query only says "Refractor" — parser wasn't wrong, CH is offering
    // a different SKU. Reject (correct wrong-variant protection).
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Reptilian Refractor", number: "BCP-102" },
      { parallel: "Refractor", number: "BCP-102" },
      "2026 Bowman Chrome Refractor Hartman",  // no "reptilian"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parallel_mismatch");
  });

  it("accepts multi-token superset when ALL extras are in the query", () => {
    // identity="Refractor", match="Blue Speckle Refractor" — two extras
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue Speckle Refractor", number: "CPA-OC" },
      { parallel: "Refractor", number: "CPA-OC" },
      "Owen Carey Bowman Chrome Blue Speckle Refractor Auto",
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS when even ONE extra token is missing from query", () => {
    // identity="Refractor", match="Blue Speckle Refractor" — query has
    // "blue" but NOT "speckle". Reject — CH's Speckle variant is not
    // corroborated.
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Blue Speckle Refractor", number: "CPA-OC" },
      { parallel: "Refractor", number: "CPA-OC" },
      "Owen Carey Bowman Chrome Blue Refractor Auto",  // no "speckle"
    );
    expect(result.ok).toBe(false);
  });

  it("existing narrowing case (Blue Refractor request → Refractor match) STILL rejected", () => {
    // Original guard behavior — user MORE specific than CH's match.
    // Not a superset case, not helped by query check. Still reject.
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Refractor", number: "CPA-EHA" },
      { parallel: "Blue Refractor", number: "CPA-EHA" },
      "Eric Hartman Blue Refractor Auto",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parallel_mismatch");
  });

  it("card number superset: accepts when CH's number appears in query", () => {
    // Parser bug: put "X-FRACTOR" (a parallel) as identity.number.
    // CH returned real cardNumber "CPA-OC". Query text has "CPA-OC".
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "X-Fractor", number: "CPA-OC" },
      { parallel: "X-Fractor", number: "X-FRACTOR" },  // parser bug
      "Owen Carey Bowman Chrome X-Fractor Auto CPA-OC",
    );
    expect(result.ok).toBe(true);
  });

  it("no rawQuery passed → falls back to strict equality (backward-compat)", () => {
    // Old behavior when caller doesn't thread rawQuery.
    const result = matchHonorsIdentity(
      { card_id: "ch-xyz", variant: "Reptilian Refractor", number: "BCP-102" },
      { parallel: "Refractor", number: "BCP-102" },
      // no third arg
    );
    expect(result.ok).toBe(false);
  });
});

// CF-AUTO-VARIANT-GUARD (Drew, 2026-07-15) — user asked for AUTOGRAPH
// but CH's AI matcher resolves to BASE card. Existing parallel/number
// guards had nothing to reject with when identity.parallel was null.
// Live symptom: Bobby Witt Jr 2020 Bowman Chrome Auto → engine returned
// $9 from base card sibling pool (real card is $1,000+).
describe("matchHonorsIdentity — CF-AUTO-VARIANT-GUARD (auto vs base)", () => {
  it("rejects base-card match when user asked for auto", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-base", variant: "Base", number: "BCP-42", title: "Bobby Witt Jr 2020 Bowman Chrome" },
      { isAuto: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("auto_vs_base_mismatch");
  });

  it("accepts when auto is in match.variant", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-auto", variant: "Blue Refractor Auto", number: "CPA-EHA" },
      { isAuto: true },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts when auto card number prefix matches (CPA / BCPA / BDPA / etc.)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-cpa", variant: "Refractor", number: "CPA-EHA" },
      { isAuto: true },
    );
    expect(result.ok).toBe(true);  // CPA- prefix signals autograph
  });

  it("accepts when 'autograph' appears in match.title", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-auto", variant: "Refractor", number: "SC-42", title: "Player Name 2024 Set Autograph Refractor" },
      { isAuto: true },
    );
    expect(result.ok).toBe(true);
  });

  it("no-ops when identity.isAuto is false or unset (backward-compat)", () => {
    const result = matchHonorsIdentity(
      { card_id: "ch-base", variant: "Base", number: "BCP-42" },
      { /* no isAuto */ },
    );
    expect(result.ok).toBe(true);
  });

  it("Bobby Witt Jr scenario: base card rejected", () => {
    const result = matchHonorsIdentity(
      { card_id: "1684548880418x167621040739864400", variant: null, number: "BCP-90", title: "Bobby Witt Jr" },
      { isAuto: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("auto_vs_base_mismatch");
  });

  it("no-ops when match has NO metadata to judge (test-fixture pattern with only card_id/confidence)", () => {
    // Absence of variant/title/set/number isn't evidence of base — we
    // can't judge. Accept to avoid spurious rejections on stubs.
    const result = matchHonorsIdentity(
      { card_id: "ch-x" },  // no variant/title/set/number
      { isAuto: true },
    );
    expect(result.ok).toBe(true);
  });
});
