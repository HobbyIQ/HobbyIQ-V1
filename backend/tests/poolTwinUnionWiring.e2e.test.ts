/**
 * CF-A-UNION-IS-ONE-CARD / E2E WIRING (2026-09-01).
 *
 * poolTwinUnionIsOneCard.test.ts pins unifiedIdentityAttempts directly. That
 * is the guard's own function, but it is still one level above the wire: it
 * proves the ATTEMPT LIST is right, not that the caller prices from that list.
 * The adversarial verify's lesson on the swing alarm (helpers pinned, wiring
 * dead, suite green) applies here too — so this file pins the guard where the
 * pool is actually read.
 *
 * Surface: priceHoldingFromExactPool on the RA-JC split-identity holding —
 * hobbyiqCardId on 2026 topps-chrome, cardId on 2024 bowman-draft, two
 * genuinely different products that the cardId+hobbyiqCardId union would
 * otherwise merge into one cross-product pool. computeUnifiedPrice is mocked
 * to CAPTURE every identity the caller actually queries with.
 *
 * The assertions:
 *   1. no query ever carries the 2024 bowman-draft half — not as cardId, not
 *      as hobbyiqCardId, not inside hobbyiqCardIds;
 *   2. no single query carries BOTH products (that is the cross-product read);
 *   3. the holding is STILL priced, from its own slug half (a refusal is not
 *      a refusal to price);
 *   4. pool_twin_union_refused_cross_product warns exactly ONCE;
 *   5. and the refusal reason rides the attempt that was priced from, so the
 *      swing alarm's unionRefused field has something to report.
 *
 * A same-product holding is pinned alongside as the negative control: the
 * union still forms, because collapsing a twin is the whole point of the OR.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const CHROME_499 = "hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto:num-499";
const BOWMAN = "hiq:baseball:2024:bowman-draft:ra-jc:refractor:auto";
// Same-product twin (the control): one product, bare stem vs numbered.
const TWIN_STEM = "hiq:baseball:2026:topps-chrome:mwi-1:refractor:auto";
const TWIN_499 = `${TWIN_STEM}:num-499`;

/** Every (cardId, hobbyiqCardId, hobbyiqCardIds) the pool was actually asked for. */
type Query = { cardId: string | null; hobbyiqCardId: string | null; hobbyiqCardIds: string[] };
const queries: Query[] = [];

vi.mock("../src/services/compiq/unifiedPricing.service.js", () => ({
  computeUnifiedPrice: vi.fn(async (cardId: string, opts: any) => {
    queries.push({
      cardId: cardId ?? null,
      hobbyiqCardId: opts?.hobbyiqCardId ?? null,
      hobbyiqCardIds: opts?.hobbyiqCardIds ?? [],
    });
    // A priceable pool on whatever identity is asked for, so the caller
    // accepts the FIRST attempt and we see the identity it chose.
    return {
      fmv: 212.95,
      marketValue: 212.95,
      predictedPrice: 210,
      totalSampleCount: 6,
      confidence: 0.8,
      rungLabel: "exact-pool",
      windowDays: 90,
      trendDirection: "flat",
      trendPctPerWeek: 0,
    };
  }),
}));

// The resolver is passed `null` explicitly by every call below (do not
// resolve), so no Cosmos read is attempted from this file.
beforeEach(() => {
  queries.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function subject() {
  return await import("../src/services/portfolioiq/exactPoolSupremacy.js");
}

describe("E2E WIRING — the union guard holds where the pool is read", () => {
  it("THE RA-JC SPLIT IDENTITY: no query carries the bowman-draft half, and the warning fires once", async () => {
    const { priceHoldingFromExactPool } = await subject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const priced = await priceHoldingFromExactPool(
      { hobbyiqCardId: CHROME_499, cardId: BOWMAN } as any,
      { grade: null, resolution: null },
    );

    const events = warn.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((e: any) => e?.event === "pool_twin_union_refused_cross_product");
    warn.mockRestore();

    // (0) the pool was actually read — otherwise the assertions below are vacuous.
    expect(queries.length, "priceHoldingFromExactPool never queried the pool").toBeGreaterThan(0);

    // (1) the 2024 bowman-draft half NEVER reaches a pool query, by any route.
    for (const q of queries) {
      expect(q.cardId).not.toBe(BOWMAN);
      expect(q.hobbyiqCardId).not.toBe(BOWMAN);
      expect(q.hobbyiqCardIds).not.toContain(BOWMAN);
    }

    // (2) and no SINGLE query mixes the two products — the cross-product read.
    for (const q of queries) {
      const ids = [q.cardId, q.hobbyiqCardId, ...q.hobbyiqCardIds].filter(Boolean) as string[];
      const products = new Set(
        ids
          .filter((s) => s.startsWith("hiq:"))
          .map((s) => s.split(":").slice(1, 4).join(":")),
      );
      expect(products.size, `one query spanned two products: ${JSON.stringify(q)}`).toBeLessThanOrEqual(1);
    }

    // (3) it is still PRICED — single-sided, from its own slug half.
    expect(priced).not.toBeNull();
    expect(queries[0].cardId).toBe(CHROME_499);

    // (4) exactly one warning for the one refusal.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardId: BOWMAN,
      hobbyiqCardId: CHROME_499,
      cardIdProduct: "baseball:2024:bowman-draft",
      hobbyiqCardIdProduct: "baseball:2026:topps-chrome",
    });

    // (5) the refusal reason rides the priced attempt, so the swing alarm's
    //     unionRefused field can name why a value moved.
    expect((priced as any)?.attempt?.unionRefusedReason).toMatch(/union-refused/);
  });

  it("NEGATIVE CONTROL: a same-product twin still unions in one query, and nothing warns", async () => {
    const { priceHoldingFromExactPool } = await subject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const priced = await priceHoldingFromExactPool(
      { hobbyiqCardId: TWIN_499, cardId: TWIN_STEM } as any,
      { grade: null, resolution: null },
    );

    const events = warn.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((e: any) => e?.event === "pool_twin_union_refused_cross_product");
    warn.mockRestore();

    expect(priced).not.toBeNull();
    // The twin's PURPOSE survives: the cardId half is NOT quarantined out of
    // the attempt list the way the cross-product half is. With no catalog
    // resolution the halves are tried in order, and the cardId+hobbyiqCardId
    // union attempt is FORMED — which is exactly what the RA-JC case refuses.
    const { unifiedIdentityAttempts } = await subject();
    const attempts = unifiedIdentityAttempts({ hobbyiqCardId: TWIN_499, cardId: TWIN_STEM } as any, null);
    expect(attempts.map((a) => a.label)).toContain("cardId+hobbyiqCardId");
    const unionAttempt = attempts.find((a) => a.label === "cardId+hobbyiqCardId")!;
    expect(unionAttempt.cardId).toBe(TWIN_STEM);
    expect(unionAttempt.hobbyiqCardId).toBe(TWIN_499);

    // Nothing was refused, so nothing warned and no reason was stamped.
    expect(events).toHaveLength(0);
    expect(attempts.every((a) => a.unionRefusedReason === undefined)).toBe(true);
    expect((priced as any)?.attempt?.unionRefusedReason ?? null).toBeNull();
  });
});
