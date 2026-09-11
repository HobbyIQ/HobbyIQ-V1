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

/**
 * CF-TOPPS-THREE-IS-TOPPS-3 (Drew's Ruling 22, 2026-09-09).
 *
 * One product, two spellings: hobbymonitor writes "2023/24 Topps Three
 * Basketball", the checklist writes "2023 topps 3". Count-by-source decides
 * which spelling is canonical, and the checklist-backed side wins -- so
 * `topps-3` is the key and `topps-three` folds onto it.
 *
 * THE ALIAS WAS NOT THE WHOLE DEFECT, which is why this lives in the PRODUCT
 * table rather than only in RULED_ALIASES. Measured on this branch BEFORE the
 * change, "Topps Three" did not normalize to `topps-three` at all: no rule
 * named it, so it fell through to the bare `/topps/` family pattern and came
 * back `topps` -- the FLAGSHIP. That is
 * CF-FLAGSHIP-CATCHALL-SWALLOWS-SPECIALIZATIONS exactly, and it pools Topps
 * Three cards with flagship Topps. Naming the product stops the catch-all
 * before it can answer; the alias then folds the vendor spelling onto the
 * checklist's.
 */
describe("Topps Three is Topps 3 (Ruling 22)", () => {
  it("folds the vendor spelling onto the checklist key", () => {
    expect(normalizeSetKey("2023/24 Topps Three Basketball")).toBe("topps-3");
    expect(normalizeSetKey("Topps Three")).toBe("topps-3");
    expect(normalizeSetKey("topps-three")).toBe("topps-3");
  });

  it("and the checklist's own spelling is unchanged", () => {
    expect(normalizeSetKey("2023 topps 3")).toBe("topps-3");
    expect(normalizeSetKey("topps-3")).toBe("topps-3");
  });

  /** A ruled key must be a FIXED POINT, or the pool can never name the
   *  checklist it already has. */
  it("topps-3 is a fixed point — normalizing it again returns itself", () => {
    expect(normalizeSetKey(normalizeSetKey("Topps Three"))).toBe("topps-3");
  });

  /** THE REGRESSION THIS REPLACES. Before Ruling 22 both spellings answered
   *  `topps`, fusing a specialized product into the flagship pool. */
  it("neither spelling answers the bare flagship any more", () => {
    expect(normalizeSetKey("Topps Three")).not.toBe("topps");
    expect(normalizeSetKey("2023/24 Topps Three Basketball")).not.toBe("topps");
    // ...while the flagship itself is untouched.
    expect(normalizeSetKey("2024 Topps Baseball")).toBe(normalizeSetKey("Topps"));
  });

  /** The sibling specializations must not have moved. */
  it("does not disturb the other Topps products", () => {
    expect(normalizeSetKey("2023 Topps Series 1")).toBe("topps-series-1");
    expect(normalizeSetKey("Topps Chrome")).toBe("topps-chrome");
    expect(normalizeSetKey("Topps Update Series")).toBe("topps-update-series");
  });
});
