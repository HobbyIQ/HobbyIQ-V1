// CF-VALUATION-REPORT (Drew, 2026-09-02) — the export's pins.
//
// The four things Drew named, pinned:
//   1. the report renders the fixture portfolio with EVERY provenance
//      class present (a class that stops being reachable is a red test,
//      not a quietly missing label);
//   2. totals arithmetic — the split subtotals sum to the stated totals,
//      and quantity is actually multiplied through;
//   3. the disclaimer and every provenance label are present in the
//      rendered document;
//   4. no valuation change — the report reads holdings and never writes,
//      recomputes, or alters a value.
//
// The fixture below is the portfolio the whole feature is specified
// against: one holding of each provenance class, plus the awkward cases
// (quantity > 1, a cold exact pool, a holding with no timestamp).

import { describe, it, expect } from "vitest";
import {
  buildValuationReport,
  buildReportRow,
  classifyProvenance,
  computeTotals,
  identityLine,
  tierLabel,
  compAgeDaysOf,
  PROVENANCE_LABEL,
  PROVENANCE_LEGEND,
  type ReportProvenanceClass,
  type ReportRow,
} from "../src/services/portfolioiq/valuationReport.service.js";
import {
  renderValuationReportHtml,
  reportFilename,
  esc,
  money,
} from "../src/services/portfolioiq/valuationReportHtml.service.js";
import type { PortfolioHoldingWire } from "../src/services/portfolioiq/responseAssembly.js";

// ─── Fixture portfolio ───────────────────────────────────────────────────

/** Frozen clock so staleness and the report stamp are deterministic. */
const NOW = new Date("2026-09-02T15:00:00.000Z");
const NOW_MS = NOW.getTime();

/** ISO string for a sale `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 86_400_000).toISOString();
}

type Envelope = NonNullable<(PortfolioHoldingWire & { pricing?: unknown })["pricing"]>;

/** Minimal holding + envelope. Only the fields the report reads are set —
 *  a fixture that mirrored the full wire would hide which fields matter. */
function holding(
  over: Partial<PortfolioHoldingWire> & { pricing?: unknown } = {},
): PortfolioHoldingWire {
  return {
    id: "h-generic",
    playerName: "Test Player",
    cardYear: 2026,
    product: "Bowman Chrome",
    cardNumber: "BCP-1",
    quantity: 1,
    ...over,
  } as PortfolioHoldingWire;
}

function envelope(o: {
  headlineValue?: number | null;
  headlineSource?: string | null;
  observedFmv?: number | null;
  rung?: string | null;
  compsUsed?: number | null;
  confidence?: number | null;
  lastSaleDate?: string | null;
}): unknown {
  return {
    headline: {
      value: o.headlineValue ?? null,
      valueSource: o.headlineSource ?? "unpriced",
      perUnit: o.headlineValue ?? null,
      quantity: 1,
    },
    observed: { fairMarketValue: o.observedFmv ?? null, total: null },
    method: { kind: "our-pool", label: "", ladderRung: o.rung ?? null, compsUsed: o.compsUsed ?? null },
    confidence: { pricing: o.confidence ?? null, liquidity: null, timing: null },
    provenance: {
      vendor: "hobbyiq-pool",
      vendorUpdatedAt: null,
      pricingSource: "unified-pricing",
      pricingSourceMeta: null,
      nearestGradedAnchor: null,
      lastSaleSurface: o.lastSaleDate
        ? { price: 0, date: o.lastSaleDate, compCount: 0 }
        : null,
    },
  };
}

/**
 * THE FIXTURE PORTFOLIO. One holding per provenance class, in the order
 * the classes are defined, plus the edge cases each class has to survive.
 */
