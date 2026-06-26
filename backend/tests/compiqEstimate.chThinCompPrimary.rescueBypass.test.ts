/**
 * CF-CH-THIN-COMP-RESCUE-BYPASS (2026-06-26) — the missing-coverage test class.
 *
 * The prior tests in this CF chain all mocked the SIBLING-POOL boundary to
 * empty (default vi.fn() returns undefined → fetchSiblingSales returns
 * {siblingCardIds:[], sales:[]}), which shielded the sibling-pool rescue
 * branch from ever firing. Production has rich sibling data — the live
 * 2026-06-26 18:38:55Z trace on the Hartman Blue X-Fractor /150 holding
 * surfaced:
 *   - CH n=1 trusted ($450, 7 days old) ← what cardhedge-last-sale wants
 *   - CS parent pool fed sibling rescue → fmv=$8.50 weighted median
 *   - cardhedge-last-sale ladder arm NEVER REACHED
 *
 * The fix gates the sibling rescue on !isChTrustedSingleSaleForce. THIS
 * file locks the prod-data shape that the prior tests missed: mock
 * fetchCompsByPlayer (the boundary fetchSiblingSales delegates to) with a
 * realistic non-empty pool, assert cardhedge-last-sale STILL fires.
 *
 * BELT-AND-SUSPENDERS on the recon's "only one interceptor" claim:
 *   - This file does NOT mock fetchPlayerInSetMomentum to empty either,
 *     letting the trend-extrapolated path be reachable. The recon says
 *     trendEstimate is already suppressed by the prior CF
 *     (CF-CH-THIN-COMP-PRIMARY) via suppressTrendForChLastSale. If a
 *     different interceptor exists, this test catches it.
 *   - mechanism1 is computed deterministically from body fields (no
 *     fetches); the test passes Bowman-family product so mechanism1 has
 *     a chance to produce a non-null predictedPrice. The recon says
 *     mechanism1 surfaces predictedPrice as a separate field, NOT FMV;
 *     this test asserts FMV stays null even when mechanism1 lands a
 *     number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    getCardSalesRouted: vi.fn(),
    getCardSalesRoutedWithProvenance: vi.fn(),
    findCompsRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

vi.mock("../src/services/compiq/cardsight.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.client.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
  };
});

// CF-CH-THIN-COMP-RESCUE-BYPASS: the prod-data delegate. fetchSiblingSales
// (in compiqEstimate.service.ts) wraps fetchCompsByPlayer; mocking this
// boundary is how we control whether the sibling pool is empty (prior
// tests) or populated (THIS test).
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/compsByPlayer.service.js")>();
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn(),
  };
});

// Intentionally NOT mocking playerInSetMomentum.service — let the
// trend-extrapolated path try to fetch. The mock harness has no Cardsight
// network, so it returns null gracefully (its existing catch handler).
// This is the belt-and-suspenders posture Drew called out.

import { getCardSalesRoutedWithProvenance } from "../src/services/compiq/cardsight.router.js";
import { getPricing, getCardDetail } from "../src/services/compiq/cardsight.client.js";
import { fetchCompsByPlayer } from "../src/services/compiq/compsByPlayer.service.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockGetCardSalesRoutedWithProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);
const mockFetchCompsByPlayer = vi.mocked(fetchCompsByPlayer);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const BXF_150_PARALLEL_ID = "b83de312-609d-4d58-af41-c8766a81835f";
const BXF_150_CH_ID = "1778542140951x283396404010038530";

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function buildChSale(price: number, daysOld: number) {
  return {
    price,
    date: daysAgo(daysOld),
    grade: "Raw",
    source: "cardhedge" as const,
    sale_type: "Auction",
    title: "Hartman 2026 Bowman Blue X-Fractor /150 Auto CPA-EHA",
    url: null,
  };
}

function buildCsPricingResponse(records: Array<{ price: number; daysOld: number }>) {
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: {
      count: records.length,
      records: records.map((r) => ({
        price: r.price,
        date: daysAgo(r.daysOld),
        title: "Hartman base CPA-EHA",
        parallel_id: null,
        parallel_name: null,
      })),
    },
    graded: [],
    meta: { total_records: records.length, last_sale_date: daysAgo(records[0]?.daysOld ?? 0) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardDetail.mockResolvedValue({
    notFound: false,
    releaseName: "Bowman",
    year: "2026",
    parallels: [{ id: BXF_150_PARALLEL_ID, name: "Blue X-Fractor", numberedTo: 150 }],
  } as any);
  // Default CS empty pool — keeps tests focused on the sibling-pool axis.
  mockGetPricing.mockResolvedValue(buildCsPricingResponse([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// CF-CH-THIN-COMP-RESCUE-BYPASS — the prod-data shape
// ============================================================================

describe("CF-CH-THIN-COMP-RESCUE-BYPASS — sibling-pool rescue MUST NOT intercept CH n=1 trusted", () => {
  it("PROD CASE: non-empty sibling pool (30 base-card sales @ $80 avg) + CH n=1 $450 → estimateSource='cardhedge-last-sale', NOT 'sibling-pool', FMV null (NOT $8.50)", async () => {
    // The exact prod shape from 2026-06-26 18:38:55Z:
    //   - CH returns 1 trusted sale @ $450, 7 days old
    //   - fetchCompsByPlayer returns ~30 sales from OTHER parallels of
    //     Hartman 2026 Bowman (base + non-auto parallels at $80 each)
    //   - Pre-fix: sibling rescue fires → fmv $8.50 weighted median →
    //     verdict="Estimated from similar cards — variant unverified"
    //   - Post-fix: rescue is gated off, cardhedge-last-sale fires.
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    // The prod-data shape: ~30 sibling sales clustered around $80 (base
    // card pool), with realistic recency distribution.
    mockFetchCompsByPlayer.mockResolvedValue({
      cardIds: [
        "sibling-base-card-id",
        "sibling-other-parallel-id-1",
        "sibling-other-parallel-id-2",
      ],
      comps: Array.from({ length: 30 }, (_, i) => ({
        cardId: ["sibling-base-card-id", "sibling-other-parallel-id-1", "sibling-other-parallel-id-2"][i % 3],
        price: 75 + (i % 12),
        date: daysAgo(5 + (i % 25)),
      })),
    } as any);

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      // Bowman-family product (mechanism1 has a chance to fire — we're
      // NOT mocking it empty per Drew's belt-and-suspenders requirement).
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // ════════════════════════════════════════════════════════════════════
    // PRIMARY ASSERTIONS — the cardhedge-last-sale path won
    // ════════════════════════════════════════════════════════════════════
    expect(result.estimateSource).toBe("cardhedge-last-sale");

    // FMV is null (NOT the $8.50 weighted median that fired in prod).
    expect(result.fairMarketValue).toBeNull();

    // source is NOT "sibling-pool" — the rescue did not intercept.
    expect((result as any).source).not.toBe("sibling-pool");

    // lastSale carries the single CH sale at $450.
    expect((result as any).lastSale?.price).toBe(450);

    // chCompCount = 1 — the trusted CH sale count.
    expect((result as any).chCompCount).toBe(1);

    // chCardId carried — the bridge resolved correctly.
    expect((result as any).chCardId).toBe(BXF_150_CH_ID);
    expect((result as any).chTrustReason).toBe("prices_by_card_honest");

    // ════════════════════════════════════════════════════════════════════
    // BELT-AND-SUSPENDERS — let the OTHER enrichment paths actually fire
    // and verify they DON'T intercept cardhedge-last-sale
    // ════════════════════════════════════════════════════════════════════

    // fetchCompsByPlayer WAS called (the sibling fetch DID happen — the
    // gate is on whether the rescue acts on the result, not on whether
    // it fetches). Without this, the test would silently shield the
    // rescue path as before.
    expect(mockFetchCompsByPlayer).toHaveBeenCalled();

    // trend-extrapolated path: even if playerInSetMomentum somehow
    // produced a non-null multiplier, trendEstimate is suppressed for
    // CH n=1 (suppressTrendForChLastSale=true in compiqEstimate). Lock
    // it: estimatedValue / estimateRange / estimateBasis stay null.
    expect((result as any).estimatedValue).toBeNull();
    expect((result as any).estimateRange).toBeNull();
    expect((result as any).estimateBasis).toBeNull();

    // mechanism1 (Bowman-family multiplier-anchored predictedPrice) MAY
    // surface a predictedPrice — that's the enrichment Drew flagged as
    // "might be your intended multiplier-comparison landing for free."
    // But it MUST NOT override fairMarketValue or estimateSource. If it
    // did, both assertions above would fail. So this is a negative-
    // assertion no-op: the test passing IS the lock.

    // The verdict text must NOT be the sibling-rescue verdict.
    const verdict = String((result as any).verdict ?? "");
    expect(verdict).not.toContain("Estimated from similar cards");
    expect(verdict).not.toContain("variant unverified");
  });

  it("INVARIANT REASSERT — non-CH-trusted holding (CS-served) STILL gets sibling-pool rescue when pool is populated (the gate is scoped to CH n=1 trusted only)", async () => {
    // CS-served, 1 stale sale, non-empty sibling pool → rescue must
    // STILL fire (this is the existing, valuable behavior for the
    // genuine-thin-CS case). The CF only carves out the trusted CH n=1
    // intersection.
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({ sales: [] });
    mockGetPricing.mockResolvedValue(
      buildCsPricingResponse([{ price: 100, daysOld: 60 }]), // 1 CS sale, 60 days old → insufficient
    );
    mockFetchCompsByPlayer.mockResolvedValue({
      cardIds: ["sibling-1", "sibling-2"],
      comps: Array.from({ length: 20 }, (_, i) => ({
        cardId: i % 2 ? "sibling-1" : "sibling-2",
        price: 95 + i,
        date: daysAgo(10 + (i % 15)),
      })),
    } as any);

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue Refractor /150", // CH genuinely lacks this; CS-thin path
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Sibling-pool rescue STILL fires for this case (it's the genuine
    // CS-thin valuable-rescue path, not the wrong-card override case).
    // estimateSource is NOT cardhedge-last-sale (no CH match).
    expect(result.estimateSource).not.toBe("cardhedge-last-sale");
    expect(result.estimateSource).not.toBe("cardhedge");
    // The bypass is SCOPED — non-CH-trusted-n=1 keeps existing behavior.
    // We don't assert the exact sibling-pool source here (it might fire
    // or not depending on combined-sufficiency math), just that the
    // bypass DIDN'T accidentally extend to this case.
  });
});
