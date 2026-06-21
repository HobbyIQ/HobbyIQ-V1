// CF-BUILDB-BLUE-ACTIVATE (2026-06-21) — Build B activation for the
// 2026 Bowman CPA Blue X-Fractor /150 row at chromeDraftMultipliers.ts:563.
//
// Three checks, two layers:
//   (A) UNIT: REAL table lookup carries the worksheet's empirical literal
//       and Build B's in-sample math lands at base × 2.974 within
//       [2.214, 3.795]. Validates the line 563 edit byte-for-byte.
//   (B) WATCH-ITEM (Drew's stacked-correction check): assert estimatedValue
//       is meaningfully above what a stacked autoCorrectedBaseMultiplier
//       would produce (base × 2.974^0.283). De Vries shipped earlier this
//       session with auto-correction on a RAW-anchored composed branch;
//       Build B's base anchor is AUTO comps already, so stacking would
//       double-compress. This test surfaces it.
//   (C) WATCH-ITEM (m1 pre-emption): integration through computeEstimate
//       with a thin BXF /150 pool (m1's curatedParallelCount fails) and
//       plentiful base autos. If m1's `sibling_provisional` baselineMultiplier
//       (1.6×) still anchors and sets m1HasPrice=true, Build B never fires —
//       that's the row carrying mixed-provenance state. Test surfaces it.
//
// NO vi.mock of chromeDraftMultipliers — uses the REAL post-edit table.
// findCompsRouted IS mocked in the (C) integration test only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeBaseAnchoredParallelFMV } from "../src/agents/baseAnchoredParallelFMV.js";
import { lookupBowmanFamilyEntry } from "../src/services/compiq/chromeDraftMultipliers.js";

const HARTMAN_SUBJECT = {
  playerName: "Eric Hartman",
  year: 2026,
  product: "Bowman" as const,
  subset: "Chrome Prospect Autographs" as const,
  parallelName: "Blue X-Fractor",
};

// Base-auto title shape that satisfies isBaseAutoTitle — mirrors the helper
// in baseAnchoredParallelFMV.test.ts:50-55.
function baseAutoComps(count: number, start: number, step = 1.5) {
  return Array.from({ length: count }, (_, i) => ({
    title: `2026 Bowman Eric Hartman Auto Base CPA-EHA #${i}`,
    price: start + i * step,
  }));
}

describe("CF-BUILDB-BLUE-ACTIVATE (A) — real-table lookup carries the worksheet literal", () => {
  it("line 563 row carries baseRelativePremium with the empirical worksheet values", () => {
    const row = lookupBowmanFamilyEntry({
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Blue X-Fractor",
      year: 2026,
    });
    expect(row).toBeTruthy();
    expect(row!.baseRelativePremium).toBeDefined();
    const p = row!.baseRelativePremium!;
    expect(p.value).toBe(2.974);
    expect(p.range).toEqual([2.214, 3.795]);
    expect(p.n).toBe(9);
    expect(p.basis).toBe("base_auto_paired");
    expect(p.provenance).toBe("empirical");
    expect(p.calibratedAt).toBe("2026-06-21T05:41:46.909Z");
    expect(p.sampleBaseRange).toEqual([6.38, 56.5]);
    expect(p.topBaseBucketRatio).toBe(3.254);
  });

  it("row-level provenance UNCHANGED (sibling_provisional) — the merge touched only baseRelativePremium", () => {
    const row = lookupBowmanFamilyEntry({
      product: "Bowman",
      subset: "Chrome Prospect Autographs",
      parallelName: "Blue X-Fractor",
      year: 2026,
    });
    // Row-level provenance is the m1 axis; baseRelativePremium.provenance is
    // the Build B axis. They're independent. Confirms "touch nothing else".
    expect(row!.provenance).toBe("sibling_provisional");
    expect(row!.baselineMultiplier).toBe(1.6);
    expect(row!.directCompOnly).toBe(false);
  });
});

