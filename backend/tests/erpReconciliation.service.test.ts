// CF-ERP-RECONCILIATION (2026-06-03): pure-service coverage.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import {
  aggregatePnl,
  allGranularFeesKnown,
  buildTaxExport,
  buildTaxExportRow,
  deriveCostsStatus,
  isReconciled,
  listUnreconciled,
  missingFeeFields,
  TAX_EXPORT_COLUMNS,
  tryFinalizeReconciliation,
  type LedgerEntryForErp,
  type HoldingsById,
} from "../src/services/portfolioiq/erpReconciliation.service.js";

function manual(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "L-manual",
    userId: "u",
    holdingId: "h-manual",
    playerName: "Shohei Ohtani",
    cardTitle: "2018 Topps Update Rookie",
    quantitySold: 1,
    unitSalePrice: 200,
    grossProceeds: 200,
    fees: 30,
    tax: 0,
    shipping: 5,
    netProceeds: 165,
    costBasisSold: 100,
    realizedProfitLoss: 65,
    realizedProfitLossPct: 65,
    soldAt: "2026-04-15T12:00:00Z",
    source: "manual",
    ...over,
  };
}

function ebayReconciled(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "L-ebay-ok",
    userId: "u",
    holdingId: "h-ebay-ok",
    playerName: "Paul Skenes",
    cardTitle: "2024 Topps Chrome",
    quantitySold: 1,
    unitSalePrice: 300,
    grossProceeds: 300,
    fees: 0,           // legacy aggregate is 0 for eBay rows
    tax: 0,
    shipping: 0,
    netProceeds: 240,
    costBasisSold: 100,
    realizedProfitLoss: 140,
    realizedProfitLossPct: 140,
    soldAt: "2026-05-10T12:00:00Z",
    source: "ebay",
    ebayOrderId: "ORDER-123",
    finalValueFee: 35,
    paymentProcessingFee: 8,
    promotedListingFee: 0,
    adFee: 0,
    otherFees: 0,
    netPayout: 257,
    actualShippingCost: 17,
    suppliesCost: null,
    gradingCost: null,
    needsReconciliation: false,
    ...over,
  };
}

function ebayPending(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  // eBay sale where Finances API hasn't reported granular fees yet — NULL
  // fields, needsReconciliation=true. Must be EXCLUDED from totals.
  return {
    ...ebayReconciled({
      id: "L-ebay-pending",
      holdingId: "h-ebay-pending",
      playerName: "Aaron Judge",
      cardTitle: "2017 Topps Update RC",
      grossProceeds: 1000,
      netProceeds: 0,
      costBasisSold: 200,
      realizedProfitLoss: 0,
      realizedProfitLossPct: 0,
      finalValueFee: null,
      paymentProcessingFee: null,
      promotedListingFee: null,
      adFee: null,
      otherFees: null,
      netPayout: null,
      actualShippingCost: null,
      needsReconciliation: true,
      ebayOrderId: "ORDER-789",
      soldAt: "2026-06-01T12:00:00Z",
    }),
    ...over,
  };
}

const HOLDINGS: HoldingsById = {
  "h-manual": {
    id: "h-manual",
    playerName: "Shohei Ohtani",
    cardYear: 2018,
    setName: "Topps Update",
    purchaseDate: "2024-04-01",
    gradeCompany: "PSA",
    gradeValue: 10,
  },
  "h-ebay-ok": {
    id: "h-ebay-ok",
    playerName: "Paul Skenes",
    cardYear: 2024,
    setName: "Topps Chrome",
    purchaseDate: "2025-09-15",
    // raw — no gradeCompany
  } as PortfolioHolding,
  "h-ebay-pending": {
    id: "h-ebay-pending",
    playerName: "Aaron Judge",
    cardYear: 2017,
    setName: "Topps Update",
    purchaseDate: 1717209600000, // ms epoch — test the numeric-purchaseDate branch
    gradeCompany: "BGS",
    gradeValue: 9.5,
  },
};

// ─── isReconciled + missingFeeFields ────────────────────────────────────────

