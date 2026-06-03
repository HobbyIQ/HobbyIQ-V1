// CF-ERP-EXPANSION-#4 (2026-06-03): 1099-K reconciliation + accounting export.

import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_EXPORT_COLUMNS,
  buildAccountingExport,
  buildAccountingRows,
  buildTaxFilingReport,
} from "../src/services/portfolioiq/erpTaxAccounting.service.js";
import type { TaxFiling } from "../src/repositories/taxFilings.repository.js";
import type { LedgerEntryForErp, HoldingsById } from "../src/services/portfolioiq/erpReconciliation.service.js";

function ebay(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "L",
    userId: "u",
    holdingId: "h",
    playerName: "Skenes",
    cardTitle: "2024 Topps Chrome",
    quantitySold: 1,
    unitSalePrice: 100,
    grossProceeds: 100,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 80,
    costBasisSold: 40,
    realizedProfitLoss: 60,
    realizedProfitLossPct: 150,
    soldAt: "2025-05-10T12:00:00Z",
    source: "ebay",
    paymentMethod: "ebay_managed",
    salesChannel: "ebay",
    finalValueFee: 13,
    paymentProcessingFee: 4,
    promotedListingFee: 0,
    adFee: 0,
    otherFees: 0,
    actualShippingCost: 3,
    netPayout: 80,
    needsReconciliation: false,
    ...over,
  };
}

function paypal(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    ...ebay({ id: "L-pp", paymentMethod: "paypal", source: "manual", salesChannel: "instagram" }),
    finalValueFee: undefined as any,
    paymentProcessingFee: undefined as any,
    fees: 5,
    ...over,
  };
}

const HOLDINGS: HoldingsById = {};

describe("buildTaxFilingReport — 1099-K per-rail", () => {
  it("joins ledger rows by effective paymentMethod against reported gross", () => {
    const ledger = [ebay({ id: "L1", grossProceeds: 1000 }), paypal({ id: "L2", grossProceeds: 500 })];
    const filing: TaxFiling = {
      userId: "u",
      taxYear: 2025,
      rails: { ebay: { reportedGross1099K: 1100 }, paypal: { reportedGross1099K: 500 } },
      updatedAt: "2026-06-03T00:00:00Z",
    };
    const r = buildTaxFilingReport(ledger, filing, 2025);
    const ebayRow = r.rails.find((x) => x.rail === "ebay")!;
    const paypalRow = r.rails.find((x) => x.rail === "paypal")!;
    expect(ebayRow.ledgerGross).toBe(1000);
    expect(ebayRow.reported1099K).toBe(1100);
    expect(ebayRow.delta).toBe(100);
    expect(paypalRow.delta).toBe(0);
  });

  it("legacy source=ebay rows (no paymentMethod) still join to ebay rail", () => {
    const ledger = [
      ebay({ id: "L1", grossProceeds: 200, paymentMethod: undefined as any }),
    ];
    const filing: TaxFiling = {
      userId: "u", taxYear: 2025,
      rails: { ebay: { reportedGross1099K: 200 } },
      updatedAt: "2026-06-03T00:00:00Z",
    };
    const r = buildTaxFilingReport(ledger, filing, 2025);
    const ebayRow = r.rails.find((x) => x.rail === "ebay")!;
    expect(ebayRow.ledgerGross).toBe(200);
    expect(ebayRow.delta).toBe(0);
  });

  it("unreconciled rows ARE excluded from ledgerGross + surfaced on the rail", () => {
    const ledger = [
      ebay({ id: "L1", grossProceeds: 100 }),
      ebay({ id: "L2", grossProceeds: 500, needsReconciliation: true }),
    ];
    const r = buildTaxFilingReport(ledger, null, 2025);
    const ebayRow = r.rails.find((x) => x.rail === "ebay")!;
    expect(ebayRow.ledgerGross).toBe(100);
    expect(ebayRow.unreconciledExcluded).toBe(1);
  });

  it("trade-disposal rows (paymentMethod=trade) are NOT pulled into 1099-K rails", () => {
    const ledger = [
      ebay({ id: "L1", grossProceeds: 200 }),
      // Trade disposal — should be excluded from rails entirely.
      ebay({ id: "L2", grossProceeds: 50, paymentMethod: "trade", salesChannel: "in_person", source: "manual" }),
    ];
    const r = buildTaxFilingReport(ledger, null, 2025);
    const ebayRow = r.rails.find((x) => x.rail === "ebay")!;
    expect(ebayRow.ledgerGross).toBe(200);  // 50 trade NOT included
  });

  it("returns null reported + null delta when user hasn't entered 1099-K yet", () => {
    const r = buildTaxFilingReport([ebay({ grossProceeds: 100 })], null, 2025);
    expect(r.rails.find((x) => x.rail === "ebay")?.reported1099K).toBeNull();
    expect(r.rails.find((x) => x.rail === "ebay")?.delta).toBeNull();
  });
});

describe("buildAccountingExport — locked column map", () => {
  it("column order matches the spec", () => {
    expect(ACCOUNTING_EXPORT_COLUMNS).toEqual([
      "date", "payee", "account", "memo", "amount", "journal_type",
      "reference", "debit_account", "credit_account", "ledger_entry_id",
    ]);
  });

  it("emits 4 rows per eBay sale (income + fees + shipping + COGS), each pointing at ledger_entry_id", () => {
    const rows = buildAccountingRows(ebay({ id: "L-1" }), undefined);
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.account)).toEqual(["Sales Income", "Selling Fees", "Shipping Expense", "Cost of Goods Sold"]);
    expect(rows.every((r) => r.ledger_entry_id === "L-1")).toBe(true);
  });

  it("trade-disposal rows tag tradeId in the memo + reference", () => {
    const rows = buildAccountingRows(
      ebay({ id: "L-trade", tradeId: "T-1", paymentMethod: "trade", finalValueFee: 0, paymentProcessingFee: 0, actualShippingCost: 0, salesChannel: "in_person", source: "manual" }),
      undefined,
    );
    expect(rows[0].memo).toMatch(/TRADE T-1/);
    expect(rows[0].reference).toBe("T-1");
  });

  it("CSV row 0 is the header; body excludes unreconciled", () => {
    const r = buildAccountingExport([ebay({ id: "L1" }), ebay({ id: "L2", needsReconciliation: true })], HOLDINGS);
    expect(r.csv.split("\n")[0]).toBe(ACCOUNTING_EXPORT_COLUMNS.join(","));
    // Only L1's 4 lines in body.
    expect(r.csv.split("\n").length).toBe(5);  // header + 4
    expect(r.json.excluded.count).toBe(1);
  });
});