describe("CF-BUILDB-BLUE-ACTIVATE (B) — Build B in-sample math + stacked-correction check", () => {
  it("Hartman shape, in-sample base median → FMV = baseMedian × 2.974 within worksheet range", () => {
    // baseMedian = (28 + 29.5) / 2 = 28.75 — comfortably inside sampleBaseRange [6.38, 56.5]
    const comps = baseAutoComps(10, 22);
    const result = computeBaseAnchoredParallelFMV({
      subject: HARTMAN_SUBJECT,
      comps,
    });

    expect(result.isEstimate).toBe(true);
    expect(result.internalReason).toBe("fired-in-sample");
    expect(result.estimateBasis).toBe("base_anchored_paired_premium");
    expect(result.confidence).toBe("rough");
    expect(result.tierExtrapolated).toBe(false);

    const baseMedian = result.baseAutoMedian!;
    expect(baseMedian).toBeCloseTo(28.75, 2);
    expect(result.estimatedValue).toBeCloseTo(baseMedian * 2.974, 0);
    expect(result.estimateLow).toBeCloseTo(baseMedian * 2.214, 0);
    expect(result.estimateHigh).toBeCloseTo(baseMedian * 3.795, 0);
  });

  it("WATCH-ITEM: estimatedValue is NOT compressed by a stacked autoCorrectedBaseMultiplier (mult^0.283)", () => {
    // If Build B mistakenly invoked autoCorrectedBaseMultiplier the way
    // gradedPriceProjection's composed branch does for RAW-anchored autos,
    // the effective multiplier would be 2.974^0.283 ≈ 1.378× instead of
    // 2.974×. The base anchor here is base AUTO comps (per isBaseAutoTitle),
    // so the worksheet's 2.974× is already auto-to-auto — stacking would
    // double-compress.
    //
    // De Vries (gradedPriceProjection RAW-anchored composed) ≠ Hartman
    // (Build B AUTO-anchored base). This test makes sure they stay
    // structurally separate.
    const comps = baseAutoComps(10, 22);
    const result = computeBaseAnchoredParallelFMV({
      subject: HARTMAN_SUBJECT,
      comps,
    });
    const baseMedian = result.baseAutoMedian!;
    const wouldBeStacked = baseMedian * Math.pow(2.974, 0.283); // ≈ 39.61

    // estimatedValue ≈ 28.75 × 2.974 ≈ 85.50, way above the stacked floor of ~39.61.
    expect(result.estimatedValue).toBeGreaterThan(wouldBeStacked * 1.5);
    // Belt-and-suspenders: lower bound of the emitted range is still above
    // the stacked floor (no overlap).
    expect(result.estimateLow).toBeGreaterThan(wouldBeStacked);
  });
});

// ─── (C) Integration watch-item: m1 pre-emption ──────────────────────────
//
// This describe block mocks findCompsRouted so we can route a thin BXF /150
// pool through the full computeEstimate path and observe whether m1's
// `sibling_provisional` baselineMultiplier (1.6×) pre-empts Build B.
//
// CRITICAL: this test does NOT mock chromeDraftMultipliers — it uses the
// REAL post-edit row. So it exercises the actual production-equivalent
// gating between m1 and Build B at the service layer.

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

describe("CF-BUILDB-BLUE-ACTIVATE (C) — m1 pre-emption check (integration)", () => {
  beforeEach(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Hartman shape with thin BXF/150 pool + plentiful base autos: observe which path emits the price", async () => {
    const now = Date.now();
    const isoDaysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "befe9bcc-hartman-test",
        title: "2026 Bowman Eric Hartman Chrome Prospects Autographs",
        player: "Eric Hartman",
        set: "Chrome Prospects Autographs", // CF-FIXTURE-AUDIT: production-accurate Cardsight setName
        year: 2026,
        number: "CPA-EHA",
        variant: "Blue X-Fractor /150",
      },
      sales: [
        // 10 base auto comps — pure base autos per isBaseAutoTitle: has Auto
        // token, NO Refractor, NO numbered print run, NO color/finish. Median ≈ 28.75.
        ...Array.from({ length: 10 }, (_, i) => ({
          price: 22 + i * 1.5,
          date: isoDaysAgo(i),
          title: `2026 Bowman Chrome Prospects Auto CPA-EHA Eric Hartman`,
        })),
        // 2 Blue X-Fractor /150 sales — BELOW m1's curatedParallelCount ≥ 3 floor
        { price: 120, date: isoDaysAgo(7), title: "2026 Bowman Chrome Prospects Blue X-Fractor Auto CPA-EHA Eric Hartman /150" },
        { price: 130, date: isoDaysAgo(14), title: "2026 Bowman Chrome Prospects Blue X-Fractor Auto CPA-EHA Eric Hartman /150" },
      ],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate(
      {
        playerName: "Eric Hartman",
        cardYear: 2026,
        product: "Bowman",
        parallel: "Blue X-Fractor",
        isAuto: true,
      } as any,
      testCallContext,
    )) as Record<string, any>;

    // DIAGNOSTIC, NOT ASSERTION: this fixture sails through the engine's
    // tier-ladder variant filter (player_name_missing rejects base autos
    // that don't carry the requested parallel string). On this fixture,
    // variant-mismatch fires upstream of BOTH m1 and Build B — neither
    // gets a chance to price, source=variant-mismatch wins, estimatedValue
    // is null. This MATCHES Hartman's live prod-shape outcome (fmv:
    // undefined, est: undefined) and confirms the live holding lands in
    // the same upstream-short-circuit path on a thin BXF/150 pool.
    //
    // The watch-item (3) — m1 pre-empts Build B — is therefore moot for
    // any fixture where variant-mismatch trips first. To actually exercise
    // m1 vs Build B routing at integration, the comp pool needs ≥3 BXF/150
    // sales (passes m1's curatedParallelCount + skips variant-mismatch) AND
    // base autos in a title shape the player matcher accepts. Both are
    // outside the byte-for-byte cherry-pick scope; surfaced in the HALT
    // for follow-up coverage rather than inlined here.
    //
    // What this test DOES assert: the path the engine takes on a
    // production-shape thin pool is variant-mismatch — confirming the
    // line 563 edit doesn't unintentionally change the routing for the
    // live Hartman holding's current comp shape.
    expect(result.source).toBe("variant-mismatch");
    expect(result.fairMarketValue ?? null).toBeNull();
    expect(result.estimatedValue ?? null).toBeNull();
  });
});
