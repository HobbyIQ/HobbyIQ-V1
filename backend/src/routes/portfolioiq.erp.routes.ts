// CF-ERP-RECONCILIATION + CF-ERP-EXPANSION (2026-06-03): pro_seller ERP
// layer routes. Surface owns the entire /api/portfolio/erp/* path tree.
//
//   GET  /erp/unreconciled                           (CF-ERP)
//   GET  /erp/unreconciled/aging                     (#6a)
//   POST /erp/refetch                                (#6b-fanout — CF-PR-E-REFETCH-FANOUT)
//   POST /erp/unreconciled/:id/refetch               (#6b)
//   POST /erp/unreconciled/:id/override              (#6c, audit-trail append)
//   GET  /erp/pnl?from=&to=&groupBy=&includeExpenses (CF-ERP + #5 opt-in)
//   GET  /erp/tax-export?from=&to=&format=csv|json   (CF-ERP)
//   GET  /erp/analytics?from=&to=&groupBy=           (#2)
//   GET  /erp/analytics/timeseries?from=&to=&bucket= (#2)
//   GET  /erp/valuation                              (#3 — reads reprice snapshot)
//   GET  /erp/tax/filings/:year                      (#4a)
//   PUT  /erp/tax/filings/:year                      (#4a)
//   GET  /erp/accounting-export?from=&to=&format=    (#4b)
//   GET  /erp/expenses?from=&to=&category=           (#5)
//   POST /erp/expenses                               (#5)
//   PATCH/DELETE /erp/expenses/:id                   (#5)
//   GET  /erp/expenses/report?from=&to=&groupBy=     (#5)
//   POST /erp/trades                                 (#7 atomic)
//   GET  /erp/trades?from=&to=                       (#7)
//   GET  /erp/trades/:id                             (#7)
//
// All routes: requireSession → requireEntitlement("erpReconciliation").
// NO cap. Reads come from the user's own Cosmos doc; #7 makes a few live
// computeEstimate calls when the caller defers FMV resolution to the
// server (user-initiated low-volume action — see #7 design).

import { Router, Request, Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import {
  getPurchaseForUser,
  getTradeForUser,
  linkHoldingsToPurchase,
  listPurchasesForUser,
  listTradesForUser,
  parseSalesTrackingFields,
  readUserDoc,
  recordPurchase,
  recordTradeTransaction,
  writeUserDoc,
  type PaymentMethod,
  type SaleLocation,
  type SalesChannel,
} from "../services/portfolioiq/portfolioStore.service.js";
import {
  aggregatePnl,
  buildCogsView,
  buildTaxExport,
  enrichEntryForClient,
  isReconciled,
  listUnreconciled,
  VALID_GROUP_BY,
  type LedgerEntryForErp,
  type PnlGroupBy,
} from "../services/portfolioiq/erpReconciliation.service.js";
import {
  aggregateAnalytics,
  aggregateTimeseries,
  VALID_ANALYTICS_GROUP_BY,
  type AnalyticsGroupBy,
  type TimeseriesBucket,
} from "../services/portfolioiq/erpAnalytics.service.js";
import { buildValuation } from "../services/portfolioiq/erpValuation.service.js";
import { buildInventoryAnalytics } from "../services/portfolioiq/inventoryAnalytics.service.js";
import {
  importEbayPurchaseHistory,
  MAX_DURATION_DAYS,
  runAutoHoldingBatch,
} from "../services/ebay/ebayBuyerHistory.service.js";
import { composeErpSummary } from "../services/portfolioiq/erpSummary.service.js";
import { readValueHistory } from "../services/portfolioiq/portfolioValueHistory.service.js";
import {
  getTaxFiling,
  upsertTaxFiling,
  TAX_FILING_RAILS,
  type TaxFilingRail,
} from "../repositories/taxFilings.repository.js";
import {
  buildAccountingExport,
  buildTaxFilingReport,
} from "../services/portfolioiq/erpTaxAccounting.service.js";
import {
  createExpense,
  deleteExpense,
  listExpensesForUser,
  totalExpensesInWindow,
  updateExpense,
  VALID_EXPENSE_CATEGORIES,
  aggregateExpenses,
  type ExpenseCategory,
  type ExpenseGroupBy,
} from "../repositories/portfolioExpenses.repository.js";
import {
  applyFeeOverride,
  applySaveCosts,
  buildAging,
  validateFeeOverride,
  validateSaveCosts,
} from "../services/portfolioiq/erpAgingOverride.service.js";
import { computeLedgerFinancials } from "../services/portfolioiq/portfolioStore.service.js";

const router = Router();

router.use(requireSession);
router.use(requireEntitlement("erpReconciliation"));

function userIdFrom(req: Request): string {
  return req.user!.userId;
}

router.get("/unreconciled", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const result = listUnreconciled(entries);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /unreconciled failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load unreconciled entries" });
  }
});

