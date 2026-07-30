// CF-FIND-NEIGHBOR-COMPS tests (Drew, 2026-07-30). Test the filter
// builder + composite derivation. Live Cosmos integration test lives
// in the prototype script (test-neighbor-comps.cjs).

import { describe, it, expect } from "vitest";
import { compositeFilterFromCardId } from "../src/services/portfolioiq/findNeighborComps.service.js";

describe("compositeFilterFromCardId — derive filter from slug", () => {
  it("full canonical slug → sport + year + productLine + isAuto + serialRun", () => {
    const f = compositeFilterFromCardId("hiq:baseball:2024:bowman-chrome:cpa-eha:gold-refractor:auto:num-50");
    expect(f.sport).toBe("baseball");
    expect(f.cardYear).toBe(2024);
    expect(f.productLine).toBe("bowman-chrome");
    expect(f.isAuto).toBe(true);
    expect(f.serialRun).toBe(50);
  });
  it("no printRun suffix → serialRun null", () => {
    const f = compositeFilterFromCardId("hiq:baseball:2024:bowman-chrome:cpa-eha:blue-refractor:no-auto");
    expect(f.serialRun).toBe(null);
    expect(f.isAuto).toBe(false);
  });
  it("invalid slug → empty filter (silent-safe)", () => {
    const f = compositeFilterFromCardId("garbage");
    expect(f.sport).toBeUndefined();
    expect(f.cardYear).toBeUndefined();
  });
});
