// CF-CATALOG-FIRST — product structure route (Drew, 2026-08-04).
//
// Serves the authoritative baseballcardpedia-derived product structure
// docs to iOS + web. Both clients drill down from a card search hit to
// "what does this product look like?" — the returned shape enumerates
// every parallel (with print run), insert subset, autograph subset,
// game-used relic, and gimmick.
//
// GET /api/catalog/product-structure/:productKey
//   :productKey is either the scraped page slug ("2024-bowman-chrome")
//   or a "year-setKey" combo ("2024-topps-chrome"). Both are stored in
//   card_catalog under id = "product-structure:{key}".
//
// GET /api/catalog/product-structure?year=2024&setKey=bowman-chrome
//   Falls back to a query when the caller doesn't have the productKey.
//   Returns the first match (there should be exactly one).
//
// GET /api/catalog/product-structure/list?year=2024[&brand=topps]
//   Enumerates every product-structure doc for a year (optionally
//   filtered to one brand). Used by the "Browse products for 2024"
//   landing on iOS/web.

import { Request, Response, Router } from "express";
import { CosmosClient, type Container } from "@azure/cosmos";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();
router.use(requireSession);

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("card_catalog");
    return _container;
  } catch { return null; }
}

// SHARED response shape. iOS + web both consume this — Swift Codable
// struct and TypeScript interface both mirror these field names
// verbatim. Keep them 1:1 or the clients break.
interface ProductStructureResponse {
  productKey: string;
  productName: string;
  sourcePage: string;
  year: number;
  sport: string;
  brand: string;
  setKey: string;
  parentSetKey: string | null;
  setName: string;
  parallels: Array<{ section: string; name: string; printRun: number | null }>;
  inserts: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  autos: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  gameUsed: Array<{ name: string; cardPrefix: string | null }>;
  gimmicks: Array<{ name: string; cardPrefix: string | null }>;
  parallelCount: number;
  insertCount: number;
  autoCount: number;
  gameUsedCount: number;
  gimmickCount: number;
  fetchedAt: string;
  lastImportedAt: string;
}

interface CatalogDoc extends Record<string, unknown> {
  id: string;
  productKey?: string;
  productName?: string;
  sourcePage?: string;
  year?: number;
  sport?: string;
  brand?: string;
  setKey?: string;
  parentSetKey?: string | null;
  setName?: string;
  parallels?: unknown;
  inserts?: unknown;
  autos?: unknown;
  gameUsed?: unknown;
  gimmicks?: unknown;
  parallelCount?: number;
  insertCount?: number;
  autoCount?: number;
  gameUsedCount?: number;
  gimmickCount?: number;
  fetchedAt?: string;
  lastImportedAt?: string;
}

function shape(doc: CatalogDoc): ProductStructureResponse {
  return {
    productKey: String(doc.productKey ?? doc.id ?? ""),
    productName: String(doc.productName ?? ""),
    sourcePage: String(doc.sourcePage ?? ""),
    year: Number(doc.year ?? 0),
    sport: String(doc.sport ?? "baseball"),
    brand: String(doc.brand ?? "other"),
    setKey: String(doc.setKey ?? ""),
    parentSetKey: doc.parentSetKey === undefined ? null : (doc.parentSetKey ?? null),
    setName: String(doc.setName ?? ""),
    parallels: Array.isArray(doc.parallels) ? (doc.parallels as ProductStructureResponse["parallels"]) : [],
    inserts: Array.isArray(doc.inserts) ? (doc.inserts as ProductStructureResponse["inserts"]) : [],
    autos: Array.isArray(doc.autos) ? (doc.autos as ProductStructureResponse["autos"]) : [],
    gameUsed: Array.isArray(doc.gameUsed) ? (doc.gameUsed as ProductStructureResponse["gameUsed"]) : [],
    gimmicks: Array.isArray(doc.gimmicks) ? (doc.gimmicks as ProductStructureResponse["gimmicks"]) : [],
    parallelCount: Number(doc.parallelCount ?? 0),
    insertCount: Number(doc.insertCount ?? 0),
    autoCount: Number(doc.autoCount ?? 0),
    gameUsedCount: Number(doc.gameUsedCount ?? 0),
    gimmickCount: Number(doc.gimmickCount ?? 0),
    fetchedAt: String(doc.fetchedAt ?? ""),
    lastImportedAt: String(doc.lastImportedAt ?? ""),
  };
}