router.get("/pnl", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const groupByRaw =
      typeof req.query.groupBy === "string" ? req.query.groupBy.trim() : "month";
    if (!(VALID_GROUP_BY as readonly string[]).includes(groupByRaw)) {
      return res.status(400).json({
        success: false,
        error: `groupBy must be one of: ${VALID_GROUP_BY.join(", ")}`,
      });
    }
    const groupBy = groupByRaw as PnlGroupBy;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const includeExpenses =
      typeof req.query.includeExpenses === "string" &&
      ["1", "true", "yes"].includes(req.query.includeExpenses.toLowerCase());

    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const holdingsById = doc.holdings ?? {};
    const result = aggregatePnl(entries, holdingsById, { from, to, groupBy });

    // CF-PNL-COGS-INTEGRATION (2026-07-12): buy-side + inventory snapshot
    // metrics always included so iOS finances dashboard renders in one
    // call. Backward-compatible — old clients ignore the new `cogs` field.
    const cogs = buildCogsView(
      result.totals,
      doc.purchases ?? [],
      holdingsById,
      { from, to },
    );

    // CF-ERP-EXPANSION-#5: optional operating-expense roll-up. Default off
    // so existing iOS bindings keep their shape.
    if (includeExpenses) {
      const expenses = await listExpensesForUser(userId, { from, to });
      const { total: operatingExpenses } = totalExpensesInWindow(expenses, { from, to });
      // CF-PNL-COGS-INTEGRATION: when opting in to expenses, trueNet
      // subtracts BOTH operating expenses AND (window-scoped) purchase
      // spend that hasn't yet realized as costBasisSold. This is the
      // honest "cash net" for the period.
      const trueNet = Math.round(
        (result.totals.realizedProfitLoss - operatingExpenses) * 100,
      ) / 100;
      return res.json({
        success: true,
        ...result,
        cogs,
        operatingExpenses,
        trueNet,
      });
    }

    res.json({ success: true, ...result, cogs });
  } catch (err: any) {
    console.error("[portfolio.erp] /pnl failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to aggregate P&L" });
  }
});

// ─── CF-ERP-EXPANSION-#2 Analytics ─────────────────────────────────────────

router.get("/analytics", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const groupByRaw = typeof req.query.groupBy === "string" ? req.query.groupBy.trim() : "";
    if (!(VALID_ANALYTICS_GROUP_BY as readonly string[]).includes(groupByRaw)) {
      return res.status(400).json({
        success: false,
        error: `groupBy must be one of: ${VALID_ANALYTICS_GROUP_BY.join(", ")}`,
      });
    }
    const groupBy = groupByRaw as AnalyticsGroupBy;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const result = aggregateAnalytics(entries, doc.holdings ?? {}, { from, to, groupBy });
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /analytics failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to aggregate analytics" });
  }
});

router.get("/analytics/timeseries", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const bucketRaw = typeof req.query.bucket === "string" ? req.query.bucket.trim() : "month";
    if (bucketRaw !== "month" && bucketRaw !== "quarter") {
      return res.status(400).json({ success: false, error: "bucket must be 'month' or 'quarter'" });
    }
    const bucket = bucketRaw as TimeseriesBucket;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const result = aggregateTimeseries(entries, { from, to, bucket });
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /analytics/timeseries failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to build timeseries" });
  }
});

// ─── CF-ERP-EXPANSION-#3 Valuation ─────────────────────────────────────────

// CF-INVENTORY-TURNOVER-AGING (2026-07-12): inventory-side analytics
// counterpart to /valuation. Returns aging buckets, avg/median days-on-hand,
// oldest holdings (top 10), and a coarse turnover proxy based on window-
// scoped costBasisSold vs current inventory cost. Documented as PROXY —
// true turnover ratio would need per-holding historical timeline we don't
// track. See inventoryAnalytics.service.ts for full math.
router.get("/inventory-analytics", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const analytics = buildInventoryAnalytics(
      doc.holdings ?? {},
      (doc.ledger ?? []) as unknown as LedgerEntryForErp[],
      { from, to },
    );
    res.json({ success: true, ...analytics });
  } catch (err: any) {
    console.error("[portfolio.erp] /inventory-analytics failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to compute inventory analytics" });
  }
});

router.get("/valuation", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const result = buildValuation(
      Object.values(doc.holdings ?? {}),
      entries,
      doc.holdings ?? {},
      Date.now(),
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /valuation failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to compute valuation" });
  }
});

// CF-ERP-SUMMARY (2026-07-11, Drew): one-call dashboard aggregation.
// Composes valuation + YTD P&L + value history + top movers so iOS
// home screen doesn't have to fan out 4 separate calls. Pure composition
// over primitives already used by the individual routes. See
// erpSummary.service.ts for the shape + tie-break rules.
router.get("/summary", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const valueHistory = await readValueHistory(userId, {});
    const result = composeErpSummary(
      Object.values(doc.holdings ?? {}),
      entries,
      doc.holdings ?? {},
      valueHistory,
      Date.now(),
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /summary failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to compose summary" });
  }
});

// ─── CF-ERP-EXPANSION-#4 Tax filings + accounting export ──────────────────

router.get("/tax/filings/:year", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, error: "year must be a 4-digit year" });
    }
    const filing = await getTaxFiling(userId, year);
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const report = buildTaxFilingReport(entries, filing, year);
    res.json({ success: true, ...report });
  } catch (err: any) {
    console.error("[portfolio.erp] /tax/filings GET failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to read tax filing" });
  }
});