describe("isReconciled", () => {
  it("manual entry is always reconciled", () => {
    expect(isReconciled(manual())).toBe(true);
  });
  it("eBay entry with needsReconciliation=false is reconciled", () => {
    expect(isReconciled(ebayReconciled())).toBe(true);
  });
  it("eBay entry with needsReconciliation=true is unreconciled (dismissed or not)", () => {
    expect(isReconciled(ebayPending())).toBe(false);
    expect(isReconciled(ebayPending({ dismissedAt: "2026-06-02T00:00:00Z" }))).toBe(false);
  });
});

describe("missingFeeFields", () => {
  it("reconciled entry returns []", () => {
    expect(missingFeeFields(manual())).toEqual([]);
    expect(missingFeeFields(ebayReconciled())).toEqual([]);
  });
  it("ebay unreconciled returns specific NULL field names", () => {
    const fields = missingFeeFields(ebayPending());
    expect(fields).toEqual(
      expect.arrayContaining([
        "finalValueFee",
        "paymentProcessingFee",
        "promotedListingFee",
        "adFee",
        "otherFees",
        "netPayout",
        "actualShippingCost",
      ]),
    );
  });
});

// ─── listUnreconciled ──────────────────────────────────────────────────────

describe("listUnreconciled", () => {
  it("returns only unreconciled (dismissed are hidden, but counted)", () => {
    const dismissed = ebayPending({
      id: "L-dismissed",
      dismissedAt: "2026-06-02T00:00:00Z",
    });
    const r = listUnreconciled([manual(), ebayReconciled(), ebayPending(), dismissed]);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].id).toBe("L-ebay-pending");
    expect(r.counts.unreconciledTotal).toBe(2);
    expect(r.counts.dismissedHidden).toBe(1);
  });
  it("attaches missingFields to each row", () => {
    const r = listUnreconciled([ebayPending()]);
    expect(r.entries[0].missingFields).toContain("finalValueFee");
  });
});

// ─── aggregatePnl ──────────────────────────────────────────────────────────

describe("aggregatePnl — EXCLUDES unreconciled from totals", () => {
  const entries = [manual(), ebayReconciled(), ebayPending()];

  it("totals sum reconciled only; unreconciled count surfaced separately", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "month" });
    // Manual: gross=200, fees=30, ship=5, net=165, cost=100, gain=65
    // eBay-ok: gross=300, fees=35+8=43, ship=17, net=240, cost=100, gain=140
    // Pending: EXCLUDED
    expect(r.totals.grossProceeds).toBeCloseTo(500, 2);
    expect(r.totals.feesTotal).toBeCloseTo(73, 2);
    expect(r.totals.shipping).toBeCloseTo(22, 2);
    expect(r.totals.netProceeds).toBeCloseTo(405, 2);
    expect(r.totals.realizedProfitLoss).toBeCloseTo(205, 2);
    expect(r.totals.entryCount).toBe(2);
    expect(r.excluded.unreconciledCount).toBe(1);
    expect(r.excluded.unreconciledOldestSoldAt).toBe(ebayPending().soldAt);
  });

  it("groupBy=month buckets by YYYY-MM ascending", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "month" });
    expect(r.groups.map((g) => g.key)).toEqual(["2026-04", "2026-05"]);
    expect(r.groups[0].totals.entryCount).toBe(1);
    expect(r.groups[1].totals.entryCount).toBe(1);
  });

  it("groupBy=player buckets by playerName lowercased", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "player" });
    expect(r.groups.map((g) => g.label).sort()).toEqual(["Paul Skenes", "Shohei Ohtani"]);
  });

  it("groupBy=set joins holding.setName via holdingId", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "set" });
    const labels = r.groups.map((g) => g.label).sort();
    expect(labels).toEqual(["Topps Chrome", "Topps Update"]);
  });

  it("groupBy=grade categorizes raw vs graded via holding.gradeCompany/Value", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "grade" });
    const labels = r.groups.map((g) => g.label).sort();
    expect(labels).toEqual(["PSA 10", "Raw"]);
  });

  it("groupBy=source separates manual vs eBay", () => {
    const r = aggregatePnl(entries, HOLDINGS, { groupBy: "source" });
    const labels = r.groups.map((g) => g.label).sort();
    expect(labels).toEqual(["Manual", "eBay"]);
  });

  it("date window from/to clamps entries", () => {
    const r = aggregatePnl(entries, HOLDINGS, {
      from: "2026-05-01",
      to: "2026-05-31",
      groupBy: "month",
    });
    expect(r.totals.entryCount).toBe(1);
    expect(r.totals.grossProceeds).toBeCloseTo(300, 2);
    expect(r.window.from).toBe("2026-05-01");
    expect(r.window.to).toBe("2026-05-31");
  });

  it("empty ledger yields zero totals + zero excluded", () => {
    const r = aggregatePnl([], {}, { groupBy: "month" });
    expect(r.totals.entryCount).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.excluded.unreconciledCount).toBe(0);
  });

  it("DISMISSED-but-flagged rows STAY EXCLUDED — dismiss is UI-quieting only", () => {
    const dismissed = ebayPending({
      id: "L-dismissed",
      dismissedAt: "2026-06-02T00:00:00Z",
      dismissedReason: "no receipt",
    });
    const r = aggregatePnl([manual(), dismissed], HOLDINGS, { groupBy: "month" });
    // Dismissed entry must NOT appear in totals.
    expect(r.totals.entryCount).toBe(1);
    expect(r.totals.grossProceeds).toBeCloseTo(200, 2);
    // But the excluded counter STILL captures it (it's still incomplete data).
    expect(r.excluded.unreconciledCount).toBe(1);
  });
});

