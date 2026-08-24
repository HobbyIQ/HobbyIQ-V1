import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * CF-REF-IS-REFRACTOR (Drew, 2026-08-24).
 *
 * The sale that exposed it, verbatim from prod:
 *
 *   "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9"
 *
 * parsed to parallel "Refractor" — the Gold silently dropped. Not by a bad
 * colour rule: the bare-refractor rule tests /\brefractor\b/, which "Ref."
 * does not match, so EVERY colour and pattern rule was skipped and the title
 * fell through to the chrome-auto fallback. The colour was never read.
 *
 * Consequence: a Gold Refractor /50 filed on :refractor:, so the gold pool held
 * zero comps for a card that had demonstrably traded, and the holding priced
 * against /499 commons at 4.5% of what was paid.
 *
 * The expansion runs once, up front, so every existing rule gets its chance
 * instead of each having to learn the abbreviation. The negative lookahead
 * matters more than it looks — without word boundaries this turns "Preferred
 * Parallel" into "PRefractorerred Parallel", which is exactly what an earlier
 * draft of this fix did.
 */
describe("Ref is an abbreviation for Refractor", () => {
  const par = (t: string) => (parseListingIdentity(t) as { parallel?: string }).parallel;

  it("recovers the colour from the real prod sale", () => {
    const t = "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9";
    expect(par(t)).toBe("Gold Refractor");
  });

  it("still reads the rest of that title correctly", () => {
    const r = parseListingIdentity(
      "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9",
    ) as { cardNumber?: string; printRun?: number; isAuto?: boolean };
    expect(r.cardNumber).toBe("CPA-MWI");
    expect(r.printRun).toBe(50);
    expect(r.isAuto).toBe(true);
  });

  it("handles the abbreviation with and without the period", () => {
    expect(par("2024 Bowman Chrome Blue Ref #BCP-100 /150")).toBe("Blue Refractor");
    expect(par("2024 Bowman Chrome Blue Ref. #BCP-100 /150")).toBe("Blue Refractor");
  });

  it("keeps a pattern parallel intact through the expansion", () => {
    expect(par("2025 Bowman Draft Gold Wave Ref. /50")).toBe("Gold Wave Refractor");
  });

  it("leaves the unabbreviated word alone", () => {
    expect(par("2025 Topps Chrome Aaron Judge Refractor #50")).toBe("Refractor");
  });

  it("does NOT corrupt ordinary words containing 'ref'", () => {
    // Without \b this rewrote "Preferred" to "PRefractorerred". These titles
    // must parse exactly as they did before the fix existed.
    for (const t of [
      "2025 Panini Preferred Parallel #12",
      "2025 Topps Referee Auto #5",
      "2024 Bowman Reflections Insert #9",
    ]) {
      expect(par(t), t).not.toContain("Refractor");
    }
  });
});
