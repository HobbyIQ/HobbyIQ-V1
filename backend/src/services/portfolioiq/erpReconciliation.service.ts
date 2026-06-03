// CF-ERP-RECONCILIATION (2026-06-03): pro_seller ERP layer over the ledger.
//
// Pure aggregation + export functions over `(ledger entries, holdings-by-id)`.
// The route layer is responsible for fetching both from `readUserDoc` and
// for HTTP shape; this module is testable without Cosmos / Express.
//
// Core rule, load-bearing across every export below:
//   RECONCILED entries are folded into /pnl totals + emitted as /tax-export
//   rows. An entry is RECONCILED iff `needsReconciliation` is falsy
//   (undefined OR false). Anything else — NULL-fee eBay rows pending the
//   Finances API, or rows the user has DISMISSED to silence the prompt — is
//   EXCLUDED from totals and from the CSV. The dismissed-vs-flagged
//   distinction is a UI-quieting signal only, not a "trust as complete"
//   signal — dismissed-but-still-flagged rows STAY excluded so a user can
//   never accidentally pull incomplete-fee data into a tax total.
//
//   NULL fee fields are NEVER coerced to 0. That convention already lives in
//   the ledger type comments at portfolioStore.service.ts:227-244.
//
// Tax-export columns are locked (see TAX_EXPORT_COLUMNS) so the CPA tooling
// has a stable schema. The CSV body is strictly `header_row + data_rows`;
// the exclusion count is surfaced via the `X-Unreconciled-Excluded` HTTP
// header and the `?format=json` sibling, NOT via a banner row inside the
// CSV (a banner row would break "row 0 = header" in Excel + tax software
// import). `date_acquired` sits right after `sale_date`; pairs naturally
// with `holding_period_days` already in the column set.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

// Local mirror of the PortfolioLedgerEntry surface this module reads — the
// portfolioStore.service does not export the type. Kept structurally
// compatible so a passing Cosmos-loaded entry slots in unchanged. Strict
// minimum field set; everything not consumed here is omitted on purpose.
export interface LedgerEntryForErp {
  id: string;
  userId: string;
  holdingId: string;
  playerName: string;
  cardTitle: string;
  quantitySold: number;
  unitSalePrice: number;
  grossProceeds: number;
  fees: number;
  tax: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  realizedProfitLossPct: number;
  soldAt: string;
  notes?: string;
  source?: "manual" | "ebay";
  ebayOrderId?: string;
  finalValueFee?: number | null;
  paymentProcessingFee?: number | null;
  promotedListingFee?: number | null;
  adFee?: number | null;
  otherFees?: number | null;
  netPayout?: number | null;
  actualShippingCost?: number | null;
  suppliesCost?: number | null;
  gradingCost?: number | null;
  needsReconciliation?: boolean;
  dismissedAt?: string | null;
  dismissedReason?: string | null;
}

export type HoldingsById = Record<string, PortfolioHolding | undefined>;

// ─── Reconciliation rule ────────────────────────────────────────────────────

/**
 * Single source of truth for "is this entry trustworthy enough to fold into
 * reported totals + the tax export". `dismissedAt` is intentionally NOT
 * consulted — dismissed-but-flagged rows STAY excluded.
 */
export function isReconciled(entry: LedgerEntryForErp): boolean {
  return entry.needsReconciliation !== true;
}

/**
 * For unreconciled entries, surface which granular fee fields are NULL so
 * the iOS UX can show the user a precise to-do list per row.
 */
export function missingFeeFields(entry: LedgerEntryForErp): string[] {
  if (isReconciled(entry)) return [];
  if (entry.source !== "ebay") return [];
  const missing: string[] = [];
  if (entry.finalValueFee === null) missing.push("finalValueFee");
  if (entry.paymentProcessingFee === null) missing.push("paymentProcessingFee");
  if (entry.promotedListingFee === null) missing.push("promotedListingFee");
  if (entry.adFee === null) missing.push("adFee");
  if (entry.otherFees === null) missing.push("otherFees");
  if (entry.netPayout === null) missing.push("netPayout");
  if (entry.actualShippingCost === null) missing.push("actualShippingCost");
  return missing;
}

