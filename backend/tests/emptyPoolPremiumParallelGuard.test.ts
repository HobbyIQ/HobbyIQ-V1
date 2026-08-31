// CF-UNKNOWN-TIER-IS-NOT-A-DENOMINATOR (2026-08-31).
//
// The case: a platform user holds
//   hiq:baseball:2025:bowman-chrome:cpa-dt:black-refractor:auto
// (Devin Taylor 2025 Bowman Draft Chrome Prospect Auto, Black), holding
// 60a7cfcc, user-5e1a90ea. The app showed ~$3 for a card whose own ladder
// trades $15-$45 at base auto and $37-$135 at refractor /499.
//
// Verified prod facts:
//   - NO catalog row exists for the black auto under bowman-chrome OR
//     bowman-draft, so the identity never resolves;
//   - the exact pool for that slug is 0 rows;
//   - ZERO black-titled CPA-DT sales exist anywhere;
//   - junk neighbours: bdc-135 NON-AUTO rows at $0.79-$2.
//
// WHERE THE $3 CAME FROM — measured, not assumed. Both engine paths are
// already honest here: oneValuationPath.valueIdentity returns
// fmv=null/reason="identity-not-in-catalog", and hobbyIqFmv's ladder
// returns no-basis (its CF-CATALOG-GAP-NO-BASIS guard names this very
// card). The number is produced further out, in the /price-by-id and
// /search response decorator applyAutoProjectionFallbacks
// (routes/compiq.routes.ts), at Layer 4's parallel-tier ratio:
//
//     projected = anchorLatestSale × trendFactor × (targetTier / anchorTier)
//
// autoProjectVariantTier collapses two different facts onto the number 1:
// "this is a base card" and "we could not read this parallel". With no
// catalog row the black auto's variant arrives EMPTY, so targetTier = 1
// (unmatched), while a legitimate same-player auto sibling anchors at a
// real tier — Black Refractor 21, Superfractor 35. The ratio then DIVIDES
// a premium anchor by its own tier:
//
//     $37 × 1.0 × (1/21) = $1.76
//     $45 × 1.0 × (1/21) = $2.14
//     $60 × 1.0 × (1/21) = $2.86
//     $96 × 1.0 × (1/35) = $2.74      ← the ~$3 the user saw
//
// Safe as a numerator, catastrophic as a denominator. The fix refuses the
// rung when the target's parallel could not be classified, on both Layer 4
// and the Layer 2 base × flat-auto-premium rung beneath it (which crosses
// the auto AND cardNumber boundaries with no parallel term at all).
//
// HOW THIS SUITE PINS IT (rewritten 2026-08-31 after the verifier proved the
// first version did not). The guard is NOT in autoProjectVariantTier or
// isClassifiedVariantTier — those helpers are honest on their own and were
// honest BEFORE the fix. The guard is three branches inside
// applyAutoProjectionFallbacks. A suite that only calls the helpers and
// re-derives `!classified(target) && tier(anchor) > 1` inline is testing its
// own arithmetic: disable all three shipped branches and it stays green.
//
// So every assertion below DRIVES THE REAL applyAutoProjectionFallbacks with
// the cardhedge client mocked, and asserts on the mutation it makes to `est`:
// predictedPrice null (and source still "no-recent-comps") in the collapse
// cases, non-null (and source "projected") in the healthy shapes. Mutation-
// checked: with the three guard branches disabled, the collapse cases go RED.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── The cardhedge client is the only I/O applyAutoProjectionFallbacks does.
// Layer 4 calls searchCards (sibling autos) + getPricesByCard (their series);
// Layer 2 calls searchCards (same-year base) + getPricesByCard. The 365d
// phantom/direct-anchor probe at the top also calls getPricesByCard.
const searchCards = vi.fn();
const getPricesByCard = vi.fn();

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return {
    ...actual,
    searchCards: (...args: unknown[]) => searchCards(...args),
    getPricesByCard: (...args: unknown[]) => getPricesByCard(...args),
  };
});

