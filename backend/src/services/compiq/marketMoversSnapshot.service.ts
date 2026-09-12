// CF-MARKET-MOVERS-PERSISTED-SNAPSHOT (Fable, 2026-09-12).
//
// 2026-09-12 D1 (PR #2057) added an in-process, per-worker snapshot cache
// in front of the raw cross-partition scan. That does not survive the real
// deployment shape: HobbyIQ3 runs on 2 App Service instances and workers
// recycle every 8-19 minutes (see memory note "In-process schedulers never
// fired" — the same recycle cadence). So the FIRST viewer of any given
// query shape on ANY worker, after ANY recycle (roughly every 15 minutes,
// on one of two instances), still pays for a live scan — and the
// post-deploy Tier 1 harness run (prod sha 750c144) measured that scan at
// a full 25,000ms timeout under fleet load, not the quiet-pool 5s it was
// sized against.
//
// STRUCTURAL FIX: persist the computed snapshot to Cosmos, one document
// per query "shape" (sport, windowDays, direction, limit, minSales), in
// the EXISTING `daily_snapshots` container (partition key `/type`,
// already used by dailyPublish.service.ts for the twice-daily market/
// insights snapshot — same container, additive `type` value, no new
// container, no live-config change). A scheduled job (this module's
// `computeAndPersistMarketMoversSnapshot`, dispatched via the
// longJobTracker + poll-admin-job.cjs pattern from #2020/#2037 so it can
// outlive the App Service front end's 240s idle cut) computes each
// snapshot and writes it here on its own schedule, off any live request.
// The route then does ONE Cosmos point read (1 RU) and serves the stored
// snapshot with its computedAt, falling back to a live scan only when no
// snapshot exists yet for that shape (cold start / a shape nobody has
// asked for before).
//
// This module owns:
//   - the compute logic itself (lifted verbatim from marketMovers.routes.ts
//     D1 — same queries, same grouping, same credibility gate, byte-
//     identical results for the same inputs);
//   - the snapshot doc shape + read/write against daily_snapshots;
//   - the short list of shapes the scheduled job actually refreshes (every
//     shape the route's own defaults can produce, NOT a combinatorial
//     sweep of every sport × window × direction × limit × minSales — that
//     product is enormous and almost none of it is ever requested).
//
// The route (marketMovers.routes.ts) keeps its OWN in-process cache in
// front of the point read too (a 1-RU point read is cheap, but zero reads
// is cheaper, and the recycle-survival problem this module solves is
// orthogonal to per-instance micro-caching) — but the persisted snapshot,
// not the in-process cache, is what makes the answer available immediately
// after a worker recycle or on the OTHER instance.

import { CosmosClient, type Container } from "@azure/cosmos";
import { moverCredibility, looksDamaged } from "./moverCredibility.service.js";
import { cosmosOptionsFromConnectionString } from "../ops/cosmosConnectionPolicy.js";

export interface MarketMoversParams {
  sport: string;
  windowDays: number;
  direction: string;
  limit: number;
  minSales: number;
}

export interface Mover {
  cardId: string;
  playerName: string | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  cardYear: number | null;
  cardNumber: string | null;
  priorMedian: number;
  currentMedian: number;
  deltaPct: number;
  deltaUSD: number;
  salesInWindow: number;
  sampleImageUrl: string | null;
}

export interface MarketMoversResult {
  sport: string;
  windowDays: number;
  totalSkusInWindow: number;
  qualifyingMovers: number;
  damagedSkipped?: number;
  rejectedByCredibility?: Record<string, number>;
  returned: number;
  computedAt: string;
  source: "rollups" | "raw";
  movers: Mover[];
}

interface CompRow {
  cardId: string;
  playerName?: string | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  cardYear?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  price: number;
  soldAt: string;
  imageUrl?: string | null;
  title?: string | null;
}

interface DailyRow {
  cardId: string;
  sport: string | null;
  playerName: string | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  cardNumber: string | null;
  cardYear: number | null;
  day: string;
  count: number;
  median: number;
  min: number;
  max: number;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)];
}

