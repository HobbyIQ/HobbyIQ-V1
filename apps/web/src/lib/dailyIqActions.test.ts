// CF-DAILYIQ-ACTIONS (Drew, 2026-09-04). The action columns' doctrine, pinned.
//
// Every fixture below is built from the REAL wire shapes in api.ts — the
// pricing envelope with its `headline.valueSource`, `pricingLabels` in the
// backend's closed vocabulary, `auditFlag` as the nightly auditor writes it,
// `needsReview` + `reviewReason` from the store-door guard, and `sellSignal`
// as #1652 emits it. A test built on invented shapes would pass while the
// column showed nothing, which is the failure mode this file exists to catch.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding, PortfolioResponse } from "./api";
import {
  ATTENTION_REASON,
  attentionCount,
  attentionRowFor,
  attentionRows,
  barStats,
  isIdentityUnmatched,
  isValueWithheld,
  sellSignalRows,
  sellSignalsState,
  topMovers,
} from "./dailyIqActions";

/** A healthy, priced, matched holding — the baseline nothing should flag. */
function healthy(over: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-ok",
    hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto",
    playerName: "Termarr Johnson",
    cardYear: 2024,
    product: "Bowman Draft",
    cardNumber: "CPA-TG",
    quantity: 1,
    totalCostBasis: 100,
    totalProfitLoss: 25,
    pricing: {
      headline: { value: 125, valueSource: "observed", perUnit: 125, quantity: 1 },
    } as PortfolioHolding["pricing"],
    ...over,
  };
}

describe("pricing attention is built from the real holding meta", () => {
  it("flags nothing on a matched, priced holding", () => {
    expect(attentionRowFor(healthy())).toBeNull();
  });

  it("a withheld value is a row, in the user's words", () => {
    // The envelope priced it as cost-proxy — holdingDisplayValue refuses to
    // fall through to cost basis, so there is no value to show.
    const h = healthy({
      id: "h-withheld",
      pricing: {
        headline: { value: 90, valueSource: "cost-proxy", perUnit: 90, quantity: 1 },
      } as PortfolioHolding["pricing"],
    });
    expect(isValueWithheld(h)).toBe(true);
    const row = attentionRowFor(h);
    expect(row?.kind).toBe("value-withheld");
    expect(row?.reason).toBe("value withheld: cost-basis check");
    // Copy is the user's side, never the engine's.
    expect(row?.reason).not.toMatch(/cost-proxy|proxy|floor/i);
  });

  it("an unpriced holding — envelope says unpriced — is withheld too", () => {
    const h = healthy({
      id: "h-unpriced",
      pricing: {
        headline: { value: null, valueSource: "unpriced", perUnit: null, quantity: 1 },
      } as PortfolioHolding["pricing"],
    });
    expect(attentionRowFor(h)?.kind).toBe("value-withheld");
  });

  it("a parked holding needs a checklist match", () => {
    const h = healthy({
      id: "h-parked",
      needsReview: true,
      reviewReason: "No catalog match — pick the card in Edit to price it.",
    });
    expect(isIdentityUnmatched(h)).toBe(true);
    const row = attentionRowFor(h);
    expect(row?.kind).toBe("identity-unmatched");
    // The guard wrote a sentence for a reader; it is shown verbatim.
    expect(row?.reason).toBe("No catalog match — pick the card in Edit to price it.");
  });

  it("a holding with no slug at all is unmatched, with the generic words", () => {
    const h = healthy({ id: "h-noslug", hobbyiqCardId: null, cardId: null });
    expect(attentionRowFor(h)?.reason).toBe(ATTENTION_REASON["identity-unmatched"]);
    expect(attentionRowFor(h)?.reason).toBe("identity needs a checklist match");
  });

  it("UNVERIFIED IS NOT UNMATCHED — the whole portfolio must not land here", () => {
    // identityVerified means the OWNER confirmed a candidate. Most healthy
    // holdings never went through that gate. Treating its absence as a
    // problem would put all 43 of Drew's cards in the attention column,
    // which is the same as having no column.
    const h = healthy({ identityVerified: false });
    expect(isIdentityUnmatched(h)).toBe(false);
    expect(attentionRowFor(h)).toBeNull();
  });

  it("a low-confidence label is a row, and the wire's sentence is shown verbatim", () => {
    const h = healthy({
      id: "h-lowconf",
      pricingLabels: [
        {
          code: "low-confidence",
          text: "No independent sales in this card's pool — the price leans on one comp.",
        },
      ],
    });
    const row = attentionRowFor(h);
    expect(row?.kind).toBe("low-confidence");
    expect(row?.reason).toBe(
      "No independent sales in this card's pool — the price leans on one comp.",
    );
  });

  it("a self-anchored price is a low-confidence row (Drew: publish AND label)", () => {
    const h = healthy({
      id: "h-self",
      pricingLabels: [{ code: "self-anchored", text: "The only sale behind this is your own." }],
      selfAnchored: { own: 1, total: 1 },
    });
    expect(attentionRowFor(h)?.kind).toBe("low-confidence");
  });

  it("an audit flag is 'under review', never the invariant's code name", () => {
    const h = healthy({
      id: "h-audit",
      auditFlag: {
        reason: "BASIS-IDENTITY: cross-product",
        at: "2026-09-04T05:00:00.000Z",
        invariant: "BASIS-IDENTITY",
      },
    });
    const row = attentionRowFor(h);
    expect(row?.kind).toBe("under-review");
    expect(row?.reason).toBe("value under review");
    expect(row?.reason).not.toMatch(/BASIS-IDENTITY|invariant/i);
  });

  it("ONE ROW PER HOLDING: three problems still produce one row, the top one", () => {
    const h = healthy({
      id: "h-all",
      needsReview: true,
      pricing: {
        headline: { value: null, valueSource: "unpriced", perUnit: null, quantity: 1 },
      } as PortfolioHolding["pricing"],
      auditFlag: { reason: "X: y", at: "2026-09-04", invariant: "X" },
      pricingLabels: [{ code: "low-confidence", text: "thin" }],
    });
    const rows = attentionRows([h]);
    expect(rows).toHaveLength(1);
    // Identity outranks the rest: it is the one the owner can fix, and the
    // others may simply be its consequence.
    expect(rows[0].kind).toBe("identity-unmatched");
  });

  it("sorts most-actionable first and caps the display without losing the count", () => {
    const items = [
      healthy({ id: "a", pricingLabels: [{ code: "low-confidence", text: "t" }] }),
      healthy({ id: "b", needsReview: true }),
      healthy({ id: "c", auditFlag: { reason: "X: y", at: "d", invariant: "X" } }),
      healthy({
        id: "d",
        pricing: {
          headline: { value: null, valueSource: "unpriced", perUnit: null, quantity: 1 },
        } as PortfolioHolding["pricing"],
      }),
    ];
    expect(attentionRows(items, 2).map((r) => r.kind)).toEqual([
      "identity-unmatched",
      "value-withheld",
    ]);
    // The chip counts ALL of them — a cap is display, not measurement.
    expect(attentionCount(items)).toBe(4);
  });

  it("links each row to its holding", () => {
    expect(attentionRowFor(healthy({ id: "h 1", needsReview: true }))?.href).toBe(
      "/app/portfolio/h%201",
    );
  });
});