// ─── Date-window filtering ──────────────────────────────────────────────────

function parseDateInput(raw: string | undefined): string | null {
  if (!raw) return null;
  // Accept YYYY-MM-DD; normalize anything parseable to its date prefix.
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function inWindow(soldAtIso: string, fromIso: string | null, toIso: string | null): boolean {
  const datePart = soldAtIso.slice(0, 10);
  if (fromIso && datePart < fromIso) return false;
  if (toIso && datePart > toIso) return false;
  return true;
}

// ─── Unreconciled listing ───────────────────────────────────────────────────

export interface UnreconciledEntry extends LedgerEntryForErp {
  missingFields: string[];
}

export interface UnreconciledListResult {
  entries: UnreconciledEntry[];
  counts: { unreconciledTotal: number; dismissedHidden: number };
}

export function listUnreconciled(entries: ReadonlyArray<LedgerEntryForErp>): UnreconciledListResult {
  const flagged = entries.filter((e) => !isReconciled(e));
  // Dismissed entries STAY excluded from /pnl + /tax-export, but the iOS
  // list view hides them from the active "needs your attention" section by
  // default — they're counted separately so the user can re-open later.
  const active = flagged.filter((e) => !e.dismissedAt);
  const dismissedHidden = flagged.length - active.length;
  return {
    entries: active
      .slice()
      .sort((a, b) => a.soldAt.localeCompare(b.soldAt))
      .map((e) => ({ ...e, missingFields: missingFeeFields(e) })),
    counts: { unreconciledTotal: flagged.length, dismissedHidden },
  };
}

// ─── P&L aggregation ────────────────────────────────────────────────────────

export type PnlGroupBy = "month" | "player" | "set" | "grade" | "source";

export const VALID_GROUP_BY: ReadonlyArray<PnlGroupBy> = [
  "month",
  "player",
  "set",
  "grade",
  "source",
];

export interface PnlTotals {
  grossProceeds: number;
  feesTotal: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  entryCount: number;
}

export interface PnlGroup {
  key: string;
  label: string;
  totals: PnlTotals;
}

export interface PnlAggregation {
  window: { from: string | null; to: string | null };
  groupBy: PnlGroupBy;
  totals: PnlTotals;
  groups: PnlGroup[];
  excluded: {
    unreconciledCount: number;
    unreconciledOldestSoldAt: string | null;
    unreconciledNewestSoldAt: string | null;
  };
}

function zeroTotals(): PnlTotals {
  return {
    grossProceeds: 0,
    feesTotal: 0,
    shipping: 0,
    netProceeds: 0,
    costBasisSold: 0,
    realizedProfitLoss: 0,
    entryCount: 0,
  };
}

/**
 * For eBay entries the legacy `fees` aggregate is 0 (see the type comment);
 * the granular fields are authoritative. For manual entries the granular
 * fields are absent and `fees` is the truth.
 */
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

function accumulate(acc: PnlTotals, e: LedgerEntryForErp): void {
  acc.grossProceeds += e.grossProceeds ?? 0;
  acc.feesTotal += entryFeeTotal(e);
  acc.shipping += entryShipping(e);
  acc.netProceeds += e.netProceeds ?? 0;
  acc.costBasisSold += e.costBasisSold ?? 0;
  acc.realizedProfitLoss += e.realizedProfitLoss ?? 0;
  acc.entryCount += 1;
}

function roundTotals(t: PnlTotals): PnlTotals {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    grossProceeds: r2(t.grossProceeds),
    feesTotal: r2(t.feesTotal),
    shipping: r2(t.shipping),
    netProceeds: r2(t.netProceeds),
    costBasisSold: r2(t.costBasisSold),
    realizedProfitLoss: r2(t.realizedProfitLoss),
    entryCount: t.entryCount,
  };
}