export const FIXTURE_PORTFOLIO: PortfolioHoldingWire[] = [
  // 1. OBSERVED — exact pool, fresh. The unmarked case.
  holding({
    id: "h-observed",
    playerName: "Paul Skenes",
    cardYear: 2023,
    product: "Bowman Chrome",
    cardNumber: "BDC-1",
    parallel: "Gold Refractor",
    serialNumber: "50",
    isAuto: true,
    gradeCompany: "PSA",
    gradeValue: 10,
    quantity: 1,
    totalCostBasis: 4000,
    lastUpdated: daysAgo(1),
    estimateBasis: "unified: 9 sales in 90d, trend +1.4%/wk",
    pricing: envelope({
      observedFmv: 5250,
      headlineValue: 5250,
      headlineSource: "observed",
      rung: "exact-pool-projection",
      compsUsed: 9,
      confidence: 0.91,
      lastSaleDate: daysAgo(6),
    }),
  }),

  // 2. OBSERVED with quantity > 1 — pins that qty multiplies through.
  holding({
    id: "h-observed-qty",
    playerName: "Wyatt Langford",
    cardYear: 2024,
    product: "Topps Chrome",
    cardNumber: "RA-WL",
    isAuto: true,
    quantity: 3,
    totalCostBasis: 300,
    lastUpdated: daysAgo(1),
    pricing: envelope({
      observedFmv: 125.5,
      headlineValue: 125.5,
      headlineSource: "observed",
      rung: "exact-pool-leading-edge",
      compsUsed: 5,
      confidence: 0.78,
      lastSaleDate: daysAgo(10),
    }),
  }),

  // 3. ESTIMATED — a fallback rung: real sales, wrong grade.
  holding({
    id: "h-estimated",
    playerName: "Jackson Holliday",
    cardYear: 2022,
    product: "Bowman",
    cardNumber: "BP-100",
    parallel: "Blue Refractor",
    gradeCompany: "BGS",
    gradeValue: 9.5,
    quantity: 1,
    totalCostBasis: 200,
    lastUpdated: daysAgo(2),
    estimateBasis: "grade curve: PSA 10 pool x empirical BGS 9.5 ratio",
    pricing: envelope({
      observedFmv: 310,
      headlineValue: 310,
      headlineSource: "observed",
      rung: "grade-curve-estimate",
      compsUsed: 4,
      confidence: 0.55,
      lastSaleDate: daysAgo(12),
    }),
  }),

  // 4. SPECULATIVE by RUNG — player-index-projection.
  holding({
    id: "h-speculative-rung",
    playerName: "Victor Figueroa",
    cardYear: 2021,
    product: "Bowman Chrome",
    cardNumber: "CPA-VF",
    parallel: "Red Ink",
    isAuto: true,
    serialNumber: "5",
    quantity: 1,
    totalCostBasis: 250,
    lastUpdated: daysAgo(1),
    estimateBasis:
      "Projected from Victor Figueroa's market trend — last direct sale 30 weeks ago at $278.60, "
      + "carried forward by the player index ratio 1.180x (up 18.0% since that sale) over a basket of 12 liquid cards "
      + "across all grades. Speculative: the anchor is 210 days old — this is today's market applied to an old print, "
      + "not a recent trade.",
    pricing: envelope({
      observedFmv: null,
      headlineValue: 328.75,
      headlineSource: "estimated",
      rung: "player-index-projection",
      compsUsed: 1,
      confidence: 0.35,
      lastSaleDate: daysAgo(210),
    }),
  }),

  // 5. SPECULATIVE by COLD POOL — an exact-pool rung whose newest sale is
  //    past the stale line. The rung alone would read as observed; the age
  //    is the second fact that makes it speculative.
  holding({
    id: "h-speculative-cold",
    playerName: "Termarr Johnson",
    cardYear: 2022,
    product: "Bowman Draft",
    cardNumber: "BDC-150",
    quantity: 1,
    totalCostBasis: 60,
    lastUpdated: daysAgo(3),
    pricing: envelope({
      observedFmv: 72.4,
      headlineValue: 72.4,
      headlineSource: "observed",
      rung: "exact-pool-projection",
      compsUsed: 3,
      confidence: 0.42,
      lastSaleDate: daysAgo(120),
    }),
  }),

  // 6. OWN PURCHASE — no market value; carried at cost-proxy.
  holding({
    id: "h-own-purchase",
    playerName: "Unknown Prospect",
    cardYear: 2025,
    product: "Bowman Sterling",
    cardNumber: "BSA-UP",
    isAuto: true,
    quantity: 1,
    purchasePrice: 45,
    totalCostBasis: 45,
    lastUpdated: daysAgo(5),
    pricing: envelope({
      observedFmv: null,
      headlineValue: 45,
      headlineSource: "cost-proxy",
      rung: null,
      confidence: null,
    }),
  }),

  // 7. UNPRICED — no value, no cost basis, no timestamp.
  holding({
    id: "h-unpriced",
    playerName: "No Data Player",
    cardYear: 2020,
    product: "Topps",
    cardNumber: "T-1",
    quantity: 1,
    pricing: envelope({
      observedFmv: null,
      headlineValue: null,
      headlineSource: "unpriced",
      rung: "no-basis",
      confidence: null,
    }),
  }),
];

