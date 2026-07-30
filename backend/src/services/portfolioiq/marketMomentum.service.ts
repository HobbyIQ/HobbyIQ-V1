// CF-MARKET-MOMENTUM (Drew, 2026-07-30). Reader/writer for the
// `market_signals` container. Two document classes:
//
//  1. Momentum signals — daily-refreshed volume + price momentum per
//     (dimension, key) tuple. TTL 8 days so we always have yesterday
//     available for comparison.
//
//  2. Calibration multipliers — weekly-refreshed per-axis premium
//     multipliers (color ladder, edition premium, finish premium,
//     autoStyle premium). Consumed by hobbyIqFmv to adjust the
//     projected-next-sale trend fit. TTL 14 days.
//
// Consumers read via getSignal / getCalibration; missing data is
// silent-safe (returns null, never throws) so the FMV pipeline never
// breaks when momentum data is stale or the container is empty.
//
// Cosmos partition: /dimension so a single dimension read (e.g.
// "all color-family momentum for today") is a same-partition query.

import { CosmosClient, type Container } from "@azure/cosmos";

export type MomentumDimension =
  | "colorFamily"
  | "edition"
  | "finishModifier"
  | "insertSet"
  | "autoStyle"
  | "gradeTier"
  | "sport"
  | "productLine"
  | "isAuto";

export type CalibrationDimension =
  | "colorLadderMultiplier"
  | "editionPremium"
  | "finishPremium"
  | "autoStylePremium"
  | "gradeTierMultiplier";

/** One-day rolling momentum snapshot for a (dimension, key) tuple. */
export interface MomentumSignalDoc {
  id: string;                              // ${dimension}::${key}::${dateISO}
  dimension: MomentumDimension;            // partition
  key: string;                              // "GOLD", "SAPPHIRE", "WAVE", "scouts-top-100"
  windowDays: number;                       // typically 30
  computedAt: string;                        // ISO
  metrics: {
    currVolume: number;
    priorVolume: number;
    volumeMomentum: number | null;           // (curr/prior) - 1
    currMedian: number | null;
    priorMedian: number | null;
    priceMomentum: number | null;            // (currMedian/priorMedian) - 1
    sampleSize: number;                      // curr + prior
  };
  ttl?: number;                              // Cosmos TTL seconds
}

/** Per-axis calibration multipliers refreshed on a weekly cadence. */
export interface CalibrationDoc {
  id: string;                                // ${dimension}::${scope}::${dateISO}
  dimension: CalibrationDimension;           // partition
  scope: string;                              // e.g. "bowman-chrome" for colorLadder, "global" for autoStyle
  windowDays: number;                         // typically 90
  computedAt: string;                          // ISO
  multipliers: Record<string, number>;         // { "BASE": 1.00, "REFRACTOR": 1.30, "BLUE": 2.15, ... }
  sampleSize: number;
  confidence: "verified" | "probable" | "unverified";
  ttl?: number;
}

let _cached: Container | null = null;
const CONTAINER_NAME = process.env.MARKET_SIGNALS_CONTAINER ?? "market_signals";
const MOMENTUM_TTL_SEC = 60 * 60 * 24 * 8;         // 8 days
const CALIBRATION_TTL_SEC = 60 * 60 * 24 * 14;      // 14 days

async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const { container } = await db.containers.createIfNotExists(
      { id: CONTAINER_NAME, partitionKey: "/dimension", defaultTtl: -1 },
      { offerThroughput: 400 },
    );
    _cached = container;
    return container;
  } catch {
    return null;
  }
}

// ─── Momentum writers/readers ────────────────────────────────────────

/** Upsert a momentum signal. Idempotent — same id overwrites. */
export async function upsertMomentumSignal(doc: Omit<MomentumSignalDoc, "id" | "ttl">): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const dateKey = doc.computedAt.slice(0, 10);
  const id = `${doc.dimension}::${slug(doc.key)}::${dateKey}`;
  try {
    await c.items.upsert({ ...doc, id, ttl: MOMENTUM_TTL_SEC });
  } catch { /* silent-safe */ }
}

/** Read the latest momentum signal for (dimension, key). Returns null
 *  when the container is empty or the tuple has no data. */
export async function getLatestMomentum(dimension: MomentumDimension, key: string): Promise<MomentumSignalDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resources } = await c.items.query<MomentumSignalDoc>({
      query: "SELECT TOP 1 * FROM c WHERE c.dimension = @d AND c.key = @k ORDER BY c.computedAt DESC",
      parameters: [{ name: "@d", value: dimension }, { name: "@k", value: key }],
    }, { partitionKey: dimension }).fetchAll();
    return resources[0] ?? null;
  } catch { return null; }
}