type Card = {
  card_id: string;
  player?: string;
  set?: string;
  number?: string;
  variant?: string;
  year?: number | string;
};
type DailyPrice = { closing_date: string; price: number };

// ── The CPA-DT fixture. Devin Taylor, 2025 Bowman Draft Chrome, prospect
// autos. The target is the Black auto whose identity never resolved, so its
// `variant` arrives empty from the catalog miss.
const YEAR = 2025;
const SET = "2025 Bowman Draft Chrome Baseball";
const PLAYER = "Devin Taylor";
const TARGET_CARD_ID = "ch-cpa-dt-black";

/** A daily Raw series with a flat trend (trendFactor pins to 1.0), ending on
 *  `latest`. 30 points so both the 14d recent and 14d prior slices are full
 *  and equal — the projection is then exactly latest × 1.0 × tierRatio. */
function flatSeries(latest: number, n = 30): DailyPrice[] {
  return Array.from({ length: n }, (_, i) => ({
    closing_date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
    price: latest,
  }));
}

/** The est object /price-by-id and /search hand the decorator: an auto card
 *  with an empty pool. `variant` is what the catalog resolved (empty string
 *  for the CPA-DT black auto — no row exists). */
function estFor(variant: string | null, number = "CPA-DT"): Record<string, unknown> {
  return {
    source: "no-recent-comps",
    compsAvailable: 0,
    cardIdentity: {
      card_id: TARGET_CARD_ID,
      player: PLAYER,
      year: YEAR,
      number,
      variant,
    },
  };
}

/** Wire the mocks for a Layer 4 run: one sibling auto at `anchorVariant`
 *  whose flat series ends at `anchorLatestSale`. The target itself has zero
 *  365d history (the phantom note path), so the run falls to Layer 4. */
function wireSiblingAnchor(anchorVariant: string, anchorLatestSale: number): void {
  const sibling: Card = {
    card_id: "ch-cpa-sibling",
    player: PLAYER,
    set: SET,
    number: "CPA-XX",
    variant: anchorVariant,
  };
  searchCards.mockResolvedValue([sibling]);
  getPricesByCard.mockImplementation(async (cardId: string) =>
    cardId === sibling.card_id ? flatSeries(anchorLatestSale) : [],
  );
}

/** Wire the mocks for a Layer 2 run: NO auto sibling exists, only a same-year
 *  non-auto Base card with ≥3 Raw prices. Layer 4 finds nothing and falls
 *  through to base × flat-auto-premium. */
function wireBaseAnchorOnly(basePrices: number[]): void {
  const base: Card = {
    card_id: "ch-bdc-135-base",
    player: PLAYER,
    set: SET,
    number: "BDC-135",
    variant: "Base",
    year: YEAR,
  };
  searchCards.mockResolvedValue([base]);
  getPricesByCard.mockImplementation(async (cardId: string) =>
    cardId === base.card_id
      ? basePrices.map((price, i) => ({
          closing_date: `2026-07-${String(i + 1).padStart(2, "0")}`,
          price,
        }))
      : [],
  );
}

let applyAutoProjectionFallbacks: (
  est: Record<string, unknown>,
  query: string,
) => Promise<void>;

beforeEach(async () => {
  searchCards.mockReset();
  getPricesByCard.mockReset();
  ({ applyAutoProjectionFallbacks } = await import("../src/routes/compiq.routes.js"));
});