const report = () => buildValuationReport(FIXTURE_PORTFOLIO, NOW);
const rowById = (rows: ReportRow[], id: string): ReportRow => {
  const r = rows.find((x) => x.holdingId === id);
  if (!r) throw new Error(`fixture row ${id} missing from report`);
  return r;
};

// ─── PIN 1: every provenance class renders ───────────────────────────────

describe("PIN: the fixture portfolio exercises every provenance class", () => {
  const ALL_CLASSES: ReportProvenanceClass[] = [
    "observed", "estimated", "speculative", "own-purchase", "unpriced",
  ];

  it("every class in the vocabulary is present in the fixture report", () => {
    const seen = new Set(report().rows.map((r) => r.klass));
    for (const k of ALL_CLASSES) {
      expect(seen.has(k), `class "${k}" is unreachable in the fixture portfolio`).toBe(true);
    }
  });

  it("classifies each fixture holding as its intended class", () => {
    const rows = report().rows;
    expect(rowById(rows, "h-observed").klass).toBe("observed");
    expect(rowById(rows, "h-observed-qty").klass).toBe("observed");
    expect(rowById(rows, "h-estimated").klass).toBe("estimated");
    expect(rowById(rows, "h-speculative-rung").klass).toBe("speculative");
    expect(rowById(rows, "h-speculative-cold").klass).toBe("speculative");
    expect(rowById(rows, "h-own-purchase").klass).toBe("own-purchase");
    expect(rowById(rows, "h-unpriced").klass).toBe("unpriced");
  });

  it("a cold exact-pool read is speculative, not observed", () => {
    // The doctrine case: the rung says exact-pool, so the rung ALONE would
    // read as observed. The comp age is what makes it speculative.
    const cold = FIXTURE_PORTFOLIO.find((h) => h.id === "h-speculative-cold")!;
    expect(compAgeDaysOf(cold, NOW_MS)).toBeGreaterThan(45);
    expect(classifyProvenance(cold, NOW_MS).klass).toBe("speculative");

    // Same holding, same rung, a FRESH sale → observed.
    const fresh = { ...cold, pricing: envelope({
      observedFmv: 72.4, headlineValue: 72.4, headlineSource: "observed",
      rung: "exact-pool-projection", compsUsed: 3, lastSaleDate: daysAgo(5),
    }) } as PortfolioHoldingWire;
    expect(classifyProvenance(fresh, NOW_MS).klass).toBe("observed");
  });

  it("a value that cannot be dated is never marked stale", () => {
    // No lastSaleSurface at all → null age → the row keeps its rung's class.
    const undated = holding({
      id: "h-undated",
      pricing: envelope({
        observedFmv: 100, headlineValue: 100, headlineSource: "observed",
        rung: "exact-pool-projection", compsUsed: 4,
      }),
    });
    expect(compAgeDaysOf(undated, NOW_MS)).toBeNull();
    expect(classifyProvenance(undated, NOW_MS).klass).toBe("observed");
  });

  it("an unnamed rung on an observed number is an estimate, never observed", () => {
    // fmvRung doctrine: a consumer with no label does not assume the best case.
    const unlabelled = holding({
      id: "h-unlabelled",
      pricing: envelope({
        observedFmv: 90, headlineValue: 90, headlineSource: "observed", rung: null,
      }),
    });
    expect(classifyProvenance(unlabelled, NOW_MS).klass).toBe("estimated");
  });
});

// ─── PIN 2: totals arithmetic ────────────────────────────────────────────

