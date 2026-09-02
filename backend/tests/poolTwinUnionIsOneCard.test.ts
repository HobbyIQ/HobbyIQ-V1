/**
 * CF-A-UNION-IS-ONE-CARD (2026-09-01, holdings 9b971b03 RA-JC and ca820b08
 * Gonzalez).
 *
 * `readExactPoolRows` builds ONE query that ORs `c.cardId = @cid` with
 * `c.hobbyiqCardId = @hiq`. The pool-twin union above it is stem-checked by
 * catalogIdentityResolver.poolReadIdsFor, but the `cardId+hobbyiqCardId`
 * attempt was not: any two identities a holding happened to carry were merged
 * into one pool.
 *
 * Holding 9b971b03 carried
 *   cardId          hiq:baseball:2024:bowman-draft:ra-jc:refractor:auto
 *   hobbyiqCardId   hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto:num-499
 * (catalogVerified=false, "no-cardnumber-match-in-set"). Two products in one
 * pool: the 6h cron logged 21.25 x5 -> 212.95 -> 20.625 -> 20.625 -> 213.8 ->
 * 20.625, a ~10.4x swing decided by which half the selected window reached.
 * RA-JC is 2026 Topps Chrome per Drew; conforming the holding's own fields is
 * the rulings lane's job, but the union must refuse either way.
 *
 * The twin's purpose is preserved: same product with and without the print-run
 * suffix still unions.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  unifiedIdentityAttempts,
  productIdentityOf,
  mayUnionIdentities,
} from "../src/services/portfolioiq/exactPoolSupremacy.js";

const CHROME = "hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto";
const CHROME_499 = `${CHROME}:num-499`;
const BOWMAN = "hiq:baseball:2024:bowman-draft:ra-jc:refractor:auto";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("productIdentityOf / mayUnionIdentities", () => {
  it("names sport:year:setKey, and ignores everything within the product", () => {
    expect(productIdentityOf(CHROME)).toBe("baseball:2026:topps-chrome");
    // The print run, the parallel and the grade are all WITHIN one product.
    expect(productIdentityOf(CHROME_499)).toBe("baseball:2026:topps-chrome");
    expect(productIdentityOf(`${CHROME_499}:psa-9`)).toBe("baseball:2026:topps-chrome");
    expect(productIdentityOf(BOWMAN)).toBe("baseball:2024:bowman-draft");
    // A vendor id names no product and is never compared.
    expect(productIdentityOf("vendor-12345")).toBeNull();
    expect(productIdentityOf(null)).toBeNull();
  });

  it("unions the same product, refuses different ones, and lets a vendor id through", () => {
    expect(mayUnionIdentities(CHROME, CHROME_499)).toBe(true);
    expect(mayUnionIdentities(CHROME_499, BOWMAN)).toBe(false);
    // Cross-vendor storage is what the cardId OR exists for — never refused.
    expect(mayUnionIdentities("vendor-12345", CHROME_499)).toBe(true);
  });
});

describe("CF-A-UNION-IS-ONE-CARD — the RA-JC shape refuses and prices single-sided", () => {
  it("does not form a cardId+hobbyiqCardId attempt across two products", () => {
    const attempts = unifiedIdentityAttempts({ hobbyiqCardId: CHROME_499, cardId: BOWMAN });
    // The 2024 bowman-draft half never reaches the pool query — neither as
    // the union partner nor through its own twin.
    expect(attempts.map((a) => a.label)).not.toContain("cardId+hobbyiqCardId");
    expect(attempts.map((a) => a.label)).not.toContain("cardId-twin");
    for (const a of attempts) {
      expect(a.cardId).not.toBe(BOWMAN);
      expect(a.hobbyiqCardId).not.toBe(BOWMAN);
      expect(a.hobbyiqCardIds ?? []).not.toContain(BOWMAN);
    }
    // It IS still priced — from its own slug half.
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].cardId).toBe(CHROME_499);
  });

  it("records the refusal reason on the attempt it is priced from, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempts = unifiedIdentityAttempts({ hobbyiqCardId: CHROME_499, cardId: BOWMAN });
    for (const a of attempts) {
      expect(a.unionRefusedReason).toMatch(/union-refused/);
      expect(a.unionRefusedReason).toContain("baseball:2024:bowman-draft");
      expect(a.unionRefusedReason).toContain("baseball:2026:topps-chrome");
    }
    const events = warn.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((e) => e?.event === "pool_twin_union_refused_cross_product");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardId: BOWMAN,
      hobbyiqCardId: CHROME_499,
      cardIdProduct: "baseball:2024:bowman-draft",
      hobbyiqCardIdProduct: "baseball:2026:topps-chrome",
    });
  });

  it("the Gonzalez shape (a different year of the same set) refuses too", () => {
    const a2026 = "hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto:num-499";
    const a2024 = "hiq:baseball:2024:bowman-chrome:cpa-jg:refractor:auto";
    const attempts = unifiedIdentityAttempts({ hobbyiqCardId: a2026, cardId: a2024 });
    expect(attempts.map((a) => a.label)).not.toContain("cardId+hobbyiqCardId");
    expect(attempts.every((a) => a.unionRefusedReason !== undefined)).toBe(true);
  });
});

describe("REGRESSION — the twin's purpose survives", () => {
  const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
  const MWI_499 = `${MWI}:num-499`;
  const TWIN = { requested: MWI, id: MWI_499, kind: "numbered-twin" as const, twins: [MWI_499], poolTwin: MWI_499 };

  it("same product, num-499 vs bare stem, still unions", () => {
    const a = unifiedIdentityAttempts({ hobbyiqCardId: MWI }, TWIN);
    expect(a[0]).toEqual({
      cardId: MWI_499,
      hobbyiqCardId: MWI_499,
      hobbyiqCardIds: [MWI_499, MWI],
      label: "hobbyiqCardId+pool-twin",
    });
    expect(a[0].unionRefusedReason).toBeUndefined();
  });

  it("a same-product cardId still unions with the slug, as it always did", () => {
    const a = unifiedIdentityAttempts({ hobbyiqCardId: MWI_499, cardId: MWI });
    // Same product either side: the cardId attempt is formed, unrefused.
    expect(a.map((x) => x.label)).toContain("hobbyiqCardId");
    expect(a.every((x) => x.unionRefusedReason === undefined)).toBe(true);
  });

  it("a VENDOR cardId still unions with the slug — cross-vendor storage is the point", () => {
    const a = unifiedIdentityAttempts({ hobbyiqCardId: MWI }, TWIN);
    const withVendor = unifiedIdentityAttempts({ hobbyiqCardId: MWI, cardId: "vendor-1" }, TWIN);
    expect(withVendor.map((x) => x.label)).toEqual(["hobbyiqCardId+pool-twin", "cardId+hobbyiqCardId"]);
    expect(withVendor.every((x) => x.unionRefusedReason === undefined)).toBe(true);
    expect(withVendor[0]).toEqual(a[0]);
  });
});

/**
 * MUTATION CHECK. Removing the guard — i.e. forming the cardId attempt
 * unconditionally, which is exactly the pre-fix code — puts the 2024
 * bowman-draft id back into the pool query. This test states the property the
 * guard exists for, so the pins above cannot pass with the guard deleted.
 */
describe("mutation — the guard is load-bearing", () => {
  it("without a product check, the RA-JC halves would merge; with it, they do not", () => {
    // The pre-fix predicate: any non-equal cardId is unioned.
    const preFixWouldUnion = BOWMAN !== CHROME_499;
    expect(preFixWouldUnion).toBe(true);
    // The guard is what turns that into a refusal.
    expect(mayUnionIdentities(BOWMAN, CHROME_499)).toBe(false);
    const attempts = unifiedIdentityAttempts({ hobbyiqCardId: CHROME_499, cardId: BOWMAN });
    expect(attempts.some((a) => a.cardId === BOWMAN || a.hobbyiqCardId === BOWMAN)).toBe(false);
  });
});