router.put("/tax/filings/:year", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, error: "year must be a 4-digit year" });
    }
    const body = (req.body ?? {}) as { rails?: Record<string, { reportedGross1099K?: unknown; note?: unknown }> };
    if (!body.rails || typeof body.rails !== "object") {
      return res.status(400).json({ success: false, error: "body.rails object is required" });
    }
    const parsed: Partial<Record<TaxFilingRail, { reportedGross1099K: number; note?: string }>> = {};
    for (const [k, v] of Object.entries(body.rails)) {
      if (!(TAX_FILING_RAILS as readonly string[]).includes(k)) {
        return res.status(400).json({
          success: false,
          error: `unknown rail "${k}". Valid: ${TAX_FILING_RAILS.join(", ")}`,
        });
      }
      const reported = Number(v?.reportedGross1099K);
      if (!Number.isFinite(reported) || reported < 0 || reported > 10_000_000) {
        return res.status(400).json({
          success: false,
          error: `rails.${k}.reportedGross1099K must be a number 0..10000000`,
        });
      }
      const note = typeof v?.note === "string" ? v.note.slice(0, 500) : undefined;
      parsed[k as TaxFilingRail] = { reportedGross1099K: reported, ...(note ? { note } : {}) };
    }
    const filing = await upsertTaxFiling(userId, year, parsed);
    if (!filing) {
      return res.status(500).json({ success: false, error: "Tax-filing store unavailable" });
    }
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const report = buildTaxFilingReport(entries, filing, year);
    res.json({ success: true, ...report });
  } catch (err: any) {
    console.error("[portfolio.erp] /tax/filings PUT failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to upsert tax filing" });
  }
});

router.get("/accounting-export", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const format =
      typeof req.query.format === "string" && req.query.format.toLowerCase() === "json"
        ? "json"
        : "csv";
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const result = buildAccountingExport(entries, doc.holdings ?? {}, { from, to });
    res.setHeader("X-Unreconciled-Excluded", String(result.json.excluded.count));
    if (format === "json") {
      return res.json({ success: true, ...result.json });
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    const filenameWindow = [result.json.window.from, result.json.window.to].filter(Boolean).join("_to_");
    const filename = `hobbyiq-accounting${filenameWindow ? "_" + filenameWindow : ""}.csv`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(result.csv);
  } catch (err: any) {
    console.error("[portfolio.erp] /accounting-export failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to build accounting export" });
  }
});

// ─── CF-ERP-EXPANSION-#5 Expenses CRUD + report ────────────────────────────

router.get("/expenses/report", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const groupByRaw = typeof req.query.groupBy === "string" ? req.query.groupBy : "category";
    if (groupByRaw !== "category" && groupByRaw !== "month") {
      return res.status(400).json({ success: false, error: "groupBy must be 'category' or 'month'" });
    }
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const entries = await listExpensesForUser(userId, { from, to });
    const report = aggregateExpenses(entries, { from, to, groupBy: groupByRaw as ExpenseGroupBy });
    res.json({ success: true, ...report });
  } catch (err: any) {
    console.error("[portfolio.erp] /expenses/report failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to aggregate expenses" });
  }
});

router.get("/expenses", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const categoryRaw = typeof req.query.category === "string" ? req.query.category : undefined;
    if (categoryRaw && !(VALID_EXPENSE_CATEGORIES as readonly string[]).includes(categoryRaw)) {
      return res.status(400).json({
        success: false,
        error: `category must be one of: ${VALID_EXPENSE_CATEGORIES.join(", ")}`,
      });
    }
    const entries = await listExpensesForUser(userId, {
      from,
      to,
      category: categoryRaw as ExpenseCategory | undefined,
    });
    res.json({ success: true, entries });
  } catch (err: any) {
    console.error("[portfolio.erp] /expenses list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to list expenses" });
  }
});

router.post("/expenses", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const category = body.category;
    if (typeof category !== "string" || !(VALID_EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
      return res.status(400).json({
        success: false,
        error: `category must be one of: ${VALID_EXPENSE_CATEGORIES.join(", ")}`,
      });
    }
    const amountRaw = Number(body.amount);
    if (!Number.isFinite(amountRaw) || amountRaw <= 0 || amountRaw > 10_000_000) {
      return res.status(400).json({ success: false, error: "amount must be a positive number ≤ 10000000" });
    }
    const date = typeof body.date === "string" ? body.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: "date must be YYYY-MM-DD" });
    }
    const categoryNote = typeof body.categoryNote === "string" ? body.categoryNote.trim().slice(0, 100) : undefined;
    if (category === "other" && !categoryNote) {
      return res.status(400).json({ success: false, error: 'categoryNote is required when category === "other"' });
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : undefined;
    const receiptRef = typeof body.receiptRef === "string" ? body.receiptRef.trim().slice(0, 500) : undefined;
    const created = await createExpense({
      userId,
      category: category as ExpenseCategory,
      categoryNote,
      amount: amountRaw,
      date,
      note,
      receiptRef,
    });
    if (!created) {
      return res.status(500).json({ success: false, error: "Expense store unavailable" });
    }
    res.status(201).json({ success: true, expense: created });
  } catch (err: any) {
    console.error("[portfolio.erp] /expenses create failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to create expense" });
  }
});