describe("PIN: totals arithmetic", () => {
  it("each class subtotal is the sum of its own rows", () => {
    const { rows, totals } = report();
    for (const k of Object.keys(totals.byClass) as ReportProvenanceClass[]) {
      const expected = rows
        .filter((r) => r.klass === k)
        .reduce((sum, r) => sum + (r.lineTotal ?? 0), 0);
      expect(totals.byClass[k].total, k).toBeCloseTo(expected, 2);
      expect(totals.byClass[k].count, k).toBe(rows.filter((r) => r.klass === k).length);
    }
  });

  it("marketDerivedTotal = observed + estimated + speculative", () => {
    const t = report().totals;
    expect(t.marketDerivedTotal).toBeCloseTo(
      t.byClass.observed.total + t.byClass.estimated.total + t.byClass.speculative.total,
      2,
    );
  });

  it("grandTotal = marketDerived + own-purchase, and equals the sum of every line", () => {
    const { rows, totals } = report();
    expect(totals.grandTotal).toBeCloseTo(
      totals.marketDerivedTotal + totals.byClass["own-purchase"].total, 2,
    );
    const everyLine = rows.reduce((sum, r) => sum + (r.lineTotal ?? 0), 0);
    expect(totals.grandTotal).toBeCloseTo(everyLine, 2);
  });

  it("computes the fixture's totals to the cent", () => {
    // Explicit expected values — an arithmetic change has to be stated,
    // not absorbed by a self-referential formula.
    const t = report().totals;
    expect(t.byClass.observed.total).toBeCloseTo(5250 + 125.5 * 3, 2);   // 5626.50
    expect(t.byClass.estimated.total).toBeCloseTo(310, 2);
    expect(t.byClass.speculative.total).toBeCloseTo(328.75 + 72.4, 2);   // 401.15
    expect(t.byClass["own-purchase"].total).toBeCloseTo(45, 2);
    expect(t.byClass.unpriced.total).toBeCloseTo(0, 2);
    expect(t.marketDerivedTotal).toBeCloseTo(6337.65, 2);
    expect(t.grandTotal).toBeCloseTo(6382.65, 2);
  });

  it("quantity multiplies through to the line total", () => {
    const r = rowById(report().rows, "h-observed-qty");
    expect(r.quantity).toBe(3);
    expect(r.perUnit).toBeCloseTo(125.5, 2);
    expect(r.lineTotal).toBeCloseTo(376.5, 2);
  });

  it("counts holdings and cards separately", () => {
    const t = report().totals;
    expect(t.holdingCount).toBe(FIXTURE_PORTFOLIO.length);
    // 6 singles + one qty-3 holding = 9 cards.
    expect(t.cardCount).toBe(FIXTURE_PORTFOLIO.length - 1 + 3);
    expect(t.pricedCount).toBe(t.holdingCount - t.unpricedCount);
    expect(t.unpricedCount).toBe(1);
  });

  it("unrealized gain/loss is grandTotal minus recorded cost basis", () => {
    const t = report().totals;
    const expectedBasis = 4000 + 300 + 200 + 250 + 60 + 45; // 4855
    expect(t.costBasisTotal).toBeCloseTo(expectedBasis, 2);
    expect(t.unrealizedGainLoss).toBeCloseTo(t.grandTotal - expectedBasis, 2);
  });

  it("reports no gain/loss when no cost basis was ever recorded", () => {
    const t = computeTotals([
      buildReportRow(holding({ id: "a", pricing: envelope({
        observedFmv: 10, headlineValue: 10, headlineSource: "observed",
        rung: "exact-pool-projection", lastSaleDate: daysAgo(1),
      }) }), NOW_MS),
    ]);
    expect(t.unrealizedGainLoss).toBeNull();
  });

  it("an empty portfolio totals to zero without throwing", () => {
    const empty = buildValuationReport([], NOW);
    expect(empty.rows).toHaveLength(0);
    expect(empty.totals.grandTotal).toBe(0);
    expect(empty.totals.holdingCount).toBe(0);
    expect(empty.oldestAsOf).toBeNull();
    expect(() => renderValuationReportHtml(empty)).not.toThrow();
  });
});

// ─── PIN 3: disclaimer + labels present in the document ──────────────────