function buildMoversFromDaily(
  groups: Map<string, { rows: DailyRow[]; sku: DailyRow }>,
  midpointDay: string,
  minSales: number,
): Mover[] {
  const movers: Mover[] = [];
  for (const [, g] of groups) {
    const totalSales = g.rows.reduce((s, r) => s + r.count, 0);
    if (totalSales < minSales) continue;
    const prior = g.rows.filter((r) => r.day < midpointDay);
    const current = g.rows.filter((r) => r.day >= midpointDay);
    if (prior.length === 0 || current.length === 0) continue;
    const priorSorted = prior.slice().sort((a, b) => a.median - b.median).map((r) => r.median);
    const currentSorted = current.slice().sort((a, b) => a.median - b.median).map((r) => r.median);
    const priorMedian = median(priorSorted);
    const currentMedian = median(currentSorted);
    if (priorMedian <= 0) continue;
    const deltaPct = Math.round(((currentMedian - priorMedian) / priorMedian) * 1000) / 10;
    const deltaUSD = Math.round((currentMedian - priorMedian) * 100) / 100;
    const verdict = moverCredibility({ priorMedian, currentMedian, deltaPct, deltaUSD, salesInWindow: totalSales });
    if (!verdict.ok) continue;
    movers.push({
      cardId: g.sku.cardId,
      playerName: g.sku.playerName,
      product: g.sku.product,
      parallel: g.sku.parallel,
      gradeCompany: g.sku.gradeCompany,
      gradeValue: g.sku.gradeValue,
      cardYear: g.sku.cardYear,
      cardNumber: g.sku.cardNumber,
      priorMedian: Math.round(priorMedian * 100) / 100,
      currentMedian: Math.round(currentMedian * 100) / 100,
      deltaPct,
      deltaUSD,
      salesInWindow: totalSales,
      sampleImageUrl: null,
    });
  }
  return movers;
}

function rankMovers(movers: Mover[], direction: string, limit: number): Mover[] {
  if (direction === "up") {
    return movers.filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, limit);
  }
  if (direction === "down") {
    return movers.filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, limit);
  }
  const up = movers.filter((m) => m.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, Math.ceil(limit / 2));
  const down = movers.filter((m) => m.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, Math.floor(limit / 2));
  return [...up, ...down];
}

let sharedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cosmosOptionsFromConnectionString(cs));
    sharedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedContainer;
  } catch { return null; }
}

let sharedDailyContainer: Container | null = null;
async function getDailyContainer(): Promise<Container | null> {
  if (sharedDailyContainer) return sharedDailyContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cosmosOptionsFromConnectionString(cs));
    sharedDailyContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("sold_comps_daily");
    return sharedDailyContainer;
  } catch { return null; }
}

/** The actual Cosmos-touching compute — rollups first (when sufficiently
 *  populated), raw scan otherwise. Byte-identical to D1's route-local
 *  version; only its home moved so a script can import it too. */
