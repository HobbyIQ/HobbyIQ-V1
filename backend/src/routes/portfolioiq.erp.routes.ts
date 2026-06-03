// CF-ERP-RECONCILIATION (2026-06-03): pro_seller ERP layer routes.
//
//   GET  /api/portfolio/erp/unreconciled
//   GET  /api/portfolio/erp/pnl?from=&to=&groupBy=month|player|set|grade|source
//   GET  /api/portfolio/erp/tax-export?from=&to=&format=csv|json
//
// All routes: requireSession → requireEntitlement("erpReconciliation").
// NO cap. Reads only the user's own ledger via readUserDoc — no upstream,
// no Cardsight.

import { Router, Request, Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { readUserDoc } from "../services/portfolioiq/portfolioStore.service.js";
import {
  aggregatePnl,
  buildTaxExport,
  listUnreconciled,
  VALID_GROUP_BY,
  type LedgerEntryForErp,
  type PnlGroupBy,
} from "../services/portfolioiq/erpReconciliation.service.js";

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

    const doc = await readUserDoc(userId);
    const entries = (doc.ledger ?? []) as unknown as LedgerEntryForErp[];
    const holdingsById = doc.holdings ?? {};
    const result = aggregatePnl(entries, holdingsById, { from, to, groupBy });
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[portfolio.erp] /pnl failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Failed to aggregate P&L" });
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
