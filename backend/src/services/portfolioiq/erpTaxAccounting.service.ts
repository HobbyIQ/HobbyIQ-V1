// CF-ERP-EXPANSION-#4 (2026-06-03): 1099-K per-rail reconciliation +
// QuickBooks/Xero-mapped accounting export. Pure functions over
// (ledger, holdingsById, filing) — testable without Cosmos/Express.

import type {
  TaxFiling,
  TaxFilingRail,
} from "../../repositories/taxFilings.repository.js";
import {
  effectivePaymentMethod,
  isReconciled,
  type HoldingsById,
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";

const RAIL_PAYMENT_METHODS: Record<TaxFilingRail, "ebay_managed" | "paypal" | "venmo"> = {
  ebay: "ebay_managed",
  paypal: "paypal",
  venmo: "venmo",
};

export interface RailReconciliation {
  rail: TaxFilingRail;
  reported1099K: number | null;       // null when user hasn't entered yet
  ledgerGross: number;
  delta: number | null;               // reported - ledger; null when not entered
  deltaPct: number | null;            // delta / reported × 100
  ledgerEntryCount: number;
  unreconciledExcluded: number;
  note?: string;
}

export interface TaxFilingReport {
  taxYear: number;
  rails: RailReconciliation[];
  totals: {
    reported1099K: number | null;
    ledgerGross: number;
    delta: number | null;
  };
  updatedAt: string | null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inYear(soldAtIso: string, taxYear: number): boolean {
  const y = Number(soldAtIso.slice(0, 4));
  return y === taxYear;
}

export function buildTaxFilingReport(
  ledger: ReadonlyArray<LedgerEntryForErp>,
  filing: TaxFiling | null,
  taxYear: number,
): TaxFilingReport {
  const yearly = ledger.filter((e) => inYear(e.soldAt, taxYear));

  const rails: RailReconciliation[] = [];
  for (const rail of ["ebay", "paypal", "venmo"] as TaxFilingRail[]) {
    const target = RAIL_PAYMENT_METHODS[rail];
    const railEntries = yearly.filter((e) => effectivePaymentMethod(e) === target);
    const reconciledOnRail = railEntries.filter(isReconciled);
    const unreconciledOnRail = railEntries.filter((e) => !isReconciled(e));
    const ledgerGross = reconciledOnRail.reduce((acc, e) => acc + (e.grossProceeds ?? 0), 0);

    const entry = filing?.rails?.[rail];
    const reported = entry ? entry.reportedGross1099K : null;
    const delta = reported !== null ? r2(reported - ledgerGross) : null;
    const deltaPct = reported !== null && reported > 0 ? r2((delta! / reported) * 100) : null;

    rails.push({
      rail,
      reported1099K: reported,
      ledgerGross: r2(ledgerGross),
      delta,
      deltaPct,
      ledgerEntryCount: reconciledOnRail.length,
      unreconciledExcluded: unreconciledOnRail.length,
      note: entry?.note,
    });
  }

  const totalsReported = rails.reduce<number | null>(
    (acc, r) => (acc === null && r.reported1099K === null ? null
      : (acc ?? 0) + (r.reported1099K ?? 0)),
    null,
  );
  const totalsLedger = rails.reduce((acc, r) => acc + r.ledgerGross, 0);
  const totalsDelta = totalsReported !== null ? r2(totalsReported - totalsLedger) : null;

  return {
    taxYear,
    rails,
    totals: {
      reported1099K: totalsReported !== null ? r2(totalsReported) : null,
      ledgerGross: r2(totalsLedger),
      delta: totalsDelta,
    },
    updatedAt: filing?.updatedAt ?? null,
  };
}

// ─── Accounting export (QuickBooks / Xero–friendly journal) ─────────────────

export const ACCOUNTING_EXPORT_COLUMNS = [
  "date",
  "payee",
  "account",
  "memo",
  "amount",
  "journal_type",
  "reference",
  "debit_account",
  "credit_account",
  "ledger_entry_id",
] as const;

export interface AccountingRow {
  date: string;
  payee: string;
  account: string;
  memo: string;
  amount: string;
  journal_type: string;
  reference: string;
  debit_account: string;
  credit_account: string;
  ledger_entry_id: string;
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function entryFeeTotal(e: LedgerEntryForErp): number {
  if (e.source === "ebay") {
    return (
      (e.finalValueFee ?? 0) +
      (e.paymentProcessingFee ?? 0) +
      (e.promotedListingFee ?? 0) +
      (e.adFee ?? 0) +
      (e.otherFees ?? 0)
    );
  }
  return e.fees ?? 0;
}

function entryShipping(e: LedgerEntryForErp): number {
  if (e.source === "ebay") return e.actualShippingCost ?? 0;
  return e.shipping ?? 0;
}

export function buildAccountingRows(
  e: LedgerEntryForErp,
  _h: import("../../types/portfolioiq.types.js").PortfolioHolding | undefined,
): AccountingRow[] {
  const date = e.soldAt.slice(0, 10);
  const tradeMemo = e.tradeId ? ` (TRADE ${e.tradeId})` : "";
  const baseMemo = `${e.cardTitle ?? ""} #${e.id}${tradeMemo}`;
  const payee = e.salesChannel || (e.source ?? "manual");

  const rows: AccountingRow[] = [];
  // 1) Income line — Gross sale revenue.
  rows.push({
    date,
    payee,
    account: "Sales Income",
    memo: baseMemo,
    amount: (e.grossProceeds ?? 0).toFixed(2),
    journal_type: "income",
    reference: e.ebayOrderId ?? e.tradeId ?? "",
    debit_account: "Accounts Receivable",
    credit_account: "Sales Income",
    ledger_entry_id: e.id,
  });
  // 2) Expense line — platform fees.
  const fees = entryFeeTotal(e);
  if (fees > 0) {
    rows.push({
      date,
      payee,
      account: "Selling Fees",
      memo: `Fees: ${baseMemo}`,
      amount: fees.toFixed(2),
      journal_type: "expense",
      reference: e.ebayOrderId ?? e.tradeId ?? "",
      debit_account: "Selling Fees",
      credit_account: "Accounts Receivable",
      ledger_entry_id: e.id,
    });
  }
  // 3) Shipping line — actual ship cost.
  const ship = entryShipping(e);
  if (ship > 0) {
    rows.push({
      date,
      payee,
      account: "Shipping Expense",
      memo: `Shipping: ${baseMemo}`,
      amount: ship.toFixed(2),
      journal_type: "expense",
      reference: e.ebayOrderId ?? e.tradeId ?? "",
      debit_account: "Shipping Expense",
      credit_account: "Accounts Receivable",
      ledger_entry_id: e.id,
    });
  }
  // 4) COGS line — cost basis released.
  rows.push({
    date,
    payee,
    account: "Cost of Goods Sold",
    memo: `COGS: ${baseMemo}`,
    amount: (e.costBasisSold ?? 0).toFixed(2),
    journal_type: "expense",
    reference: e.ebayOrderId ?? e.tradeId ?? "",
    debit_account: "Cost of Goods Sold",
    credit_account: "Inventory",
    ledger_entry_id: e.id,
  });
  return rows;
}

export interface AccountingExportResult {
  csv: string;
  json: {
    window: { from: string | null; to: string | null };
    columns: ReadonlyArray<(typeof ACCOUNTING_EXPORT_COLUMNS)[number]>;
    rows: AccountingRow[];
    excluded: { count: number };
  };
}

function parseDateInput(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function inWindow(soldAtIso: string, fromIso: string | null, toIso: string | null): boolean {
  const datePart = soldAtIso.slice(0, 10);
  if (fromIso && datePart < fromIso) return false;
  if (toIso && datePart > toIso) return false;
  return true;
}

export function buildAccountingExport(
  ledger: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  options: { from?: string; to?: string } = {},
): AccountingExportResult {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  const windowed = ledger.filter((e) => inWindow(e.soldAt, fromIso, toIso));
  const reconciled = windowed.filter((e) => isReconciled(e));
  const unreconciled = windowed.filter((e) => !isReconciled(e));

  const rows = reconciled
    .slice()
    .sort((a, b) => a.soldAt.localeCompare(b.soldAt))
    .flatMap((e) => buildAccountingRows(e, holdingsById[e.holdingId]));

  const header = ACCOUNTING_EXPORT_COLUMNS.join(",");
  const dataLines = rows.map((r) =>
    ACCOUNTING_EXPORT_COLUMNS.map((col) =>
      csvEscape((r as unknown as Record<string, string>)[col] ?? ""),
    ).join(","),
  );
  const csv = [header, ...dataLines].join("\n");

  return {
    csv,
    json: {
      window: { from: fromIso, to: toIso },
      columns: ACCOUNTING_EXPORT_COLUMNS,
      rows,
      excluded: { count: unreconciled.length },
    },
  };
}