function groupKeyFor(
  e: LedgerEntryForErp,
  holding: PortfolioHolding | undefined,
  groupBy: PnlGroupBy,
): { key: string; label: string } {
  switch (groupBy) {
    case "month": {
      const k = e.soldAt.slice(0, 7); // YYYY-MM
      return { key: k, label: k };
    }
    case "player": {
      const name = e.playerName?.trim() || "(unknown)";
      return { key: name.toLowerCase(), label: name };
    }
    case "set": {
      const setName = holding?.setName?.trim() || holding?.product?.trim() || "(unknown)";
      return { key: setName.toLowerCase(), label: setName };
    }
    case "grade": {
      const company = holding?.gradeCompany?.trim() || holding?.gradingCompany?.trim() || null;
      const value = typeof holding?.gradeValue === "number" ? holding.gradeValue : null;
      if (!company || value === null) return { key: "raw", label: "Raw" };
      const label = `${company.toUpperCase()} ${value}`;
      return { key: label.toLowerCase(), label };
    }
    case "source": {
      const s = e.source ?? "manual";
      return { key: s, label: s === "ebay" ? "eBay" : "Manual" };
    }
  }
}

export function aggregatePnl(
  entries: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  options: { from?: string; to?: string; groupBy: PnlGroupBy },
): PnlAggregation {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  const windowed = entries.filter((e) => inWindow(e.soldAt, fromIso, toIso));
  const reconciled = windowed.filter((e) => isReconciled(e));
  const unreconciled = windowed.filter((e) => !isReconciled(e));

  const totals = zeroTotals();
  const groupsAcc = new Map<string, { label: string; totals: PnlTotals }>();
  for (const e of reconciled) {
    accumulate(totals, e);
    const { key, label } = groupKeyFor(e, holdingsById[e.holdingId], options.groupBy);
    let g = groupsAcc.get(key);
    if (!g) {
      g = { label, totals: zeroTotals() };
      groupsAcc.set(key, g);
    }
    accumulate(g.totals, e);
  }

  // Group ordering: month → ascending; everything else → descending net.
  const groups: PnlGroup[] = Array.from(groupsAcc.entries()).map(([key, g]) => ({
    key,
    label: g.label,
    totals: roundTotals(g.totals),
  }));
  if (options.groupBy === "month") {
    groups.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    groups.sort(
      (a, b) => Math.abs(b.totals.realizedProfitLoss) - Math.abs(a.totals.realizedProfitLoss),
    );
  }

  const unreconciledSorted = unreconciled
    .map((e) => e.soldAt)
    .sort((a, b) => a.localeCompare(b));

  return {
    window: { from: fromIso, to: toIso },
    groupBy: options.groupBy,
    totals: roundTotals(totals),
    groups,
    excluded: {
      unreconciledCount: unreconciled.length,
      unreconciledOldestSoldAt: unreconciledSorted[0] ?? null,
      unreconciledNewestSoldAt: unreconciledSorted[unreconciledSorted.length - 1] ?? null,
    },
  };
}

// ─── Tax export (CSV + JSON sibling) ────────────────────────────────────────

/**
 * Locked column order. `date_acquired` sits right after `sale_date` to pair
 * naturally with `holding_period_days`. Refining the column set for a
 * specific filing posture (Schedule C dealer vs Schedule D / Form 8949
 * investor) is a CPA-driven follow-up.
 */
export const TAX_EXPORT_COLUMNS = [
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
] as const;

export type TaxExportColumn = (typeof TAX_EXPORT_COLUMNS)[number];

export interface TaxExportRow {
  sale_date: string;
  date_acquired: string;
  asset_description: string;
  player_name: string;
  set_name: string;
  card_year: string;
  grade: string;
  source: string;
  proceeds_gross: string;
  fee_total: string;
  shipping_cost: string;
  grading_cost: string;
  supplies_cost: string;
  proceeds_net: string;
  cost_basis: string;
  realized_gain_loss: string;
  holding_period_days: string;
  ebay_order_id: string;
}

