import { describe, it, expect } from "vitest";
import { normalizeSetKey, stripYearAndSport } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// CF-THE-PRODUCT-NAME-IS-NOT-THE-KEY (2026-08-29). The identity triangulation
// baseline found the holding path leaking the product name's year and sport
// into the set key. A holding typed the way the checklist names the product
// must land on the checklist's key.
describe("normalizeSetKey: the product name is not the key", () => {
  it("strips a leading year", () => {
    expect(normalizeSetKey("2024 Panini Prospect Edition")).toBe(normalizeSetKey("Panini Prospect Edition"));
  });
  it("strips a trailing sport word", () => {
    expect(normalizeSetKey("Panini Prospect Edition Baseball")).toBe(normalizeSetKey("Panini Prospect Edition"));
    expect(normalizeSetKey("2024 Panini Prospect Edition Baseball")).toBe(normalizeSetKey("Panini Prospect Edition"));
  });
  it("strips a season prefix the same way the 2026-08-28 ruling does", () => {
    expect(stripYearAndSport("2024-25-panini-prizm")).toBe("panini-prizm");
  });
  it("leaves a sport word in the MIDDLE of a name alone", () => {
    expect(stripYearAndSport("topps-baseball-35th-anniversary")).toBe("topps-baseball-35th-anniversary");
  });
  it("never returns an empty key", () => {
    expect(stripYearAndSport("2024-baseball").length).toBeGreaterThan(0);
    expect(stripYearAndSport("2024-")).toBe("2024-");
  });
  it("flagship keeps matching the checklist's bare key", () => {
    expect(normalizeSetKey("2024 Topps Baseball")).toBe(normalizeSetKey("Topps"));
  });
});
