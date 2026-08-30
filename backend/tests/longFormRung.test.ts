// CF-LONG-FORM-IS-ONE-FAMILY-WORD (Drew, 2026-08-28) — the unique long-form
// rung rule at the live matcher seam. Ambiguity measured at 0.2% across 1.96M
// spellings before the rule was written; the unique-match guard is the Prizm
// safety and these tests are its contract.
import { describe, it, expect } from "vitest";
import { resolveLongFormRung, parallelTokenSet, widenedSetKeys } from "../src/services/catalog/catalogMatcher.service.js";

const cand = (seg: string) => ({ id: `hiq:baseball:2023:topps-chrome:150:${seg}:no-auto`, seg });

describe("resolveLongFormRung", () => {
  it('a sale saying "Gold" adopts the ladder\'s one "Gold Refractor"', () => {
    const hit = resolveLongFormRung(parallelTokenSet("gold"), [
      cand("gold-refractor"), cand("blue-refractor"), cand("base"),
    ]);
    expect(hit?.seg).toBe("gold-refractor");
  });

  it('the reverse direction: a sale saying "Gold Refractor" adopts a ladder spelling it bare', () => {
    const hit = resolveLongFormRung(parallelTokenSet("gold-refractor"), [
      cand("gold"), cand("blue"), cand("base"),
    ]);
    expect(hit?.seg).toBe("gold");
  });

  it("THE PRIZM GUARD: a card carrying both forms yields two candidates and refuses", () => {
    const hit = resolveLongFormRung(parallelTokenSet("gold"), [
      cand("gold-refractor"), cand("gold-prizm"),
    ]);
    expect(hit).toBeNull();
  });

  it("zero family-word matches refuses — no synthesis toward a rung that is not there", () => {
    const hit = resolveLongFormRung(parallelTokenSet("tinsel"), [
      cand("gold-refractor"), cand("base"),
    ]);
    expect(hit).toBeNull();
  });

  it("equality is not its job: an exact-token candidate is skipped, not double-claimed", () => {
    // Step 2 would have adopted "gold" already; long-form must not return it.
    const hit = resolveLongFormRung(parallelTokenSet("gold"), [
      cand("gold"), cand("gold-refractor"),
    ]);
    expect(hit?.seg).toBe("gold-refractor");
  });

  it("multi-token family words work: x-fractor attaches as one unit", () => {
    const hit = resolveLongFormRung(parallelTokenSet("blue"), [
      cand("blue-x-fractor"), cand("base"),
    ]);
    expect(hit?.seg).toBe("blue-x-fractor");
  });

  it("never strips below an empty modifier: \"Refractor\" alone must not adopt bare \"base\"", () => {
    const hit = resolveLongFormRung(parallelTokenSet("refractor"), [
      cand("base"),
    ]);
    expect(hit).toBeNull();
  });
});

describe("widenedSetKeys — CF-VERIFIED-REFINEMENTS-ONLY", () => {
  // D23 (CF-THE-ID-CARRIES-THE-PRODUCT): the refinements are the table's
  // exact keys — the series split and the update series, every spelling of
  // them — never a `-series` / `-update` PREFIX, which would have admitted
  // topps-series-1-1st-edition (another set).
  it("widens only into the series split and the update series", () => {
    const w = widenedSetKeys("topps");
    expect(w).toEqual(expect.arrayContaining(["topps-series-1", "topps-series-2", "topps-update-series", "topps-update"]));
    expect(w).not.toContain("topps-series-1-1st-edition");
  });
  it("topps-chrome can never be reached from topps", () => {
    const w = widenedSetKeys("topps");
    expect(w).not.toContain("topps-chrome");
    expect(w).not.toContain("topps-chrome-sapphire");
    expect(w).not.toContain("topps-chrome-update-series");
  });
  it("bowman widens into nothing — harmless by construction", () => {
    expect(widenedSetKeys("bowman")).toEqual([]);
  });
  it("empty input widens to nothing", () => {
    expect(widenedSetKeys("")).toEqual([]);
  });
});