function purchaseDateIso(holding: PortfolioHolding | undefined): string | null {
  const raw = holding?.purchaseDate;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function holdingPeriodDays(saleDate: string, acquired: string | null): string {
  if (!acquired) return "";
  const sale = Date.parse(saleDate);
  const acq = Date.parse(acquired);
  if (!Number.isFinite(sale) || !Number.isFinite(acq)) return "";
  const days = Math.round((sale - acq) / (24 * 60 * 60 * 1000));
  return String(days);
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function gradeLabel(holding: PortfolioHolding | undefined): string {
  // Orphaned holding → blank (unknown). Matches the blank-over-fabricate
  // handling used for date_acquired / set_name / card_year. An existing
  // holding without gradeCompany/gradeValue IS known to be raw — that
  // stays labeled "Raw".
  if (!holding) return "";
  const company = holding.gradeCompany?.trim() || holding.gradingCompany?.trim();
  const value = typeof holding.gradeValue === "number" ? holding.gradeValue : null;
  if (!company || value === null) return "Raw";
  return `${company.toUpperCase()} ${value}`;
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildTaxExportRow(
  e: LedgerEntryForErp,
  holding: PortfolioHolding | undefined,
): TaxExportRow {
  const saleDate = e.soldAt.slice(0, 10);
  const acquired = purchaseDateIso(holding);
  return {
    sale_date: saleDate,
    date_acquired: acquired ?? "",
    asset_description: e.cardTitle ?? "",
    player_name: e.playerName ?? "",
    set_name: holding?.setName ?? holding?.product ?? "",
    card_year: typeof holding?.cardYear === "number" ? String(holding.cardYear) : "",
    grade: gradeLabel(holding),
    source: e.source ?? "manual",
    proceeds_gross: money(e.grossProceeds),
    fee_total: money(entryFeeTotal(e)),
    shipping_cost: money(entryShipping(e)),
    grading_cost: money(e.gradingCost ?? null),
    supplies_cost: money(e.suppliesCost ?? null),
    proceeds_net: money(e.netProceeds),
    cost_basis: money(e.costBasisSold),
    realized_gain_loss: money(e.realizedProfitLoss),
    holding_period_days: holdingPeriodDays(saleDate, acquired),
    ebay_order_id: e.ebayOrderId ?? "",
  };
}

export interface TaxExportResult {
  csv: string;
  json: {
    window: { from: string | null; to: string | null };
    columns: ReadonlyArray<TaxExportColumn>;
    rows: TaxExportRow[];
    excluded: {
      count: number;
      oldestSoldAt: string | null;
      newestSoldAt: string | null;
    };
  };
}

export function buildTaxExport(
  entries: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  options: { from?: string; to?: string } = {},
): TaxExportResult {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  const windowed = entries.filter((e) => inWindow(e.soldAt, fromIso, toIso));
  const reconciled = windowed.filter((e) => isReconciled(e));
  const unreconciled = windowed.filter((e) => !isReconciled(e));

  const rows = reconciled
    .slice()
    .sort((a, b) => a.soldAt.localeCompare(b.soldAt))
    .map((e) => buildTaxExportRow(e, holdingsById[e.holdingId]));

  const header = TAX_EXPORT_COLUMNS.join(",");
  const dataLines = rows.map((r) =>
    TAX_EXPORT_COLUMNS.map((col) =>
      csvEscape((r as unknown as Record<string, string>)[col] ?? ""),
    ).join(","),
  );
  // Strictly `header_row + data_rows`. NO banner. Exclusion count is
  // surfaced via X-Unreconciled-Excluded HTTP header and the JSON sibling.
  const csv = [header, ...dataLines].join("\n");

  const unreconciledSorted = unreconciled
    .map((e) => e.soldAt)
    .sort((a, b) => a.localeCompare(b));

  return {
    csv,
    json: {
      window: { from: fromIso, to: toIso },
      columns: TAX_EXPORT_COLUMNS,
      rows,
      excluded: {
        count: unreconciled.length,
        oldestSoldAt: unreconciledSorted[0] ?? null,
        newestSoldAt: unreconciledSorted[unreconciledSorted.length - 1] ?? null,
      },
    },
  };
}