describe("PIN: the rendered document carries the disclaimer and every label", () => {
  const html = () => renderValuationReportHtml(report(), { ownerLabel: "Drew" });
  /** The document's prose is line-wrapped for source readability, so
   *  sentences that matter are asserted against whitespace-collapsed text
   *  rather than the raw source. */
  const prose = () => html().replace(/\s+/g, " ");

  it("states it is a valuation opinion and NOT an appraisal", () => {
    const p = prose();
    expect(p).toContain("valuation opinion generated from market data");
    expect(p).toContain("not an appraisal");
    expect(p).toContain("not a guarantee of value");
  });

  it("carries the professional-advice and independent-appraisal language", () => {
    const p = prose();
    expect(p).toContain("not a licensed appraiser");
    expect(p).toContain("obtain an independent appraisal");
    expect(p).toContain("Past sales performance does not indicate future results");
  });

  it("prints the label of every provenance class the report contains", () => {
    const h = html();
    const present = new Set(report().rows.map((r) => r.klass));
    for (const k of present) {
      const label = PROVENANCE_LABEL[k];
      if (!label) continue; // observed is deliberately unmarked
      expect(h, `label for "${k}" missing from the document`).toContain(label);
    }
  });

  it("says SPECULATIVE and OWN PURCHASE in those words", () => {
    // Drew's rule, pinned literally: these two labels ride IN the report.
    const h = html();
    expect(h).toContain("SPECULATIVE");
    expect(h).toContain("OWN PURCHASE — NOT A MARKET VALUE");
  });

  it("explains every class it used in the basis-of-value legend", () => {
    const h = html();
    for (const k of new Set(report().rows.map((r) => r.klass))) {
      expect(h, `legend for "${k}"`).toContain(esc(PROVENANCE_LEGEND[k]));
    }
  });

  it("carries the methodology in the site's own doctrine language", () => {
    const p = prose();
    expect(p).toContain("projected next sale");
    expect(p).toContain("not the average of past sales");
    expect(p).toContain("empirical");
    // Grade monotonicity is not an invariant — the report says so.
    expect(p).toContain("not adjusted to make higher grades rank above lower ones");
    // FMV is never a median.
    expect(p).toContain("not the median of past sales");
  });

  it("shows a per-row rung phrase and the raw label for each priced row", () => {
    const h = html();
    expect(h).toContain("projected from 9 sales of this card");
    expect(h).toContain("exact-pool-projection");
    expect(h).toContain("estimate from the grade curve");
    expect(h).toContain("player-index-projection");
  });

  it("carries the generated-at date and per-row as-of stamps", () => {
    const h = html();
    expect(h).toContain("September 2, 2026");
    expect(h).toContain("Generated");
    expect(h).toContain("Valued"); // the as-of column header
  });

  it("prints totals with the market-derived split, not one blended number", () => {
    const h = html();
    expect(h).toContain("Market-derived value");
    expect(h).toContain("includes own-purchase carries");
    expect(h).toContain(money(6382.65));
  });

  it("escapes user-supplied card text", () => {
    const nasty = buildValuationReport([holding({
      id: "h-xss",
      playerName: '<script>alert("x")</script>',
      product: 'Bowman " onload="evil()',
      pricing: envelope({
        observedFmv: 10, headlineValue: 10, headlineSource: "observed",
        rung: "exact-pool-projection", lastSaleDate: daysAgo(1),
      }),
    })], NOW);
    const h = renderValuationReportHtml(nasty);
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain('onload="evil()');
  });

  it("is a self-contained document — no external stylesheet, font, or script", () => {
    const h = html();
    expect(h).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(h).not.toMatch(/<script[^>]+src=/i);
    expect(h).toContain("<!doctype html>");
  });

  it("carries the print rules that make Save-as-PDF the PDF path", () => {
    const h = html();
    expect(h).toContain("@page");
    expect(h).toContain("print-color-adjust: exact"); // labels survive the printer
    expect(h).toContain("page-break-inside: avoid");
  });

  it("names the file with the report's date", () => {
    expect(reportFilename("2026-09-02T15:00:00.000Z"))
      .toBe("hobbyiq-valuation-report-2026-09-02.html");
  });
});

// ─── PIN 4: no valuation change ──────────────────────────────────────────

