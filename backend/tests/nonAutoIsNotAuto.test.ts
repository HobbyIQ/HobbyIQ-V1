// CF-NON-AUTO-IS-NOT-AUTO (2026-08-19).
//
// Found while auditing a user's 2024 Bowman Walker Jenkins /499 refractor auto,
// which was priced wrongly. Its comp pool ran $22.49 to $769, and the floor was
// this:
//
//   "WALKER JENKINS RC REFRACTOR Topps Chrome Bowman 2024 Non Auto Rookie Holo"
//   sitting in hiq:baseball:2024:bowman-chrome:cpa-wj:refractor:auto
//
// An UNSIGNED base card in a signed card's pool, dragging its floor. The listing
// said "Non Auto" in plain words.
//
// The cause: AUTO_NEGATIVE_RE listed only "auto relic" and "auto patch", so
// `\bauto\b` happily matched the "Auto" inside "Non Auto". Every one of these
// parsed as SIGNED.
//
// The card number remains the auto boundary — isCardNumberAutoSubset is OR'd in
// separately and is unaffected here. This governs title TEXT only, which is the
// only signal available when the number is not an auto prefix.

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

describe("CF-NON-AUTO-IS-NOT-AUTO", () => {
  it("the three production titles that were mis-parsed as signed", () => {
    // Card numbers here are NOT auto prefixes (BCP-/BP- are prospects), so the
    // title text is the only signal and it was being read backwards.
    expect(parseListingIdentity(
      "WALKER JENKINS RC REFRACTOR Topps Chrome Bowman 2024 Non Auto Rookie Holo",
    ).isAuto).toBe(false);
    expect(parseListingIdentity(
      "2026 Bowman Chrome /199 Fuchsia Konnor Griffin Non-Auto #BCP-92 - PIT Rookie",
    ).isAuto).toBe(false);
    expect(parseListingIdentity(
      "2019 Bowman Prospects Yordan Alvarez #BP-123 Pre Rookie Non Auto Card",
    ).isAuto).toBe(false);
  });

  it("covers the ways sellers write it", () => {
    for (const t of [
      "2024 Bowman Chrome Prospect Non Auto Refractor #BCP-1",
      "2024 Bowman Chrome Prospect Non-Auto Refractor #BCP-1",
      "2024 Bowman Chrome Prospect NonAuto Refractor #BCP-1",
      "2024 Bowman Chrome Prospect No Auto Refractor #BCP-1",
      "2024 Bowman Chrome Prospect Not Autographed Refractor #BCP-1",
      "2024 Bowman Chrome Prospect Unsigned Refractor #BCP-1",
    ]) {
      expect(parseListingIdentity(t).isAuto, t).toBe(false);
    }
  });

  it("does NOT break a genuine auto", () => {
    // The whole risk of a negation rule is over-firing. These must stay true.
    for (const t of [
      "2024 Bowman Chrome Prospect Auto Walker Jenkins #CPA-WJ - Raw 10",
      "2025 Bowman Chrome Refractor Max Williams #CPA-MWI Auto",
      "2024 Bowman Chrome Walker Jenkins 1st Bowman Refractor Auto /499 - PSA 10!",
      "2026 Bowman Chrome On-Card Autograph Eric Hartman #CPA-EHA",
      "2024 Topps Chrome Hard-Signed Rookie Autograph",
    ]) {
      expect(parseListingIdentity(t).isAuto, t).toBe(true);
    }
  });

  it("still treats an auto relic as not-an-auto-card", () => {
    // Pre-existing behaviour; the widened negation must not disturb it.
    expect(parseListingIdentity("2024 Topps Auto Relic Patch Booklet").isAuto).toBe(false);
  });

  it("the Walker Jenkins pool floor is excluded, the ceiling is not", () => {
    // The two ends of the pool that made the price wrong.
    const floor = parseListingIdentity(
      "WALKER JENKINS RC REFRACTOR Topps Chrome Bowman 2024 Non Auto Rookie Holo",
    );
    const real = parseListingIdentity(
      "2024 Bowman Chrome - Walker Jenkins 1st Bowman Refractor Auto /499 - PSA 10!",
    );
    expect(floor.isAuto).toBe(false);
    expect(real.isAuto).toBe(true);
    expect(real.printRun).toBe(499);
  });
});
