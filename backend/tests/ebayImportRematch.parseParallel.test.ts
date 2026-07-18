/**
 * Pinning tests for the rematch title guards. Each case corresponds
 * to a specific failure mode from the v3 dry-run where CH's fuzzy
 * match returned a wrong sub-parallel. The combined behavior of
 * isRiskyParallelChange + titleMentionsSpecificParallel is: preserve
 * BEFORE when the swap is risky UNLESS the title literally names the
 * new distinctive parallel term.
 */
import { describe, expect, it } from "vitest";
import {
  isRiskyParallelChange,
  shouldSuppressParallelChange,
  titleMentionsSpecificParallel,
} from "../src/services/portfolioiq/ebayImportRematch.service.js";

/** Helper mirroring the guard call-site: apply the guard, return the
 *  parallel string the matcher would actually persist. */
function guardedParallel(title: string, before: string | null, proposed: string | null): string | null {
  return shouldSuppressParallelChange(title, before, proposed) ? before : proposed;
}

describe("v3 dry-run failure modes — must PRESERVE before", () => {
  it("Owen Carey True Blue: Blue Refractor → Speckle Refractor (title doesn't say Speckle)", () => {
    expect(guardedParallel(
      "2026 Bowman Refractor Owen Carey True Blue #CPA-OC",
      "Blue Refractor",
      "Speckle Refractor",
    )).toBe("Blue Refractor");
  });

  it("Owen Carey Gold → Base (color loss, title says Gold)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Gold Baseball Owen Carey #CPA-OC",
      "Gold",
      "Base",
    )).toBe("Gold");
  });

  it("Hartman Reptilian Refractor → Lazer Refractor (title says just Refractor)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Refractor Eric Hartman #BCP-102",
      "Reptilian Refractor",
      "Lazer Refractor",
    )).toBe("Reptilian Refractor");
  });

  it("Hartshorn Blue → Refractor (color loss, before had Blue)", () => {
    expect(guardedParallel(
      "2025 Bowman Chrome Refractor Draft Josiah Hartshorn True",
      "Blue",
      "Refractor",
    )).toBe("Blue");
  });

  it("Sykora Blue Refractor → Refractor (color loss)", () => {
    expect(guardedParallel(
      "2024 Bowman Chrome Refractor Travis Sykora True Blue #CPA-TSY",
      "Blue Refractor",
      "Refractor",
    )).toBe("Blue Refractor");
  });

  it("Devin Taylor Gold Wave Refractor → Gold (sub-parallel loss)", () => {
    expect(guardedParallel(
      "2025 Bowman Draft Gold Devin Taylor",
      "Gold Wave Refractor",
      "Gold",
    )).toBe("Gold Wave Refractor");
  });

  it("Antunez Orange Shimmer → Orange Wave Refractor (sub-parallel swap, title says just Orange)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Orange Brailyn Antunez #CPA-BA",
      "Orange Shimmer",
      "Orange Wave Refractor",
    )).toBe("Orange Shimmer");
  });

  it("Original Blue → Blue X-Fractor failure (before is bare color)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Blue Eric Hartman #CPA-EHA",
      "Blue",
      "Blue X-Fractor",
    )).toBe("Blue");
  });

  it("v4 leak: Blue → Sky Blue Border (title says just 'Blue', not 'Border')", () => {
    expect(guardedParallel(
      "2026 Bowman Blue Eric Hartman #BP-102",
      "Blue",
      "Sky Blue Border",
    )).toBe("Blue");
  });

  it("v4 leak: Blue → Silver Pattern (parallel keywords in taxonomy)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Blue Player #CPA-XX",
      "Blue",
      "Silver Pattern",
    )).toBe("Blue");
  });
});

