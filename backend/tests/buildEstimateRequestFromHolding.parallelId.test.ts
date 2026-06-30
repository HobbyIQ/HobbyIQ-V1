/**
 * CF-HOLDING-REFRESH-PARALLELID-THREAD (2026-06-26) — unit tests on the
 * builder. The integration test that exercises the scheduled-reprice
 * path through computeEstimate lives in a sibling file
 * (`buildEstimateRequestFromHolding.parallelId.refresh.test.ts`) so the
 * unit tests stay clean of the pre-existing `@apple/app-store-server-
 * library` import noise that `import app` drags in.
 *
 * What this file locks:
 *   1. INCLUDES parallelId on the request when the holding stores one.
 *   2. OMITS parallelId (undefined, not null) when the holding lacks it.
 *   3. OMITS when stored as explicit `null` (legacy holdings shape).
 *   4. Back-compat: an unpinned holding (no cardId) still omits
 *      parallelId cleanly without crashing the builder.
 *
 * Why it matters — the engine wire trace:
 *   CF-ENGINE-PARALLEL-CANONICALIZE (63fe5039) added a router seam that
 *   reads `parallelId` off the CompIQEstimateRequest, calls
 *   `resolveCanonicalParallel` against the Cardsight catalog, and uses
 *   the catalog's authoritative `{name} /{numberedTo}` in the CH bridge
 *   query. That wiring already serves `/api/compiq/price-by-id` (iOS
 *   sends parallelId in the body). The holding-refresh path
 *   (`/api/portfolio/holdings/:id/refresh`, empty body) goes through
 *   this builder — so without parallelId here, the canonicalize step
 *   silently never fires on pull-to-refresh for parallel holdings.
 */
import { describe, it, expect } from "vitest";
import { buildEstimateRequestFromHolding } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const HARTMAN_PARENT = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const GREEN_SHIMMER_PARALLEL_ID = "c1cea15f-5513-43cf-bc32-03d015fe80b1";

function holdingWith(fields: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    id: "test-holding-id",
    quantity: 1,
    purchasePrice: 250,
    totalCostBasis: 250,
    cardStatus: "active",
    ...fields,
  } as PortfolioHolding;
}

describe("buildEstimateRequestFromHolding — parallelId threading (CF-HOLDING-REFRESH-PARALLELID-THREAD)", () => {
  it("INCLUDES parallelId on the request when the holding stores one", () => {
    const holding = holdingWith({
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor /99",
      isAuto: true,
      cardId: HARTMAN_PARENT,
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
    });

    const req = buildEstimateRequestFromHolding(holding);

    expect(req.parallelId).toBe(GREEN_SHIMMER_PARALLEL_ID);
    // Sanity: the rest of the shape is unchanged.
    expect(req.playerName).toBe("Eric Hartman");
    expect(req.cardId).toBe(HARTMAN_PARENT);
    expect(req.parallel).toBe("Green Shimmer Refractor /99");
    expect(req.pinnedAuthoritative).toBe(true);
  });

  it("OMITS parallelId (undefined, not null) when the holding lacks one", () => {
    const holding = holdingWith({
      playerName: "Mike Trout",
      cardId: "fda530ab-e925-460e-ab88-63199ef975e9",
    });

    const req = buildEstimateRequestFromHolding(holding);

    expect(req.parallelId).toBeUndefined();
    // CompIQEstimateRequest type is `parallelId?: string` — null would be a
    // type error downstream. The builder normalizes null/missing → undefined.
    expect(req.parallelId).not.toBeNull();
  });

  it("OMITS parallelId when stored as explicit null (legacy holding write)", () => {
    const holding = holdingWith({
      playerName: "Mike Trout",
      cardId: "fda530ab-e925-460e-ab88-63199ef975e9",
      parallelId: null,
    } as Partial<PortfolioHolding>);

    const req = buildEstimateRequestFromHolding(holding);

    expect(req.parallelId).toBeUndefined();
  });

  it("back-compat: unpinned holding (no cardId) still omits parallelId cleanly", () => {
    const holding = holdingWith({
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "Topps Chrome",
    });

    const req = buildEstimateRequestFromHolding(holding);

    expect(req.parallelId).toBeUndefined();
    expect(req.cardId).toBeUndefined();
    expect(req.pinnedAuthoritative).toBe(false);
  });
});