describe("Layer 4 sibling anchor: a premium anchor is never divided by its own tier", () => {
  // These are the exact numbers the user saw. Each one is a real sibling sale
  // scaled by (unreadable target tier 1 / premium anchor tier) — the collapse.
  const collapses: Array<{ anchor: string; sale: number; wouldHaveBeen: number }> = [
    { anchor: "Black Refractor", sale: 37, wouldHaveBeen: 1.76 },
    { anchor: "Black Refractor", sale: 45, wouldHaveBeen: 2.14 },
    { anchor: "Black Refractor", sale: 60, wouldHaveBeen: 2.86 },
    { anchor: "Superfractor", sale: 96, wouldHaveBeen: 2.74 },
  ];

  for (const c of collapses) {
    it(`refuses ${c.anchor} $${c.sale} → unreadable target (would have published ~$${c.wouldHaveBeen})`, async () => {
      wireSiblingAnchor(c.anchor, c.sale);
      const est = estFor(""); // the CPA-DT black auto: catalog miss, no variant

      await applyAutoProjectionFallbacks(est, "devin taylor 2025 bowman cpa-dt black");

      // The whole point: blank beats a fabricated number.
      expect(est.predictedPrice ?? null).toBeNull();
      expect(est.predictedPriceRange ?? null).toBeNull();
      expect(est.predictedPriceAttribution ?? null).toBeNull();
      // And the response stays honestly labelled, not upgraded to "projected".
      expect(est.source).toBe("no-recent-comps");
    });
  }

  it("refuses a whitespace-only variant the same way as an absent one", async () => {
    wireSiblingAnchor("Gold Refractor", 50);
    const est = estFor("   ");
    await applyAutoProjectionFallbacks(est, "cpa-dt blank variant");
    expect(est.predictedPrice ?? null).toBeNull();
    expect(est.source).toBe("no-recent-comps");
  });

  it("refuses a parallel word the tier map has never seen — fails closed, not as Base", async () => {
    wireSiblingAnchor("Black Refractor", 40);
    const est = estFor("Vaporfractor Ultra");
    await applyAutoProjectionFallbacks(est, "cpa-dt vaporfractor");
    expect(est.predictedPrice ?? null).toBeNull();
    expect(est.source).toBe("no-recent-comps");
  });
});

describe("Layer 4 sibling anchor: the healthy shapes still price, and still scale", () => {
  it("HEALTHY 1 — base anchor → premium target scales UP and is labelled", async () => {
    // The rung's original purpose. Base anchor tier 1, Black Refractor 21.
    wireSiblingAnchor("Base", 20);
    const est = estFor("Black Refractor");

    await applyAutoProjectionFallbacks(est, "cpa-dt black refractor");

    expect(est.predictedPrice).not.toBeNull();
    expect(est.predictedPrice).toBeCloseTo(20 * 21, 6);
    expect(est.predictedPrice as number).toBeGreaterThan(20);
    expect(est.source).toBe("projected");
    const attr = est.predictedPriceAttribution as Record<string, unknown>;
    expect(attr.mechanism).toBe("sibling_auto_latest_x_trend");
    expect(attr.parallelMultiplier).toBeCloseTo(21, 6);
  });

  it("HEALTHY 2 — both sides classified: premium anchor → premium target prices the real ladder distance", async () => {
    // Black Refractor 21 → Superfractor 35. Scaling between two readings is
    // exactly what the rung is for; the guard must not touch it.
    wireSiblingAnchor("Black Refractor", 96);
    const est = estFor("Superfractor");

    await applyAutoProjectionFallbacks(est, "cpa-dt superfractor");

    expect(est.predictedPrice).toBeCloseTo(96 * (35 / 21), 6);
    expect(est.source).toBe("projected");
  });

  it("HEALTHY 3 — premium anchor → EXPLICIT Base target still prices (a Base reading is a reading)", async () => {
    // "Base" is classified even though its tier is also 1. The guard keys on
    // classification, not on the number — this is the distinction the whole
    // fix rests on, and it must stay priceable.
    wireSiblingAnchor("Black Refractor", 42);
    const est = estFor("Base");

    await applyAutoProjectionFallbacks(est, "cpa-dt base auto");

    expect(est.predictedPrice).toBeCloseTo(42 * (1 / 21), 6);
    expect(est.source).toBe("projected");
  });

  it("HEALTHY 4 — base anchor → unreadable target: no premium exists to collapse, so it prices at 1×", async () => {
    // Anchor tier 1 means there is no premium being divided away. The guard's
    // condition includes `anchorTier > UNKNOWN_VARIANT_TIER` precisely so this
    // case survives — refusing it would strip coverage for no safety gain.
    wireSiblingAnchor("Base", 30);
    const est = estFor("");

    await applyAutoProjectionFallbacks(est, "cpa-dt unknown off base anchor");

    expect(est.predictedPrice).toBeCloseTo(30, 6);
    expect(est.source).toBe("projected");
  });
});