// ─── buildTaxExport ────────────────────────────────────────────────────────

describe("buildTaxExport — locked columns + CSV shape", () => {
  it("column order is the locked spec", () => {
    expect(TAX_EXPORT_COLUMNS).toEqual([
      "sale_date",
      "date_acquired",
      "asset_description",
      "player_name",
      "set_name",
      "card_year",
      "grade",
      "source",
      "proceeds_gross",
      "fee_total",
      "shipping_cost",
      "grading_cost",
      "supplies_cost",
      "proceeds_net",
      "cost_basis",
      "realized_gain_loss",
      "holding_period_days",
      "ebay_order_id",
    ]);
  });

  it("CSV row 0 is the header (NO banner); body excludes unreconciled", () => {
    const entries = [manual(), ebayReconciled(), ebayPending()];
    const r = buildTaxExport(entries, HOLDINGS);
    const lines = r.csv.split("\n");
    expect(lines[0]).toBe(TAX_EXPORT_COLUMNS.join(","));
    // Body has exactly 2 rows (manual + ebayReconciled); pending EXCLUDED.
    expect(lines.length).toBe(3);
    expect(r.json.rows.length).toBe(2);
    expect(r.json.excluded.count).toBe(1);
  });

  it("date_acquired pulls from holding.purchaseDate; holding_period_days computed", () => {
    const row = buildTaxExportRow(manual(), HOLDINGS["h-manual"]);
    expect(row.sale_date).toBe("2026-04-15");
    expect(row.date_acquired).toBe("2024-04-01");
    // 2024-04-01 → 2026-04-15 = ~744 days
    const days = Number(row.holding_period_days);
    expect(days).toBeGreaterThan(700);
    expect(days).toBeLessThan(800);
  });

  it("missing holding → date_acquired/set_name/card_year/grade BLANK (no fabricated 'Raw')", () => {
    const orphan = manual({ id: "L-orphan", holdingId: "missing" });
    const row = buildTaxExportRow(orphan, undefined);
    expect(row.date_acquired).toBe("");
    expect(row.holding_period_days).toBe("");
    expect(row.set_name).toBe("");
    expect(row.card_year).toBe("");
    // Orphaned holding: blank, NOT "Raw". A holding that exists but lacks
    // grade fields IS known to be raw (separate test).
    expect(row.grade).toBe("");
  });

  it("existing holding without grade fields → grade='Raw' (genuine signal, not fabrication)", () => {
    // h-ebay-ok has no gradeCompany/gradeValue — but the holding exists,
    // so 'Raw' is the correct label.
    const row = buildTaxExportRow(ebayReconciled(), HOLDINGS["h-ebay-ok"]);
    expect(row.grade).toBe("Raw");
  });

  it("eBay row populates fee_total from granular fields + ebay_order_id", () => {
    const row = buildTaxExportRow(ebayReconciled(), HOLDINGS["h-ebay-ok"]);
    expect(row.fee_total).toBe("43.00"); // 35 + 8
    expect(row.shipping_cost).toBe("17.00");
    expect(row.source).toBe("ebay");
    expect(row.ebay_order_id).toBe("ORDER-123");
    expect(row.grade).toBe("Raw");
  });

  it("DISMISSED-but-flagged rows are EXCLUDED from CSV", () => {
    const dismissed = ebayPending({
      id: "L-dismissed",
      dismissedAt: "2026-06-02T00:00:00Z",
    });
    const r = buildTaxExport([manual(), dismissed], HOLDINGS);
    expect(r.json.rows.length).toBe(1);
    expect(r.json.rows[0].sale_date).toBe("2026-04-15");
    expect(r.json.excluded.count).toBe(1);
  });

  it("numeric purchaseDate (ms epoch) → ISO date_acquired", () => {
    const row = buildTaxExportRow(ebayPending(), HOLDINGS["h-ebay-pending"]);
    // The fact that buildTaxExportRow accepts the row (independent of
    // reconciled-filtering at the export level) lets us check the
    // numeric-epoch path.
    expect(row.date_acquired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("CSV escapes embedded commas/quotes/newlines", () => {
    const tricky = manual({
      id: "L-tricky",
      cardTitle: 'card with "quotes", commas',
    });
    const r = buildTaxExport([tricky], HOLDINGS);
    const lines = r.csv.split("\n");
    expect(lines[1]).toContain('"card with ""quotes"", commas"');
  });

  it("date window from/to clamps export rows", () => {
    const entries = [manual(), ebayReconciled()];
    const r = buildTaxExport(entries, HOLDINGS, { from: "2026-05-01", to: "2026-05-31" });
    expect(r.json.rows.length).toBe(1);
    expect(r.json.rows[0].sale_date).toBe("2026-05-10");
    expect(r.json.window.from).toBe("2026-05-01");
    expect(r.json.window.to).toBe("2026-05-31");
  });

  it("empty ledger yields header-only CSV + empty JSON rows", () => {
    const r = buildTaxExport([], {});
    expect(r.csv).toBe(TAX_EXPORT_COLUMNS.join(","));
    expect(r.json.rows).toEqual([]);
    expect(r.json.excluded.count).toBe(0);
  });
});

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16) ──────────────────────────

describe("allGranularFeesKnown", () => {
  it("all 7 fees non-null → true", () => {
    expect(allGranularFeesKnown(ebayReconciled())).toBe(true);
  });
  it("any null fee → false", () => {
    expect(allGranularFeesKnown(ebayPending())).toBe(false);
    expect(allGranularFeesKnown(ebayReconciled({ otherFees: null }))).toBe(false);
    expect(allGranularFeesKnown(ebayReconciled({ netPayout: null }))).toBe(false);
  });
});

describe("tryFinalizeReconciliation", () => {
  it("both axes met → flips flag + sets reconciledVia from feeSource", () => {
    const seeded: LedgerEntryForErp = {
      ...ebayPending(),
      finalValueFee: 32, paymentProcessingFee: 8, promotedListingFee: 0,
      adFee: 0, otherFees: 1.5, netPayout: 208.5, actualShippingCost: 5,
      feeSource: "ebay_finances",
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
      needsReconciliation: true,
    };
    const r = tryFinalizeReconciliation(seeded);
    expect(r.needsReconciliation).toBe(false);
    expect(r.reconciledVia).toBe("ebay_finances");
  });
  it("axis 1 only (no marker) → flag stays true, reconciledVia undefined", () => {
    const seeded: LedgerEntryForErp = {
      ...ebayPending(),
      finalValueFee: 32, paymentProcessingFee: 8, promotedListingFee: 0,
      adFee: 0, otherFees: 1.5, netPayout: 208.5, actualShippingCost: 5,
      feeSource: "ebay_finances",
      needsReconciliation: true,
    };
    const r = tryFinalizeReconciliation(seeded);
    expect(r.needsReconciliation).toBe(true);
    expect(r.reconciledVia).toBeUndefined();
  });
  it("axis 2 only (marker set, fees null) → flag stays true", () => {
    const r = tryFinalizeReconciliation({
      ...ebayPending(),
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
    });
    expect(r.needsReconciliation).toBe(true);
  });
  it("neither axis → flag stays true", () => {
    const r = tryFinalizeReconciliation(ebayPending());
    expect(r.needsReconciliation).toBe(true);
  });
  it("already finalized → idempotent no-op (returns input unchanged)", () => {
    const input = ebayReconciled();
    const r = tryFinalizeReconciliation(input);
    expect(r.needsReconciliation).toBe(false);
    expect(r.reconciledVia).toBe(input.reconciledVia);
    expect(r).toBe(input); // same reference — no allocation when no-op
  });
  it("non-eBay (manual) entry → no-op even when both axes set", () => {
    const r = tryFinalizeReconciliation({
      ...manual(),
      finalValueFee: 1, paymentProcessingFee: 1, promotedListingFee: 1,
      adFee: 1, otherFees: 1, netPayout: 1, actualShippingCost: 1,
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
      needsReconciliation: true,
    });
    expect(r.needsReconciliation).toBe(true);
  });
  it("feeSource=manual_override → reconciledVia=manual_override", () => {
    const r = tryFinalizeReconciliation({
      ...ebayPending(),
      finalValueFee: 32, paymentProcessingFee: 8, promotedListingFee: 0,
      adFee: 0, otherFees: 0, netPayout: 210, actualShippingCost: 5,
      feeSource: "manual_override",
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
    });
    expect(r.reconciledVia).toBe("manual_override");
  });
});

describe("deriveCostsStatus + listUnreconciled costsStatus + P&L exclusion (invariant a)", () => {
  it("marker unset → 'needs_action'", () => {
    expect(deriveCostsStatus(ebayPending())).toBe("needs_action");
  });
  it("marker set → 'saved_pending_fees'", () => {
    expect(deriveCostsStatus({
      ...ebayPending(),
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
    })).toBe("saved_pending_fees");
  });
  it("listUnreconciled surfaces both costsStatus buckets", () => {
    const a = { ...ebayPending(), id: "a" }; // needs_action
    const b = {
      ...ebayPending(),
      id: "b",
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
    };
    const r = listUnreconciled([a, b]);
    expect(r.entries.find((e) => e.id === "a")!.costsStatus).toBe("needs_action");
    expect(r.entries.find((e) => e.id === "b")!.costsStatus).toBe("saved_pending_fees");
  });
  it("INVARIANT A — costs-saved-but-fees-pending entry is EXCLUDED from /pnl aggregation", () => {
    // Costs saved (axis 2 ✓) but fees still null (axis 1 ✗) → needsReconciliation
    // stays true → must NOT be folded into aggregatePnl totals.
    const pending = {
      ...ebayPending(),
      gradingCost: 25,
      suppliesCost: 2,
      userCostsProvidedAt: "2026-06-10T00:00:00Z",
      userCostsProvidedBy: "u",
      // fees still all null
    };
    const reconciled = ebayReconciled();
    const pnl = aggregatePnl(
      [pending, reconciled, manual()],
      HOLDINGS,
      { groupBy: "month" },
    );
    expect(pnl.excluded.unreconciledCount).toBe(1);
    // Reconciled + manual entries contribute; pending one does NOT.
    expect(pnl.totals.entryCount).toBe(2);
    // Sanity: pending.grossProceeds (1000) did NOT enter totals.
    expect(pnl.totals.grossProceeds).toBe(
      reconciled.grossProceeds + manual().grossProceeds,
    );
  });
});