router.patch("/expenses/:id", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: any = {};
    if (body.category !== undefined) {
      if (typeof body.category !== "string"
          || !(VALID_EXPENSE_CATEGORIES as readonly string[]).includes(body.category)) {
        return res.status(400).json({
          success: false,
          error: `category must be one of: ${VALID_EXPENSE_CATEGORIES.join(", ")}`,
        });
      }
      patch.category = body.category;
    }
    if (body.amount !== undefined) {
      const a = Number(body.amount);
      if (!Number.isFinite(a) || a <= 0 || a > 10_000_000) {
        return res.status(400).json({ success: false, error: "amount must be a positive number ≤ 10000000" });
      }
      patch.amount = a;
    }
    if (body.date !== undefined) {
      if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        return res.status(400).json({ success: false, error: "date must be YYYY-MM-DD" });
      }
      patch.date = body.date;
    }
    if ("categoryNote" in body) patch.categoryNote = body.categoryNote === null ? null : String(body.categoryNote).slice(0, 100);
    if ("note" in body) patch.note = body.note === null ? null : String(body.note).slice(0, 500);
    if ("receiptRef" in body) patch.receiptRef = body.receiptRef === null ? null : String(body.receiptRef).slice(0, 500);
    const updated = await updateExpense(userId, id, patch);
    if (!updated) return res.status(404).json({ success: false, error: "Expense not found" });
    res.json({ success: true, expense: updated });
  } catch (err: any) {
    console.error("[portfolio.erp] /expenses patch failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to update expense" });
  }
});

router.delete("/expenses/:id", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });
    const ok = await deleteExpense(userId, id);
    if (!ok) return res.status(404).json({ success: false, error: "Expense not found" });
    res.json({ success: true });
  } catch (err: any) {
    console.error("[portfolio.erp] /expenses delete failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to delete expense" });
  }
});

// ─── CF-ERP-EXPANSION-#6 Aging + refetch + override ────────────────────────

router.get("/unreconciled/aging", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const aging = buildAging(entries, Date.now());
    res.json({ success: true, ...aging });
  } catch (err: any) {
    console.error("[portfolio.erp] /unreconciled/aging failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to compute aging" });
  }
});

// CF-PR-E-REFETCH-FANOUT (2026-06-17): top-level refetch fan-out.
//
// iOS posts to /erp/refetch from a single "Refetch Finances" button on the
// ERP screen — no per-entry context. The existing per-entry handler below
// (POST /unreconciled/:id/refetch) just annotates one ledger row with
// refetchRequestedAt so the next reconciliation pass picks it up. This
// fan-out does the same thing across EVERY unreconciled entry for the
// caller's user doc:
//   1. Read user doc.
//   2. Walk doc.ledger; mark every !isReconciled(e) entry with a fresh
//      refetchRequestedAt timestamp.
//   3. Write back; return { success, updated, message }.
//
// Dismissed entries are still excluded from /pnl + /tax-export but stay
// in doc.ledger and aren't reconciled — they're included in the sweep so
// a user who un-dismisses later gets the latest finances pass.
//
// Response shape matches iOS's ERPRefetchResponse { message?, updated? }
// (APIService.swift:381).
router.post("/refetch", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const doc = await readUserDoc(userId);
    const now = new Date().toISOString();
    let updated = 0;
    for (let i = 0; i < doc.ledger.length; i++) {
      const entry = doc.ledger[i] as LedgerEntryForErp;
      if (isReconciled(entry)) continue;
      doc.ledger[i] = {
        ...doc.ledger[i],
        refetchRequestedAt: now,
      };
      updated += 1;
    }
    if (updated > 0) {
      await writeUserDoc(userId, doc);
    }
    res.status(200).json({
      success: true,
      updated,
      message:
        updated === 0
          ? "No unreconciled entries to refetch."
          : `Refetch queued for ${updated} ${updated === 1 ? "entry" : "entries"}; next reconciliation pass will pick them up.`,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /refetch failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to queue refetch" });
  }
});

router.post("/unreconciled/:id/refetch", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });
    // Annotate the entry; the existing eBay reconciliation pass picks it up
    // on its next sweep. Fire-and-forget from the user's POV — returns 202
    // immediately rather than blocking on a synchronous Finances API call.
    const doc = await readUserDoc(userId);
    const idx = doc.ledger.findIndex((e) => e.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Entry not found" });
    doc.ledger[idx] = { ...doc.ledger[idx], refetchRequestedAt: new Date().toISOString() };
    await writeUserDoc(userId, doc);
    res.status(202).json({
      success: true,
      message: "Refetch queued; next reconciliation pass will pick it up",
      entryId: id,
      refetchRequestedAt: doc.ledger[idx].refetchRequestedAt,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /unreconciled/:id/refetch failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to queue refetch" });
  }
});