describe("v3 dry-run good upgrades — must APPLY proposed", () => {
  it("Hartman Aqua Refractor → Speckle Refractor (title actually says 'Speckle')", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Speckle Refractors Eric Hartman",
      "Aqua Refractor",
      "Speckle Refractor",
    )).toBe("Speckle Refractor");
  });

  it("Hartman Green Shimmer → Green Shimmer Refractor (canonical extension, same sub)", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Green Eric Hartman #CPA-EHA",
      "Green Shimmer",
      "Green Shimmer Refractor",
    )).toBe("Green Shimmer Refractor");
  });

  it("Hartman null → Base (before is null, no risk)", () => {
    expect(guardedParallel(
      "2026 Bowman Eric Hartman Atl Braves #BCP-102",
      null,
      "Base",
    )).toBe("Base");
  });

  it("Same parallel string is not a change", () => {
    expect(guardedParallel(
      "2026 Bowman Chrome Blue Eric Hartman #CPA-EHA",
      "Blue",
      "Blue",
    )).toBe("Blue");
  });
});

describe("isRiskyParallelChange", () => {
  it("null before is never risky", () => {
    expect(isRiskyParallelChange(null, "Base")).toBe(false);
    expect(isRiskyParallelChange(null, "Speckle Refractor")).toBe(false);
  });

  it("identical strings are not risky", () => {
    expect(isRiskyParallelChange("Blue", "Blue")).toBe(false);
    expect(isRiskyParallelChange("Speckle Refractor", "Speckle Refractor")).toBe(false);
  });

  it("bare color to specific sub is risky", () => {
    expect(isRiskyParallelChange("Blue", "Blue X-Fractor")).toBe(true);
    expect(isRiskyParallelChange("Gold", "Gold Wave Refractor")).toBe(true);
  });

  it("color loss is risky", () => {
    expect(isRiskyParallelChange("Gold", "Base")).toBe(true);
    expect(isRiskyParallelChange("Blue Refractor", "Refractor")).toBe(true);
  });

  it("color swap is risky", () => {
    expect(isRiskyParallelChange("Green X-Fractor", "Blue X-Fractor")).toBe(true);
    expect(isRiskyParallelChange("Green Shimmer", "Orange Shimmer")).toBe(true);
  });

  it("sub-parallel loss is risky", () => {
    expect(isRiskyParallelChange("Gold Wave Refractor", "Gold")).toBe(true);
    expect(isRiskyParallelChange("Reptilian Refractor", "Refractor")).toBe(true);
  });

  it("sub-parallel swap is risky", () => {
    expect(isRiskyParallelChange("Orange Shimmer", "Orange Wave Refractor")).toBe(true);
    expect(isRiskyParallelChange("Aqua Refractor", "Speckle Refractor")).toBe(true);
    expect(isRiskyParallelChange("Reptilian Refractor", "Lazer Refractor")).toBe(true);
  });

  it("adding sub-parallel is risky", () => {
    expect(isRiskyParallelChange("Refractor", "Reptilian Refractor")).toBe(true);
  });

  it("canonical extension (same color same sub) is NOT risky", () => {
    expect(isRiskyParallelChange("Green Shimmer", "Green Shimmer Refractor")).toBe(false);
    expect(isRiskyParallelChange("Blue X-Fractor", "Blue X-Fractor")).toBe(false);
  });
});

describe("titleMentionsSpecificParallel", () => {
  it("title with 'Speckle' supports Speckle Refractor", () => {
    expect(titleMentionsSpecificParallel(
      "2026 Bowman Chrome Speckle Refractors Eric Hartman",
      "Speckle Refractor",
    )).toBe(true);
  });

  it("title without 'Speckle' does NOT support Speckle Refractor", () => {
    expect(titleMentionsSpecificParallel(
      "2026 Bowman Refractor Owen Carey True Blue #CPA-OC",
      "Speckle Refractor",
    )).toBe(false);
  });

  it("title with 'Xfractor' supports X-Fractor via dash-stripped match", () => {
    expect(titleMentionsSpecificParallel(
      "2026 Bowman Chrome Xfractor Owen Carey",
      "X-Fractor",
    )).toBe(true);
  });

  it("proposal with no distinctive tokens is always supported", () => {
    expect(titleMentionsSpecificParallel("anything", "Refractor")).toBe(true);
    expect(titleMentionsSpecificParallel("anything", "Base")).toBe(true);
    expect(titleMentionsSpecificParallel("anything", "Blue")).toBe(true);
  });

  it("null proposal is not supported", () => {
    expect(titleMentionsSpecificParallel("anything", null)).toBe(false);
  });
});