/** Read every momentum signal for one dimension on one date (or the
 *  most-recent date when `date` is omitted). Useful for building the
 *  "market pulse" surface. */
export async function getAllMomentumForDimension(
  dimension: MomentumDimension,
  date?: string,
): Promise<MomentumSignalDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  try {
    let query = "SELECT * FROM c WHERE c.dimension = @d";
    const params: Array<{ name: string; value: string }> = [{ name: "@d", value: dimension }];
    if (date) {
      query += " AND STARTSWITH(c.computedAt, @dt)";
      params.push({ name: "@dt", value: date });
    }
    query += " ORDER BY c.computedAt DESC";
    const { resources } = await c.items.query<MomentumSignalDoc>({ query, parameters: params }, { partitionKey: dimension }).fetchAll();
    if (!date) {
      // Filter to only the latest date's rows (which is the first date in
      // DESC order; keep the latest per key).
      const seen = new Set<string>();
      return resources.filter(r => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
      });
    }
    return resources;
  } catch { return []; }
}

// ─── Calibration writers/readers ─────────────────────────────────────

/** Upsert a calibration multiplier snapshot. */
export async function upsertCalibration(doc: Omit<CalibrationDoc, "id" | "ttl">): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const dateKey = doc.computedAt.slice(0, 10);
  const id = `${doc.dimension}::${slug(doc.scope)}::${dateKey}`;
  try {
    await c.items.upsert({ ...doc, id, ttl: CALIBRATION_TTL_SEC });
  } catch { /* silent-safe */ }
}

/** Read the latest calibration for (dimension, scope). Callers use
 *  the returned multipliers when computing per-axis FMV adjustments.
 *  Returns null when the container is empty or the scope has no data. */
export async function getLatestCalibration(dimension: CalibrationDimension, scope: string): Promise<CalibrationDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resources } = await c.items.query<CalibrationDoc>({
      query: "SELECT TOP 1 * FROM c WHERE c.dimension = @d AND c.scope = @s ORDER BY c.computedAt DESC",
      parameters: [{ name: "@d", value: dimension }, { name: "@s", value: scope }],
    }, { partitionKey: dimension }).fetchAll();
    return resources[0] ?? null;
  } catch { return null; }
}

// ─── FMV helper: compute the total multi-axis multiplier for a target ──

export interface AxisAdjustmentInput {
  productLine?: string | null;
  colorFamily?: string | null;
  edition?: string | null;
  finishModifier?: string | null;
  autoStyle?: "on-card" | "sticker" | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}

/** Reads the latest calibration multipliers for each present axis and
 *  returns the compound adjustment factor. Missing calibrations
 *  default to 1.0 (no adjustment). Callers multiply the base
 *  projected-next-sale by the returned factor. */
export async function computeAxisAdjustment(input: AxisAdjustmentInput): Promise<{ factor: number; breakdown: Record<string, number> }> {
  const breakdown: Record<string, number> = {};

  // Color ladder is per-product; keyed by (productLine, colorFamily).
  if (input.productLine && input.colorFamily) {
    const cal = await getLatestCalibration("colorLadderMultiplier", input.productLine);
    const m = cal?.multipliers?.[input.colorFamily];
    if (typeof m === "number" && m > 0) breakdown.colorLadder = m;
  }
  if (input.edition) {
    const cal = await getLatestCalibration("editionPremium", "global");
    const m = cal?.multipliers?.[input.edition];
    if (typeof m === "number" && m > 0) breakdown.editionPremium = m;
  }
  if (input.finishModifier) {
    const cal = await getLatestCalibration("finishPremium", "global");
    const m = cal?.multipliers?.[input.finishModifier];
    if (typeof m === "number" && m > 0) breakdown.finishPremium = m;
  }
  if (input.autoStyle) {
    const cal = await getLatestCalibration("autoStylePremium", "global");
    const m = cal?.multipliers?.[input.autoStyle];
    if (typeof m === "number" && m > 0) breakdown.autoStylePremium = m;
  }
  if (input.gradeCompany && input.gradeValue != null) {
    const cal = await getLatestCalibration("gradeTierMultiplier", "global");
    const k = `${input.gradeCompany.toUpperCase()}_${input.gradeValue}`;
    const m = cal?.multipliers?.[k];
    if (typeof m === "number" && m > 0) breakdown.gradeTier = m;
  }

  const factor = Object.values(breakdown).reduce((acc, v) => acc * v, 1);
  return { factor, breakdown };
}

// ─── Internal helpers ─────────────────────────────────────────────────

function slug(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function __resetContainerForTests(): void {
  _cached = null;
}