describe("PIN: the report changes no valuation", () => {
  it("does not mutate the holdings it reads", () => {
    const before = JSON.stringify(FIXTURE_PORTFOLIO);
    buildValuationReport(FIXTURE_PORTFOLIO, NOW);
    renderValuationReportHtml(report());
    expect(JSON.stringify(FIXTURE_PORTFOLIO)).toBe(before);
  });

  it("prints the holding's own stored value — it never recomputes one", () => {
    // Every per-unit number in the report is traceable to a field that was
    // already on the wire. If this ever fails, the report has started
    // pricing, and canonical FMV would have two sources of truth.
    const rows = report().rows;
    expect(rowById(rows, "h-observed").perUnit).toBe(5250);
    expect(rowById(rows, "h-observed-qty").perUnit).toBe(125.5);
    expect(rowById(rows, "h-estimated").perUnit).toBe(310);
    expect(rowById(rows, "h-speculative-rung").perUnit).toBe(328.75);
    expect(rowById(rows, "h-speculative-cold").perUnit).toBe(72.4);
    expect(rowById(rows, "h-own-purchase").perUnit).toBe(45);
    expect(rowById(rows, "h-unpriced").perUnit).toBeNull();
  });

  it("is deterministic — same input and clock produce the same document", () => {
    expect(renderValuationReportHtml(buildValuationReport(FIXTURE_PORTFOLIO, NOW)))
      .toBe(renderValuationReportHtml(buildValuationReport(FIXTURE_PORTFOLIO, NOW)));
  });
});

// ─── Row shape ───────────────────────────────────────────────────────────

describe("report rows", () => {
  it("builds a readable identity line from the holding's own fields", () => {
    expect(identityLine(FIXTURE_PORTFOLIO[0]))
      .toBe("2023 Bowman Chrome #BDC-1 Paul Skenes — Gold Refractor Auto /50");
  });

  it("falls back to the card title, then to a stated placeholder", () => {
    expect(identityLine(holding({
      cardYear: undefined, product: undefined, cardNumber: undefined,
      playerName: undefined, cardTitle: "A Titled Card",
    }))).toBe("A Titled Card");
    expect(identityLine(holding({
      cardYear: undefined, product: undefined, cardNumber: undefined, playerName: undefined,
    }))).toBe("(unidentified card)");
  });

  it("labels the tier, defaulting to Raw when ungraded", () => {
    expect(tierLabel(FIXTURE_PORTFOLIO[0])).toBe("PSA 10");
    expect(tierLabel(holding({ gradeCompany: "BGS", gradeValue: 9.5 }))).toBe("BGS 9.5");
    expect(tierLabel(holding({}))).toBe("Raw");
  });

  it("sorts by line total, with unpriced rows last", () => {
    const rows = report().rows;
    expect(rows[0].holdingId).toBe("h-observed"); // the largest line
    expect(rows[rows.length - 1].klass).toBe("unpriced");
  });

  it("reports the oldest and newest as-of across the portfolio", () => {
    const r = report();
    expect(r.oldestAsOf).toBe(daysAgo(5));  // h-own-purchase
    expect(r.newestAsOf).toBe(daysAgo(1));
  });

  it("defaults a missing or invalid quantity to 1 rather than zeroing a line", () => {
    const r = buildReportRow(holding({
      quantity: undefined,
      pricing: envelope({
        observedFmv: 20, headlineValue: 20, headlineSource: "observed",
        rung: "exact-pool-projection", lastSaleDate: daysAgo(1),
      }),
    }), NOW_MS);
    expect(r.quantity).toBe(1);
    expect(r.lineTotal).toBe(20);
  });
});