router.post("/unreconciled/:id/override", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const validated = validateFeeOverride(req.body);
    if ("error" in validated) {
      return res.status(400).json({ success: false, error: validated.error });
    }

    const doc = await readUserDoc(userId);
    const idx = doc.ledger.findIndex((e) => e.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Entry not found" });

    const before = doc.ledger[idx] as unknown as LedgerEntryForErp;
    const { entry: afterFees, adjustment } = applyFeeOverride(before, validated.ok, userId);

    // CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): net-basis fix.
    //
    // PREFERRED: if the operator supplied netPayout, computeLedgerFinancials
    // uses the eBay-authoritative formula `netPayout - gradingCost -
    // suppliesCost` (the netPayoutOverride branch). Aligns the manual path
    // with the Finances enrichment path bit-for-bit.
    //
    // FALLBACK: when netPayout is null, derive from gross minus granular
    // fees. INCLUDES actualShippingCost in the deduction — the long-
    // standing route comment already declared this intent ("granular fees
    // + actualShipping subtract on top"); the missing addition was a bug
    // that under-counted seller costs on free-shipping listings. For
    // calculated/buyer-pays-shipping listings where the seller's label
    // cost is approximately offset by the buyer's shipping payment (not
    // in our `grossProceeds`), the operator should supply `netPayout`
    // directly OR set `actualShippingCost: 0`.
    const granularSum =
      (afterFees.finalValueFee ?? 0)
      + (afterFees.paymentProcessingFee ?? 0)
      + (afterFees.promotedListingFee ?? 0)
      + (afterFees.adFee ?? 0)
      + (afterFees.otherFees ?? 0)
      + (afterFees.actualShippingCost ?? 0);
    const financials = computeLedgerFinancials({
      grossProceeds: afterFees.grossProceeds,
      feesTotal: granularSum,
      tax: afterFees.source === "ebay" ? 0 : afterFees.tax,
      shipping: afterFees.source === "ebay" ? 0 : afterFees.shipping,
      gradingCost: afterFees.gradingCost ?? null,
      suppliesCost: afterFees.suppliesCost ?? null,
      costBasisSold: afterFees.costBasisSold,
      netPayoutOverride: afterFees.netPayout ?? null,
    });

    const finalEntry = {
      ...afterFees,
      netProceeds: financials.netProceeds,
      realizedProfitLoss: financials.realizedProfitLoss,
      realizedProfitLossPct: financials.realizedProfitLossPct,
    };
    doc.ledger[idx] = finalEntry as unknown as typeof doc.ledger[number];
    await writeUserDoc(userId, doc);

    // CF-PR-E-COSTSSTATUS-AUTHORITATIVE: response carries the SAME enriched
    // shape as GET /unreconciled (missingFields + costsStatus). Client never
    // re-derives display state.
    res.json({
      success: true,
      entry: enrichEntryForClient(finalEntry as LedgerEntryForErp),
      adjustment,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /unreconciled/:id/override failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to apply override" });
  }
});

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): save-costs ──────────────
//
// POST /api/portfolio/erp/unreconciled/:id/save-costs
// Body: { gradingCost?: number|null, suppliesCost?: number|null }
// Either or both fields required; non-negative or null; 0 allowed (raw card).
//
// Sets axis-2 marker (userCostsProvidedAt / userCostsProvidedBy), persists
// costs, recomputes provisional financials (null fees → 0), appends a
// feeAdjustments audit row, runs tryFinalizeReconciliation (finalizes only
// if axis 1 fees also satisfied). 409 if entry is already finalized.

