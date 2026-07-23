// Smoke tests for the POST /api/compiq/compute-hobbyiq-slug helper.
// Confirms the slug output matches the reference slugs iOS will target.

import { describe, it, expect } from "vitest";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// Pin the reference slugs iOS will test against. The route wraps
// computeHobbyIqCardId directly so exercising the underlying function
// covers the semantic contract — HTTP-level tests are covered by the
// existing route-level integration harness.

describe("computeHobbyIqCardId — reference slugs iOS depends on", () => {
  it("Hartman Blue Refractor /150 Auto", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "CPA-EHA",
      parallel: "Blue Refractor",
      isAuto: true,
      printRun: 150,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto:num-150");
  });

  it("Owen Carey Bowman Chrome Sapphire BSPA-OC /199 Auto", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "2026 Bowman Chrome Sapphire",
      cardNumber: "BSPA-OC",
      parallel: "Base",
      isAuto: true,
      printRun: 199,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome-sapphire:bspa-oc:base:auto:num-199");
  });

  it("Hartshorn 2025 Bowman Draft Chrome Gold Refractor /50 Auto", () => {
    // Bowman Draft Chrome collapses to bowman-draft in the current
    // normalizer — iOS mirrors this via the slug helper endpoint.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft Chrome",
      cardNumber: "CPA-JHA",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-draft:cpa-jha:gold-refractor:auto:num-50");
  });
});

describe("computeHobbyIqCardId — sport aliases the helper accepts", () => {
  it("NFL alias → football", () => {
    const nfl = computeHobbyIqCardId({
      sport: "NFL", year: 2024, setKey: "Prizm",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(nfl).toContain(":football:");
  });
  it("MLB alias → baseball", () => {
    const mlb = computeHobbyIqCardId({
      sport: "MLB", year: 2024, setKey: "Bowman",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(mlb).toContain(":baseball:");
  });
});