router.get("/list", async (req: Request, res: Response) => {
  const year = typeof req.query.year === "string" ? Number(req.query.year) : NaN;
  const brand = typeof req.query.brand === "string" ? req.query.brand : null;
  if (!Number.isFinite(year)) {
    res.status(400).json({ success: false, error: "year is required" });
    return;
  }
  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }
  const pieces = ["c.source = 'bccp-product-structure'", "c.year = @year"];
  const params: Array<{ name: string; value: string | number }> = [{ name: "@year", value: year }];
  if (brand) { pieces.push("c.brand = @brand"); params.push({ name: "@brand", value: brand }); }
  try {
    const { resources } = await container.items.query<CatalogDoc>({
      query: `SELECT c.id, c.productKey, c.productName, c.sourcePage, c.year, c.sport, c.brand, c.setKey, c.parentSetKey, c.setName, c.parallelCount, c.insertCount, c.autoCount, c.gameUsedCount, c.gimmickCount FROM c WHERE ${pieces.join(" AND ")}`,
      parameters: params,
    }).fetchAll();
    // Return the lighter list shape (no full parallels arrays).
    const products = resources.map((d) => ({
      productKey: String(d.productKey ?? d.id ?? ""),
      productName: String(d.productName ?? ""),
      year: Number(d.year ?? 0),
      brand: String(d.brand ?? "other"),
      setKey: String(d.setKey ?? ""),
      parentSetKey: d.parentSetKey ?? null,
      setName: String(d.setName ?? ""),
      parallelCount: Number(d.parallelCount ?? 0),
      insertCount: Number(d.insertCount ?? 0),
      autoCount: Number(d.autoCount ?? 0),
      gameUsedCount: Number(d.gameUsedCount ?? 0),
      gimmickCount: Number(d.gimmickCount ?? 0),
    }));
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error)?.message ?? "list failed" });
  }
});

router.get("/:productKey", async (req: Request, res: Response) => {
  const productKey = String(req.params.productKey ?? "").trim();
  if (!productKey) { res.status(400).json({ success: false, error: "productKey required" }); return; }
  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }
  const id = productKey.startsWith("product-structure:") ? productKey : `product-structure:${productKey}`;
  try {
    const { resource } = await container.item(id, id).read<CatalogDoc>();
    if (!resource) { res.status(404).json({ success: false, error: "product not found" }); return; }
    res.json({ success: true, product: shape(resource) });
  } catch (err) {
    const status = (err as { code?: number })?.code === 404 ? 404 : 500;
    res.status(status).json({ success: false, error: (err as Error)?.message ?? "read failed" });
  }
});

router.get("/", async (req: Request, res: Response) => {
  const year = typeof req.query.year === "string" ? Number(req.query.year) : NaN;
  const setKey = typeof req.query.setKey === "string" ? req.query.setKey : null;
  if (!Number.isFinite(year) || !setKey) {
    res.status(400).json({ success: false, error: "year and setKey are required (use /product-structure/:productKey for direct lookup, /list?year= for enumeration)" });
    return;
  }
  const container = await getContainer();
  if (!container) { res.status(503).json({ success: false, error: "cosmos unavailable" }); return; }
  try {
    const { resources } = await container.items.query<CatalogDoc>({
      query: "SELECT TOP 1 * FROM c WHERE c.source = 'bccp-product-structure' AND c.year = @year AND c.setKey = @setKey",
      parameters: [{ name: "@year", value: year }, { name: "@setKey", value: setKey }],
    }).fetchAll();
    if (!resources[0]) { res.status(404).json({ success: false, error: "product not found" }); return; }
    res.json({ success: true, product: shape(resources[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error)?.message ?? "query failed" });
  }
});

export default router;