router.post("/unreconciled/:id/save-costs", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const validated = validateSaveCosts(req.body);
    if ("error" in validated) {
      return res.status(400).json({
        success: false,
        error: validated.error,
        code: validated.code,
      });
    }

    const doc = await readUserDoc(userId);
    const idx = doc.ledger.findIndex((e) => e.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Entry not found" });

    const before = doc.ledger[idx] as unknown as LedgerEntryForErp;
    if (before.source !== "ebay") {
      return res.status(400).json({
        success: false,
        error: "save-costs applies only to eBay entries; use PATCH /ledger/:id for manual entries",
        code: "NOT_EBAY_ENTRY",
      });
    }
    if (before.needsReconciliation !== true) {
      return res.status(409).json({
        success: false,
        error: "Entry already finalized — costs locked",
        code: "ALREADY_FINALIZED",
      });
    }

    const { entry: afterCosts, adjustment } = applySaveCosts(before, validated.ok, userId);

    // Recompute provisional financials. Null fees coerce to 0 in the sum —
    // overstated until Finances enrichment lands. Identical formula shape to
    // /override so the two paths stay in lockstep.
    const granularSum =
      (afterCosts.finalValueFee ?? 0)
      + (afterCosts.paymentProcessingFee ?? 0)
      + (afterCosts.promotedListingFee ?? 0)
      + (afterCosts.adFee ?? 0)
      + (afterCosts.otherFees ?? 0)
      + (afterCosts.actualShippingCost ?? 0);
    const financials = computeLedgerFinancials({
      grossProceeds: afterCosts.grossProceeds,
      feesTotal: granularSum,
      tax: 0,
      shipping: 0,
      gradingCost: afterCosts.gradingCost ?? null,
      suppliesCost: afterCosts.suppliesCost ?? null,
      costBasisSold: afterCosts.costBasisSold,
      netPayoutOverride: afterCosts.netPayout ?? null,
    });

    const finalEntry = {
      ...afterCosts,
      netProceeds: financials.netProceeds,
      realizedProfitLoss: financials.realizedProfitLoss,
      realizedProfitLossPct: financials.realizedProfitLossPct,
    };
    doc.ledger[idx] = finalEntry as unknown as typeof doc.ledger[number];
    await writeUserDoc(userId, doc);

    // CF-PR-E-COSTSSTATUS-AUTHORITATIVE: response carries the SAME enriched
    // shape as GET /unreconciled (missingFields + costsStatus). Client never
    // re-derives display state.
    res.json({
      success: true,
      entry: enrichEntryForClient(finalEntry as LedgerEntryForErp),
      adjustment,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /unreconciled/:id/save-costs failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to save costs" });
  }
});

// ─── CF-ERP-EXPANSION-#7 Trades ────────────────────────────────────────────

router.post("/trades", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tradeDateRaw = typeof body.tradeDate === "string" && body.tradeDate.trim()
      ? body.tradeDate.trim()
      : new Date().toISOString();
    const tradeDate = new Date(tradeDateRaw);
    if (Number.isNaN(tradeDate.getTime())) {
      return res.status(400).json({ success: false, error: "tradeDate must be a valid ISO timestamp" });
    }
    const cashRaw = body.cashToMe;
    const cashToMe = typeof cashRaw === "number" && Number.isFinite(cashRaw) ? cashRaw : 0;
    const outgoingRaw = Array.isArray(body.outgoing) ? body.outgoing : null;
    if (!outgoingRaw || outgoingRaw.length === 0) {
      return res.status(400).json({ success: false, error: "outgoing[] is required (at least 1 card)" });
    }
    const incomingRaw = Array.isArray(body.incoming) ? body.incoming : [];

    const VALID_FMV_SOURCE: ReadonlySet<string> = new Set(["compiq", "manual"]);

    const outgoing = outgoingRaw.map((o: any) => {
      const fmvSource = String(o?.fmvSource ?? "");
      if (!VALID_FMV_SOURCE.has(fmvSource)) {
        throw new Error('outgoing.fmvSource must be "compiq" or "manual"');
      }
      return {
        holdingId: String(o.holdingId ?? ""),
        fmvAtTrade: Number(o.fmvAtTrade),
        fmvSource: fmvSource as "compiq" | "manual",
      };
    });
    const incoming = incomingRaw.map((i: any) => {
      const fmvSource = String(i?.fmvSource ?? "");
      if (!VALID_FMV_SOURCE.has(fmvSource)) {
        throw new Error('incoming.fmvSource must be "compiq" or "manual"');
      }
      return {
        cardId: typeof i.cardId === "string" ? i.cardId : undefined,
        cardTitle: String(i.cardTitle ?? "").trim(),
        grade: typeof i.grade === "string" ? i.grade : undefined,
        fmvAtTrade: Number(i.fmvAtTrade),
        fmvSource: fmvSource as "compiq" | "manual",
        playerName: typeof i.playerName === "string" ? i.playerName : undefined,
        cardYear: typeof i.cardYear === "number" ? i.cardYear : undefined,
        setName: typeof i.setName === "string" ? i.setName : undefined,
        parallel: typeof i.parallel === "string" ? i.parallel : undefined,
        gradeCompany: typeof i.gradeCompany === "string" ? i.gradeCompany : undefined,
        gradeValue: typeof i.gradeValue === "number" ? i.gradeValue : undefined,
      };
    });

    // Reuse sales-tracking validator for the trade-level optional channel +
    // location fields so iOS can post them with the same shape as a sale.
    const stParsed = parseSalesTrackingFields({
      salesChannel: body.salesChannel,
      saleLocation: body.saleLocation,
      paymentMethod: body.cashPaymentMethod,
    });
    if ("error" in stParsed) {
      return res.status(400).json({ success: false, error: stParsed.error });
    }

    const counterparty = typeof body.counterparty === "string" ? body.counterparty.trim().slice(0, 100) : undefined;
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : undefined;

    const result = await recordTradeTransaction({
      userId,
      tradeDate: tradeDate.toISOString(),
      counterparty: counterparty || undefined,
      salesChannel: stParsed.ok.salesChannel as SalesChannel | undefined,
      saleLocation: stParsed.ok.saleLocation as SaleLocation | undefined,
      cashToMe,
      cashPaymentMethod: stParsed.ok.paymentMethod as PaymentMethod | undefined,
      note: note || undefined,
      outgoing,
      incoming,
    });

    res.status(201).json({
      success: true,
      trade: result.trade,
      outgoingHoldingsRemoved: result.outgoingHoldingsRemoved,
      incomingHoldingsCreated: result.incomingHoldingsCreated,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /trades create failed:", err?.message ?? err);
    res.status(400).json({ success: false, error: err?.message ?? "Failed to record trade" });
  }
});

router.get("/trades", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const trades = await listTradesForUser(userId);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    let filtered = trades;
    if (from) filtered = filtered.filter((t) => t.tradeDate.slice(0, 10) >= from);
    if (to) filtered = filtered.filter((t) => t.tradeDate.slice(0, 10) <= to);
    res.json({ success: true, trades: filtered, count: filtered.length });
  } catch (err: any) {
    console.error("[portfolio.erp] /trades list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to list trades" });
  }
});

