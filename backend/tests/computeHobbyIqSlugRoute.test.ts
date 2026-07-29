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

  it("Hartshorn 2025 Bowman Draft Chrome Gold Refractor /50 Auto → bowman-chrome-draft", () => {
    // CF-SETKEY-DRAFT-CHROME-COLLISION (Drew, 2026-07-29). Prior expected
    // "bowman-draft" (the buggy collision output) — that pinned the bug
    // in place. Now the setKey correctly routes to "bowman-chrome-draft",
    // preserving the paper-vs-chrome stock distinction at the slug layer.
    // Chrome autos (CPA-/BCDA-) live under bowman-chrome-draft; paper
    // autos (BDA-) live under bowman-draft.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft Chrome",
      cardNumber: "CPA-JHA",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-chrome-draft:cpa-jha:gold-refractor:auto:num-50");
  });

  it("2025 Bowman Draft (paper) BDA-XX Blue Border /150 Auto → bowman-draft (stock-preserving)", () => {
    // Guardrail: paper Bowman Draft keeps its "bowman-draft" setKey,
    // does NOT accidentally fall into "bowman-chrome-draft". Paper BDA-XX
    // autos and Chrome BCDA-XX autos of the same card number now produce
    // DIFFERENT slugs, which is the correct behavior for pricing.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft",
      cardNumber: "BDA-EW",
      parallel: "Blue Border",
      isAuto: true,
      printRun: 150,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-draft:bda-ew:blue-border:auto:num-150");
  });

  it("2025 Bowman (paper flagship) BPA-XX Gold Border /50 Auto → bowman", () => {
    // Paper flagship Bowman keeps its "bowman" setKey — where BPA-XX
    // paper autos live. This has always been correct; pinning as a
    // regression guard alongside the chrome-draft fix.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman",
      cardNumber: "BPA-EH",
      parallel: "Gold Border",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman:bpa-eh:gold-border:auto:num-50");
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