describe("Layer 2 base × flat auto premium: no parallel term at all, so an unread parallel refuses", () => {
  it("refuses the CPA-DT black auto rather than pricing it like every other unread CPA-DT parallel", async () => {
    wireBaseAnchorOnly([0.79, 1.5, 2.0]); // the junk bdc-135 non-auto neighbours
    const est = estFor("");

    await applyAutoProjectionFallbacks(est, "devin taylor cpa-dt black");

    expect(est.predictedPrice ?? null).toBeNull();
    expect(est.predictedPriceAttribution ?? null).toBeNull();
    expect(est.source).toBe("no-recent-comps");
  });

  it("refuses an unknown parallel word on the Layer 2 rung too", async () => {
    wireBaseAnchorOnly([10, 12, 14]);
    const est = estFor("Vaporfractor Ultra");
    await applyAutoProjectionFallbacks(est, "cpa-dt vaporfractor base rung");
    expect(est.predictedPrice ?? null).toBeNull();
    expect(est.source).toBe("no-recent-comps");
  });

  it("HEALTHY — a null variant (nothing claimed at all) still gets the flat auto premium", async () => {
    // The Layer 2 branch guards on `ciVariant !== null && !classified`. A card
    // that names no parallel is not a card naming an unreadable one; the flat
    // 40×/50× rung is the long-standing behaviour for it and must survive.
    wireBaseAnchorOnly([10, 12, 14]);
    const est = estFor(null);

    await applyAutoProjectionFallbacks(est, "cpa-dt no variant claimed");

    expect(est.predictedPrice).toBeCloseTo(12 * 40, 6); // median 12 × CPA-class 40×
    expect(est.source).toBe("projected");
    const attr = est.predictedPriceAttribution as Record<string, unknown>;
    expect(attr.mechanism).toBe("base_x_auto_premium");
  });

  it("HEALTHY — an explicit Base target still gets the flat auto premium", async () => {
    wireBaseAnchorOnly([10, 12, 14]);
    const est = estFor("Base");
    await applyAutoProjectionFallbacks(est, "cpa-dt explicit base");
    expect(est.predictedPrice).toBeCloseTo(12 * 40, 6);
    expect(est.source).toBe("projected");
  });
});

describe("the guard is scoped to the projection stack, not to pricing at large", () => {
  it("a target with real 365d history of its own prices from that history, unreadable parallel or not", async () => {
    // The extended-window direct anchor runs BEFORE the tier rungs and uses
    // the target's OWN sales — no anchor, no ratio, nothing to collapse. An
    // unread parallel must not suppress it.
    searchCards.mockResolvedValue([]);
    getPricesByCard.mockImplementation(async (cardId: string, _g: string, days: number) =>
      cardId === TARGET_CARD_ID && days === 365
        ? [
            { closing_date: "2026-05-01", price: 77 },
            { closing_date: "2026-07-01", price: 125 },
          ]
        : [],
    );
    const est = estFor("");

    await applyAutoProjectionFallbacks(est, "cpa-dt with own thin history");

    expect(est.predictedPrice).not.toBeNull();
    expect(est.source).toBe("projected");
    const attr = est.predictedPriceAttribution as Record<string, unknown>;
    expect(attr.mechanism).toBe("target_extended_window_direct");
  });

  it("a non-auto card is not in the stack's scope at all — untouched, whatever its variant", async () => {
    wireSiblingAnchor("Black Refractor", 96);
    const est = estFor("", "BDC-135"); // not an auto prefix

    await applyAutoProjectionFallbacks(est, "bdc-135 non auto");

    expect(est.predictedPrice ?? null).toBeNull();
    expect(est.source).toBe("no-recent-comps");
    // Not merely refused — never entered. No I/O was done.
    expect(searchCards).not.toHaveBeenCalled();
    expect(getPricesByCard).not.toHaveBeenCalled();
  });
});