router.get("/trades/:id", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const tradeId = String(req.params.id ?? "").trim();
    if (!tradeId) return res.status(400).json({ success: false, error: "id is required" });
    const trade = await getTradeForUser(userId, tradeId);
    if (!trade) return res.status(404).json({ success: false, error: "Trade not found" });
    res.json({ success: true, trade });
  } catch (err: any) {
    console.error("[portfolio.erp] /trades/:id failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load trade" });
  }
});

// ─── CF-PURCHASE-LEDGER-FOUNDATION (2026-07-12) ───────────────────────────
//
// Buy-side counterpart to /trades + /pnl. Records acquisition events at
// the ORDER level (one purchase → N holdings via holdingIds attribution).
// See portfolioStore.service.ts PortfolioPurchaseEntry docstring for full
// data-model rationale.
//
//   GET  /erp/purchases?from=&to=&source=          list, filtered
//   GET  /erp/purchases/:id                        fetch one
//   POST /erp/purchases                            record a purchase
//   PATCH /erp/purchases/:id/link-holdings         append holdingIds

router.get("/purchases", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const rawSource = typeof req.query.source === "string" ? req.query.source.trim() : undefined;
    const source =
      rawSource === "manual" || rawSource === "ebay" ? rawSource : undefined;
    const purchases = await listPurchasesForUser(userId, { from, to, source });
    // Aggregate totals for the filtered window — cheap and useful for
    // any period-scoped iOS view.
    const totals = {
      count: purchases.length,
      subtotal: purchases.reduce((s, p) => s + (p.subtotal ?? 0), 0),
      tax: purchases.reduce((s, p) => s + (p.tax ?? 0), 0),
      shipping: purchases.reduce((s, p) => s + (p.shipping ?? 0), 0),
      otherFees: purchases.reduce((s, p) => s + (p.otherFees ?? 0), 0),
      totalCost: purchases.reduce((s, p) => s + (p.totalCost ?? 0), 0),
    };
    // Round for display cleanliness.
    totals.subtotal = Math.round(totals.subtotal * 100) / 100;
    totals.tax = Math.round(totals.tax * 100) / 100;
    totals.shipping = Math.round(totals.shipping * 100) / 100;
    totals.otherFees = Math.round(totals.otherFees * 100) / 100;
    totals.totalCost = Math.round(totals.totalCost * 100) / 100;
    res.json({
      success: true,
      window: { from: from ?? null, to: to ?? null },
      source: source ?? null,
      purchases,
      totals,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to list purchases" });
  }
});

router.get("/purchases/:id", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const purchaseId = String(req.params.id ?? "").trim();
    if (!purchaseId) return res.status(400).json({ success: false, error: "id is required" });
    const purchase = await getPurchaseForUser(userId, purchaseId);
    if (!purchase) return res.status(404).json({ success: false, error: "Purchase not found" });
    res.json({ success: true, purchase });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases/:id failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to load purchase" });
  }
});