export async function computeMarketMovers(params: MarketMoversParams): Promise<MarketMoversResult | { unavailable: true }> {
  const { sport, windowDays, direction, limit, minSales } = params;
  const container = await getContainer();
  if (!container) return { unavailable: true };

  const nowMs = Date.now();
  const windowStart = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const midpoint = new Date(nowMs - (windowDays / 2) * 86_400_000).toISOString();
  const windowStartDay = windowStart.slice(0, 10);
  const midpointDay = midpoint.slice(0, 10);

  const useRollups = String(process.env.MARKET_MOVERS_USE_ROLLUPS ?? "").toLowerCase() === "true";
  const rollupMinSkus = Number(process.env.MARKET_MOVERS_ROLLUP_SUFFICIENCY_MIN ?? "50");
  let usedPath: "rollups" | "raw" = "raw";

  if (useRollups) {
    const daily = await getDailyContainer();
    if (daily) {
      const dailyIter = daily.items.query<DailyRow>({
        query: `SELECT c.cardId, c.sport, c.playerName, c.product, c.parallel,
                       c.gradeCompany, c.gradeValue, c.cardNumber, c.cardYear,
                       c.day, c.count, c.median, c.min, c.max
                FROM c
                WHERE c.sport = @sport
                  AND c.day >= @fromDay
                  AND c.median > 0`,
        parameters: [
          { name: "@sport", value: sport },
          { name: "@fromDay", value: windowStartDay },
        ],
      });
      const dailyRows: DailyRow[] = [];
      while (dailyIter.hasMoreResults()) {
        const { resources } = await dailyIter.fetchNext();
        dailyRows.push(...resources);
      }

      const groups = new Map<string, { rows: DailyRow[]; sku: DailyRow }>();
      for (const r of dailyRows) {
        const key = `${r.cardId}::${r.parallel ?? ""}::${r.gradeCompany ?? ""}::${r.gradeValue ?? ""}`;
        const g = groups.get(key);
        if (g) g.rows.push(r);
        else groups.set(key, { rows: [r], sku: r });
      }

      if (groups.size >= rollupMinSkus) {
        usedPath = "rollups";
        const movers = buildMoversFromDaily(groups, midpointDay, minSales);
        const result = rankMovers(movers, direction, limit);
        return {
          sport, windowDays,
          totalSkusInWindow: groups.size,
          qualifyingMovers: movers.length,
          returned: result.length,
          computedAt: new Date().toISOString(),
          source: usedPath,
          movers: result,
        };
      }
      console.log(JSON.stringify({
        event: "market_movers.rollup_insufficient",
        sport, skus: groups.size, threshold: rollupMinSkus,
        action: "fall_back_to_raw",
      }));
    }
  }

  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.playerName, c.setName, c.parallel, c.cardNumber,
                   c.cardYear, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.imageUrl,
                   c.title
            FROM c
            WHERE c.sport = @sport
              AND c.soldAt >= @from
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@from", value: windowStart },
    ],
  });

  const rows: CompRow[] = [];
  let damagedSkipped = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      if (looksDamaged(r.title)) { damagedSkipped++; continue; }
      rows.push(r);
    }
  }

  const groups = new Map<string, { rows: CompRow[]; sku: CompRow }>();
  for (const r of rows) {
    const key = `${r.cardId}::${r.parallel ?? ""}::${r.gradeCompany ?? ""}::${r.gradeValue ?? ""}`;
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { rows: [r], sku: r });
  }

  const movers: Mover[] = [];
  const rejected = new Map<string, number>();

  for (const [, g] of groups) {
    if (g.rows.length < minSales) continue;
    const prior = g.rows.filter((r) => r.soldAt < midpoint).map((r) => r.price);
    const current = g.rows.filter((r) => r.soldAt >= midpoint).map((r) => r.price);
    if (prior.length === 0 || current.length === 0) continue;
    const priorSorted = prior.slice().sort((a, b) => a - b);
    const currentSorted = current.slice().sort((a, b) => a - b);
    const priorMedian = median(priorSorted);
    const currentMedian = median(currentSorted);
    if (priorMedian <= 0) continue;
    const deltaPct = Math.round(((currentMedian - priorMedian) / priorMedian) * 1000) / 10;
    const deltaUSD = Math.round((currentMedian - priorMedian) * 100) / 100;

    const verdict = moverCredibility({ priorMedian, currentMedian, deltaPct, deltaUSD, salesInWindow: g.rows.length });
    if (!verdict.ok) { rejected.set(verdict.reason, (rejected.get(verdict.reason) ?? 0) + 1); continue; }

    const sampleImage = g.rows.find((r) => r.imageUrl)?.imageUrl ?? null;
    movers.push({
      cardId: g.sku.cardId,
      playerName: g.sku.playerName ?? null,
      product: g.sku.setName ?? null,
      parallel: g.sku.parallel ?? null,
      gradeCompany: g.sku.gradeCompany ?? null,
      gradeValue: g.sku.gradeValue ?? null,
      cardYear: g.sku.cardYear ?? null,
      cardNumber: g.sku.cardNumber ?? null,
      priorMedian: Math.round(priorMedian * 100) / 100,
      currentMedian: Math.round(currentMedian * 100) / 100,
      deltaPct,
      deltaUSD,
      salesInWindow: g.rows.length,
      sampleImageUrl: sampleImage,
    });
  }

  const result = rankMovers(movers, direction, limit);

  return {
    sport,
    windowDays,
    totalSkusInWindow: groups.size,
    qualifyingMovers: movers.length,
    damagedSkipped,
    rejectedByCredibility: Object.fromEntries([...rejected.entries()].sort((a, b) => b[1] - a[1])),
    returned: result.length,
    computedAt: new Date().toISOString(),
    source: "raw",
    movers: result,
  };
}

// ─── Persisted snapshot (daily_snapshots container) ───────────────────

export interface MarketMoversSnapshotDoc {
  id: string;
  /** Partition key. Distinct from dailyPublish's `type: "market"` doc —
   *  this is a different docType in the same container, never read by
   *  the editorial Market/Insights pages. */
  type: "market-movers";
  docType: "market_movers_snapshot";
  shape: MarketMoversParams;
  result: MarketMoversResult;
  computedAt: string;
}

function shapeKey(p: MarketMoversParams): string {
  return `${p.sport}::${p.windowDays}::${p.direction}::${p.limit}::${p.minSales}`;
}

/** Doc id convention: `market-movers::<shapeKey>`, matching the
 *  `<prefix>::<key>` scheme rematch_control uses for its own control
 *  markers, so a reader can tell every market-movers doc apart from the
 *  container's other docType (dailyPublish's single "market" doc) by id
 *  prefix alone — no scan, no schema coupling. */
function docIdFor(p: MarketMoversParams): string {
  return `market-movers::${shapeKey(p)}`;
}

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SNAPSHOT_CONTAINER_ID = process.env.COSMOS_DAILY_SNAPSHOTS_CONTAINER ?? "daily_snapshots";

let _snapshotContainer: Container | null = null;
async function getSnapshotContainer(): Promise<Container | null> {
  if (_snapshotContainer) return _snapshotContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cosmosOptionsFromConnectionString(cs));
    // CF-NO-CONTAINER-PROVISIONING (live-config HALT doctrine). Deliberately
    // `.container(id)`, never `createIfNotExists` — daily_snapshots already
    // exists in prod (dailyPublish.service.ts has written to it since
    // 2026-07-27). If it is ever missing, every read/write here fails open
    // (caught below) rather than silently provisioning a container, which
    // is a live-config change this fix does not get to make on its own.
    _snapshotContainer = client.database(DB_NAME).container(SNAPSHOT_CONTAINER_ID);
    return _snapshotContainer;
  } catch { return null; }
}

