// CF-CATALOG-FIRST — price-anomaly verify queue (Drew, 2026-08-04).
//
// "If price doesn't match we will throw into a verification. I will
//  then reapply these cards to the correct catalog card."
//
// Endpoints (all bearer-admin gated):
//   GET  /api/verify/comps
//     List flagged comps (priceAnomaly=true) with expected vs actual.
//     Query: ?limit=25&reason=price-too-low|price-too-high&year=YYYY&sport=baseball
//
//   POST /api/verify/comps/:id/reassign
//     Body: { cardId, hobbyiqCardId?, partitionKey? }
//     Moves a comp to a different catalog entry. Clears priceAnomaly.
//
//   POST /api/verify/comps/:id/confirm
//     Body: { partitionKey }
//     Marks the anomaly as verified-real (rare-card / one-off sale).
//     Clears priceAnomaly, keeps the comp under its current slug.

import { Request, Response, Router } from "express";
import { CosmosClient, type Container } from "@azure/cosmos";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
router.use(requireAdmin);

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("sold_comps");
    return _container;
  } catch { return null; }
}

router.get("/comps", async (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const reason = typeof req.query.reason === "string" ? req.query.reason : null;
  const year = typeof req.query.year === "string" ? Number(req.query.year) : null;
  const sport = typeof req.query.sport === "string" ? req.query.sport : null;

  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }

  const wherePieces: string[] = ["c.priceAnomaly = true"];
  const params: Array<{ name: string; value: string | number }> = [];
  if (reason) { wherePieces.push("c.priceAnomalyReason = @reason"); params.push({ name: "@reason", value: reason }); }
  if (year && Number.isFinite(year)) { wherePieces.push("c.cardYear = @year"); params.push({ name: "@year", value: year }); }
  if (sport) { wherePieces.push("c.sport = @sport"); params.push({ name: "@sport", value: sport }); }

  try {
    const { resources } = await container.items.query({
      query: `SELECT TOP ${limit} c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.title, c.source, c.priceAnomalyReason, c.priceAnomalyMeta FROM c WHERE ${wherePieces.join(" AND ")} ORDER BY c.soldAt DESC`,
      parameters: params,
    }).fetchAll();
    res.json({ success: true, hits: resources, count: resources.length });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error)?.message ?? "query failed" });
  }
});

router.post("/comps/:id/reassign", async (req: Request, res: Response) => {
  const compId = String(req.params.id ?? "").trim();
  const body = (req.body ?? {}) as { cardId?: unknown; hobbyiqCardId?: unknown; partitionKey?: unknown };
  const newCardId = typeof body.cardId === "string" ? body.cardId : null;
  const newHobbyiqCardId = typeof body.hobbyiqCardId === "string" ? body.hobbyiqCardId : null;
  const partitionKey = typeof body.partitionKey === "string" ? body.partitionKey : null;
  if (!compId || !newCardId) {
    res.status(400).json({ success: false, error: "id + cardId required" });
    return;
  }
  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }

  try {
    // Comp's partition is its OLD cardId. Caller MUST send that as partitionKey
    // for us to find the row before we rewrite cardId. Without it we don't know
    // where to look (sold_comps partitions on /cardId).
    const pk = partitionKey ?? newCardId;
    await container.item(compId, pk).patch([
      { op: "set", path: "/cardId", value: newCardId },
      { op: "set", path: "/hobbyiqCardId", value: newHobbyiqCardId ?? newCardId },
      { op: "set", path: "/priceAnomaly", value: false },
      { op: "set", path: "/priceAnomalyReason", value: "reassigned-by-admin" },
      { op: "set", path: "/reassignedAt", value: new Date().toISOString() },
    ]);
    res.json({ success: true, id: compId, cardId: newCardId });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error)?.message ?? "patch failed" });
  }
});

router.post("/comps/:id/confirm", async (req: Request, res: Response) => {
  const compId = String(req.params.id ?? "").trim();
  const body = (req.body ?? {}) as { partitionKey?: unknown };
  const partitionKey = typeof body.partitionKey === "string" ? body.partitionKey : null;
  if (!compId || !partitionKey) {
    res.status(400).json({ success: false, error: "id + partitionKey required" });
    return;
  }
  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }

  try {
    await container.item(compId, partitionKey).patch([
      { op: "set", path: "/priceAnomaly", value: false },
      { op: "set", path: "/priceAnomalyReason", value: "confirmed-real-by-admin" },
      { op: "set", path: "/confirmedAt", value: new Date().toISOString() },
    ]);
    res.json({ success: true, id: compId });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error)?.message ?? "patch failed" });
  }
});

export default router;