router.post("/purchases", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    // ─── validation ─────────────────────────────────────────────────
    const purchaseDateRaw =
      typeof body.purchaseDate === "string" ? body.purchaseDate.trim() : "";
    if (!purchaseDateRaw) {
      return res.status(400).json({ success: false, error: "purchaseDate is required" });
    }
    const purchaseDateMs = Date.parse(purchaseDateRaw);
    if (!Number.isFinite(purchaseDateMs)) {
      return res.status(400).json({ success: false, error: "purchaseDate is not a valid ISO date" });
    }
    const source = body.source === "ebay" ? "ebay" : "manual";
    const toNum = (v: unknown, label: string): number => {
      if (v === undefined || v === null || v === "") return 0;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${label} must be a non-negative number`);
      }
      return n;
    };
    let subtotal: number;
    let tax: number;
    let shipping: number;
    let otherFees: number;
    try {
      subtotal = toNum(body.subtotal, "subtotal");
      tax = toNum(body.tax, "tax");
      shipping = toNum(body.shipping, "shipping");
      otherFees = toNum(body.otherFees, "otherFees");
    } catch (e: any) {
      return res.status(400).json({ success: false, error: e.message });
    }
    if (subtotal <= 0) {
      return res.status(400).json({ success: false, error: "subtotal must be > 0" });
    }
    const holdingIdsRaw = Array.isArray(body.holdingIds) ? body.holdingIds : [];
    const holdingIds = holdingIdsRaw
      .map((h) => (typeof h === "string" ? h.trim() : ""))
      .filter((h) => h.length > 0);
    const vendor =
      typeof body.vendor === "string" && body.vendor.trim() ? body.vendor.trim().slice(0, 200) : undefined;
    const invoiceRef =
      typeof body.invoiceRef === "string" && body.invoiceRef.trim() ? body.invoiceRef.trim().slice(0, 200) : undefined;
    const notes =
      typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 500) : undefined;
    const ebayOrderId =
      typeof body.ebayOrderId === "string" && body.ebayOrderId.trim()
        ? body.ebayOrderId.trim()
        : undefined;
    const ebayTransactionId =
      typeof body.ebayTransactionId === "string" && body.ebayTransactionId.trim()
        ? body.ebayTransactionId.trim()
        : undefined;

    const result = await recordPurchase(userId, {
      purchaseDate: new Date(purchaseDateMs).toISOString(),
      source,
      subtotal,
      tax,
      shipping,
      otherFees,
      holdingIds,
      vendor,
      invoiceRef,
      notes,
      ebayOrderId,
      ebayTransactionId,
    });
    // Idempotent replay for eBay imports returns 200 with existing entry;
    // fresh insert returns 201. Matches the /subscriptions/verify replay
    // idiom on the payments side.
    res.status(result.replay ? 200 : 201).json({
      success: true,
      purchase: result.entry,
      replay: result.replay,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases create failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: err?.message ?? "Failed to record purchase" });
  }
});

// CF-EBAY-BUYER-HISTORY (2026-07-12): pull purchase history from the legacy
// Trading API (GetMyeBayBuying) and idempotently import each item as a
// PortfolioPurchaseEntry. Configurable window; caps at MAX_DURATION_DAYS
// per eBay's server-side limit.
router.post("/purchases/import/ebay", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const daysRaw = req.body?.days ?? req.query.days;
    const days = Number(daysRaw ?? 30);
    if (!Number.isFinite(days) || days < 1) {
      return res.status(400).json({ success: false, error: "days must be a positive integer (1-90)" });
    }
    if (days > MAX_DURATION_DAYS) {
      return res.status(400).json({
        success: false,
        error: `days must be ≤ ${MAX_DURATION_DAYS} (eBay Trading API cap)`,
      });
    }
    const summary = await importEbayPurchaseHistory(userId, days);
    res.json({ success: true, ...summary });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases/import/ebay failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: err?.message ?? "Import failed" });
  }
});

// CF-EBAY-AUTO-HOLDING (2026-07-12): user-triggered one-shot to auto-attribute
// pre-existing eBay purchases whose holdingIds is still empty. Unlocks the 39
// (or however many) purchases already imported before the parser landed
// without requiring a re-sync from eBay.
//
// Response: { processed, holdingsCreated, holdingsNeedingReview, skipped }
// Idempotent — safe to re-run; purchases already linked to holdings are
// silently skipped.
router.post("/purchases/backfill-holdings", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const summary = await runAutoHoldingBatch(userId);
    // Route response uses the same field names the import endpoint returns
    // so iOS can share a decoder shape between the two calls.
    res.json({
      success: true,
      processed: summary.processed,
      holdingsCreated: summary.created,
      holdingsNeedingReview: summary.needsReview,
      skipped: summary.skipped,
    });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases/backfill-holdings failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: err?.message ?? "Backfill failed" });
  }
});

router.patch("/purchases/:id/link-holdings", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const purchaseId = String(req.params.id ?? "").trim();
    if (!purchaseId) return res.status(400).json({ success: false, error: "id is required" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const holdingIdsRaw = Array.isArray(body.holdingIds) ? body.holdingIds : [];
    const holdingIds = holdingIdsRaw
      .map((h) => (typeof h === "string" ? h.trim() : ""))
      .filter((h) => h.length > 0);
    if (holdingIds.length === 0) {
      return res.status(400).json({ success: false, error: "holdingIds must contain at least one non-empty string" });
    }
    const updated = await linkHoldingsToPurchase(userId, purchaseId, holdingIds);
    if (!updated) return res.status(404).json({ success: false, error: "Purchase not found" });
    res.json({ success: true, purchase: updated });
  } catch (err: any) {
    console.error("[portfolio.erp] /purchases/:id/link-holdings failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to link holdings" });
  }
});

router.get("/tax-export", async (req: Request, res: Response) => {
  try {
    const userId = userIdFrom(req);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const format =
      typeof req.query.format === "string" && req.query.format.toLowerCase() === "json"
        ? "json"
        : "csv";

    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const holdingsById = doc.holdings ?? {};
    const result = buildTaxExport(entries, holdingsById, { from, to });

    // Surface the exclusion count via response header on BOTH csv + json
    // so the iOS download flow can read it without parsing the body.
    res.setHeader("X-Unreconciled-Excluded", String(result.json.excluded.count));

    if (format === "json") {
      return res.json({ success: true, ...result.json });
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    const filenameWindow = [result.json.window.from, result.json.window.to]
      .filter(Boolean)
      .join("_to_");
    const filename = `hobbyiq-tax-export${filenameWindow ? "_" + filenameWindow : ""}.csv`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(result.csv);
  } catch (err: any) {
    console.error("[portfolio.erp] /tax-export failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to build tax export" });
  }
});

export default router;