describe("sell signals never invent a signal, and never confuse absent with quiet", () => {
  it("NOT LIVE when no holding carries the field", () => {
    // /api/portfolio answers 200 with sellSignal simply absent until the
    // sell-window backend deploys. That is a capability state, not "none".
    expect(sellSignalsState([healthy(), healthy({ id: "b" })])).toBe("not-live");
  });

  it("NONE TODAY when the field is present and every call is none", () => {
    const quiet = healthy({
      sellSignal: {
        signal: "none",
        horizon: "none",
        signalClass: "price",
        basis: "Nothing to report.",
      },
    });
    expect(sellSignalsState([quiet])).toBe("none-today");
  });

  it("SIGNALS when at least one holding has a live call", () => {
    const hot = healthy({
      id: "h-sell",
      sellSignal: {
        signal: "sell-window",
        horizon: "days-7-14",
        signalClass: "price",
        basis: "Player index +18.2% while this card's pool moved +2.1% over 30 days.",
        measures: { divergencePct: 16.1 },
      },
    });
    expect(sellSignalsState([hot])).toBe("signals");
    const rows = sellSignalRows([hot]);
    expect(rows).toHaveLength(1);
    // The basis sentence is the evidence — verbatim, numbers and all.
    expect(rows[0].basis).toBe(
      "Player index +18.2% while this card's pool moved +2.1% over 30 days.",
    );
    // The horizon is part of the claim.
    expect(rows[0].horizon).toBe("days-7-14");
  });

  it("ranks sell windows above watches, and the wider divergence first", () => {
    const mk = (id: string, signal: "sell-window" | "watch", div: number): PortfolioHolding =>
      healthy({
        id,
        sellSignal: {
          signal,
          horizon: "days-7-14",
          signalClass: "price",
          basis: "b",
          measures: { divergencePct: div },
        },
      });
    const rows = sellSignalRows([mk("w-small", "watch", 30), mk("s-small", "sell-window", 3), mk("s-big", "sell-window", 40)]);
    expect(rows.map((r) => r.holdingId)).toEqual(["s-big", "s-small", "w-small"]);
  });

  it("drops the none rows from the list", () => {
    const rows = sellSignalRows([
      healthy({ id: "q", sellSignal: { signal: "none", horizon: "none", signalClass: "price", basis: "" } }),
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("the bar's numbers come off the summary, and it never invents a day change", () => {
  const data: PortfolioResponse = {
    success: true,
    userId: "u1",
    items: [
      healthy({ id: "v1", identityVerified: true, totalProfitLoss: 400 }),
      healthy({ id: "v2", identityVerified: true, totalProfitLoss: -900 }),
      healthy({ id: "n1", identityVerified: false, totalProfitLoss: 50 }),
      healthy({ id: "n2", totalProfitLoss: 10, needsReview: true }),
    ],
    summary: {
      totalValue: 12500,
      totalCost: 9000,
      totalGainLoss: 3500,
      totalGainLossPct: 38.9,
      cardCount: 43,
      observedValue: 12000,
      estimatedValue: 500,
      estimatedCount: 3,
      pendingCount: 1,
      observedPct: 96,
    },
  };

  it("reads value, cost basis, P&L and count straight from the summary", () => {
    const s = barStats(data);
    expect(s.totalValue).toBe(12500);
    expect(s.costBasis).toBe(9000);
    expect(s.unrealisedPL).toBe(3500);
    expect(s.unrealisedPLPct).toBe(38.9);
    expect(s.cardCount).toBe(43);
  });

  // ── CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04) ───────────────────────
  // The wire now CAN carry a previous close. Three states have to stay
  // distinguishable, and the one that is easy to get wrong is the middle one:
  // a measured flat day is a real answer and must print, while an absent
  // measurement must not print as zero.

  it("a payload with no previous close reports NULL, never zero", () => {
    // A worker that predates the field sends nothing. Absent is not $0.00 —
    // that would be a number we did not compute.
    const s = barStats(data);
    expect(s.dayChange).toBeNull();
    expect(s.dayChangePct).toBeNull();
    expect(s.dayChangeCoverage).toBeNull();
  });

  it("reads the day change off the summary and converts the pct to points", () => {
    const s = barStats({
      ...data,
      summary: {
        ...data.summary,
        previousCloseValue: 12000,
        previousCloseAt: "2026-09-04T00:00:00.000Z",
        dayChangeValue: 500,
        dayChangePct: 0.0417, // a FRACTION on the wire
        dayChangeCoverage: { holdingsWithPrior: 40, holdingsTotal: 43 },
      },
    });
    expect(s.dayChange).toBe(500);
    // Percent POINTS for formatPct — 0.0417 -> 4.17, not 0.0417.
    expect(s.dayChangePct).toBeCloseTo(4.17, 6);
    expect(s.dayChangeCoverage).toEqual({ holdingsWithPrior: 40, holdingsTotal: 43 });
  });

  it("a measured FLAT day is zero, and zero is not null", () => {
    // The distinction the whole feature rests on. $0 measured must survive
    // every falsy-check in the chain and reach the bar as a number.
    const s = barStats({
      ...data,
      summary: {
        ...data.summary,
        previousCloseValue: 12500,
        dayChangeValue: 0,
        dayChangePct: 0,
        dayChangeCoverage: { holdingsWithPrior: 43, holdingsTotal: 43 },
      },
    });
    expect(s.dayChange).toBe(0);
    expect(s.dayChange).not.toBeNull();
    expect(s.dayChangePct).toBe(0);
  });

  it("a negative day is preserved, sign and all", () => {
    const s = barStats({
      ...data,
      summary: { ...data.summary, dayChangeValue: -320.5, dayChangePct: -0.025 },
    });
    expect(s.dayChange).toBe(-320.5);
    expect(s.dayChangePct).toBeCloseTo(-2.5, 6);
  });

  it("a percentage without a dollar move is half a measurement — both or neither", () => {
    const s = barStats({
      ...data,
      summary: { ...data.summary, dayChangePct: 0.05 },
    });
    expect(s.dayChange).toBeNull();
    expect(s.dayChangePct).toBeNull();
  });

  it("counts only explicitly-verified identities", () => {
    // An absent flag is not verified — only a strict true earns the check.
    expect(barStats(data).verifiedCount).toBe(2);
  });

  it("carries the attention count for the bar's chip", () => {
    expect(barStats(data).attentionCount).toBe(1);
  });

  it("top movers are the biggest absolute moves, sign preserved", () => {
    const m = topMovers(data.items, 3);
    expect(m.map((x) => x.holdingId)).toEqual(["v2", "v1", "n1"]);
    expect(m[0].change).toBe(-900);
  });

  it("survives an empty portfolio without throwing", () => {
    expect(attentionCount([])).toBe(0);
    expect(topMovers(null)).toEqual([]);
    expect(sellSignalsState([])).toBe("not-live");
  });
});