/** One Cosmos point read (1 RU on `/id` via `/type` partition). Null on a
 *  cold shape (nobody has ever computed+persisted it) or Cosmos trouble —
 *  both cases the caller treats identically: fall back to a live scan. */
export async function readMarketMoversSnapshot(params: MarketMoversParams): Promise<MarketMoversSnapshotDoc | null> {
  const container = await getSnapshotContainer();
  if (!container) return null;
  const id = docIdFor(params);
  try {
    const { resource } = await container.item(id, "market-movers").read<MarketMoversSnapshotDoc>();
    return resource ?? null;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    console.warn(JSON.stringify({
      event: "market_movers_snapshot.read_failed",
      id,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

async function writeMarketMoversSnapshot(params: MarketMoversParams, result: MarketMoversResult): Promise<boolean> {
  const container = await getSnapshotContainer();
  if (!container) return false;
  const doc: MarketMoversSnapshotDoc = {
    id: docIdFor(params),
    type: "market-movers",
    docType: "market_movers_snapshot",
    shape: params,
    result,
    computedAt: result.computedAt,
  };
  try {
    await container.items.upsert(doc);
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      event: "market_movers_snapshot.write_failed",
      id: doc.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return false;
  }
}

/** Compute one shape and persist it. Returns the result whether or not the
 *  persist succeeded — a caller that only wants a fresh number (e.g. the
 *  admin dispatch route reporting a summary) still gets one; the snapshot
 *  read path simply serves stale data one refresh cycle longer if a write
 *  transiently failed. */
export async function computeAndPersistMarketMoversSnapshot(
  params: MarketMoversParams,
): Promise<{ result: MarketMoversResult; persisted: boolean } | { unavailable: true }> {
  const computed = await computeMarketMovers(params);
  if ("unavailable" in computed) return computed;
  const persisted = await writeMarketMoversSnapshot(params, computed);
  return { result: computed, persisted };
}

// CF-SHAPE-COUNT-IS-BOUNDED (per research: sport × window × direction ×
// limit × minSales is combinatorially large — snapshotting the full
// product would mean thousands of docs and a scheduled job that never
// finishes). This is the actual, finite list the scheduled job refreshes:
// every (sport, window) pair the iOS app's default request shapes cover,
// each at direction="both" (the richest shape — up+down together), the
// route's own defaults for limit/minSales. A caller asking for a
// differently-shaped read (a custom limit, direction="up" alone, etc.)
// still gets a live compute on a cache/snapshot miss — this list only
// decides what the BACKGROUND job keeps warm, never what the route can
// answer.
export const SCHEDULED_SNAPSHOT_SPORTS = ["baseball", "football", "basketball", "hockey"] as const;
export const SCHEDULED_SNAPSHOT_WINDOWS = [7, 14, 30] as const;

export function scheduledSnapshotShapes(): MarketMoversParams[] {
  const shapes: MarketMoversParams[] = [];
  for (const sport of SCHEDULED_SNAPSHOT_SPORTS) {
    for (const windowDays of SCHEDULED_SNAPSHOT_WINDOWS) {
      shapes.push({ sport, windowDays, direction: "both", limit: 20, minSales: 3 });
    }
  }
  return shapes;
}

/** Refresh every scheduled shape, sequentially (never fan out N concurrent
 *  cross-partition scans against sold_comps — that is the exact mistake
 *  the ladder concurrency fix elsewhere in this PR had to walk back under
 *  fleet load). Returns a per-shape summary so the admin job's result can
 *  be inspected by the poller / workflow step. */
export async function refreshAllScheduledSnapshots(): Promise<{
  shapes: number;
  succeeded: number;
  failed: number;
  results: Array<{ shape: MarketMoversParams; ok: boolean; moversCount?: number; error?: string }>;
}> {
  const shapes = scheduledSnapshotShapes();
  const results: Array<{ shape: MarketMoversParams; ok: boolean; moversCount?: number; error?: string }> = [];
  for (const shape of shapes) {
    try {
      const outcome = await computeAndPersistMarketMoversSnapshot(shape);
      if ("unavailable" in outcome) {
        results.push({ shape, ok: false, error: "sold_comps container unavailable" });
        continue;
      }
      results.push({ shape, ok: outcome.persisted, moversCount: outcome.result.movers.length });
    } catch (err) {
      results.push({ shape, ok: false, error: (err as Error)?.message ?? String(err) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { shapes: shapes.length, succeeded, failed: shapes.length - succeeded, results };
}
