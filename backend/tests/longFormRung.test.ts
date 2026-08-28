// CF-LONG-FORM-IS-ONE-FAMILY-WORD (Drew, 2026-08-28) — the unique long-form
// rung rule at the live matcher seam. Ambiguity measured at 0.2% across 1.96M
// spellings before the rule was written; the unique-match guard is the Prizm
// safety and these tests are its contract.
import { describe, it, expect } from "vitest";
import { resolveLongFormRung, parallelTokenSet, widenedSetKeyPrefixes } from "../src/services/catalog/catalogMatcher.service.js";

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

describe("widenedSetKeyPrefixes — CF-VERIFIED-REFINEMENTS-ONLY", () => {
  it("widens only into -series and -update, never the bare hyphen", () => {
    expect(widenedSetKeyPrefixes("topps")).toEqual(["topps-series", "topps-update"]);
  });
  it("topps-chrome can never be reached from topps", () => {
    for (const p of widenedSetKeyPrefixes("topps")) {
      expect("topps-chrome".startsWith(p)).toBe(false);
      expect("topps-chrome-sapphire".startsWith(p)).toBe(false);
    }
  });
  it("bowman widens to prefixes that match nothing real — harmless by construction", () => {
    for (const p of widenedSetKeyPrefixes("bowman")) {
      expect("bowman-chrome".startsWith(p)).toBe(false);
      expect("bowman-sapphire".startsWith(p)).toBe(false);
    }
  });
  it("empty input widens to nothing", () => {
    expect(widenedSetKeyPrefixes("")).toEqual([]);
  });
});