// ─── CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03) ────────────────────────
//
// The "Conf." column promises, in the methodology section, that it says
// how well-evidenced the VALUE is. It was rendering the holding's
// match/identity confidence instead — the certainty that we know WHICH
// card this is, which is a different question with a different answer.
//
// Live, Drew's Greg Maddux 1987 Topps Traded Tiffany #70T rendered "100%"
// (match confidence 1.0) beside a basis line that said conf=0.37. On a
// document a reader may hand to an insurer, that is the report claiming
// evidence it does not have.
//
// These pin the shape of the fix: the column carries the ENGINE's pricing
// confidence, and it is never filled in from a match confidence.
describe("the confidence column is the PRICING confidence", () => {
  /** The live Maddux shape: identity certain, evidence thin. */
  function maddux(): PortfolioHoldingWire {
    return holding({
      id: "h-maddux",
      playerName: "Greg Maddux",
      cardYear: 1987,
      product: "Topps Traded Tiffany",
      cardNumber: "70T",
      quantity: 1,
      lastUpdated: daysAgo(2),
      // The matcher is certain which card this is.
      confidence: 1,
      catalogMatchConfidence: 1,
      estimateBasis:
        "unified: window=180d median=$120 marketValue=$118 predicted=$121 trend=flat 0.1%/wk conf=0.37",
      pricing: {
        ...(envelope({
          observedFmv: 121,
          headlineValue: 121,
          headlineSource: "observed",
          rung: "exact-pool-projection",
          compsUsed: 3,
          lastSaleDate: daysAgo(40),
        }) as Record<string, unknown>),
        // The engine's pricing confidence, where the price-writer stamps it.
        provenance: {
          vendor: "hobbyiq-pool",
          vendorUpdatedAt: null,
          pricingSource: "unified-pricing",
          pricingSourceMeta: {
            slug: "hiq:baseball:1987:topps-traded-tiffany:70t",
            method: "exact-pool-projection",
            compsUsed: 3,
            confidence: 0.37,
          },
          nearestGradedAnchor: null,
          lastSaleSurface: null,
        },
      },
    } as Partial<PortfolioHoldingWire> as never);
  }

  it("renders the engine's 37%, not the matcher's 100%", () => {
    const row = buildReportRow(maddux(), NOW_MS);
    expect(row.confidence).toBe(0.37);
    // The specific regression: match confidence must never reach this column.
    expect(row.confidence).not.toBe(1);
  });

  it("prints 37% in the row's confidence cell, and never the matcher's 100%", () => {
    const r = buildValuationReport([maddux()]);
    const html = renderValuationReportHtml(r, { ownerLabel: "Drew", includePrintButton: false });
    // Scope to the confidence cell: "100%" also occurs in the stylesheet.
    const cells = [...html.matchAll(/<td class="c-conf">([^<]*)<\/td>/g)].map(m => m[1].trim());
    expect(cells).toEqual(["37%"]);
  });

  it("renders a pricing confidence even when the holding carries no match confidence", () => {
    // The 26-of-43 population: holding.confidence unset, but the engine
    // reported a pricing confidence. These rendered "—" and should not.
    const h = maddux();
    delete (h as { confidence?: unknown }).confidence;
    delete (h as { catalogMatchConfidence?: unknown }).catalogMatchConfidence;
    expect(buildReportRow(h, NOW_MS).confidence).toBe(0.37);
  });

  it("renders a dash when no path reported a pricing confidence", () => {
    const h = holding({
      id: "h-no-conf",
      lastUpdated: daysAgo(2),
      // A match confidence is present and must NOT be borrowed.
      confidence: 0.95,
      pricing: envelope({
        observedFmv: 40,
        headlineValue: 40,
        headlineSource: "observed",
        rung: "exact-pool-projection",
        lastSaleDate: daysAgo(3),
      }),
    } as Partial<PortfolioHoldingWire> as never);
    const row = buildReportRow(h, NOW_MS);
    expect(row.confidence).toBeNull();

    const html = renderValuationReportHtml(
      buildValuationReport([h]),
      { ownerLabel: "Drew", includePrintButton: false },
    );
    // And the legend says what the dash means, so it is not read as a zero.
    expect(html).toMatch(/dash means no confidence figure was recorded/i);
  });

  it("says the column is about the value, not the card's identity", () => {
    const html = renderValuationReportHtml(
      buildValuationReport(FIXTURE_PORTFOLIO),
      { ownerLabel: "Drew", includePrintButton: false },
    );
    expect(html).toMatch(/not about the card&rsquo;s\s+identity/i);
  });
});


// The report can only render the engine's pricing confidence if the writer
// that decides a price actually stamps it. Before this change the figure
// existed only as the `conf=0.37` substring inside estimateBasis prose,
// which no consumer can read without parsing text — and types.ts already
// warns consumers never to infer structured facts from that prose.
//
// This pins the persistence end: every unified/canonical write that stamps
// a pricingSourceMeta must stamp its confidence alongside the comp count.
// A new pricing writer that forgets it silently reintroduces the "—".
describe("the price writer stamps its pricing confidence", () => {
  it("every unified pricingSourceMeta write carries a confidence", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/services/portfolioiq/portfolioStore.service.ts", import.meta.url),
      "utf8",
    );
    const writes = [...src.matchAll(/pricingSourceMeta:\s*(?:withUnionRefused\()?\{[^}]*\}/g)]
      .map(m => m[0])
      .filter(w => /compsUsed:\s*(?:u|bU|unified|unifiedResult)\./.test(w));

    // Guard the guard: if the writes move or get renamed, this test must
    // fail loudly rather than vacuously passing over an empty list.
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const w of writes) expect(w).toMatch(/confidence:/);
  });
});
